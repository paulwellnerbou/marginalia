import { Box, Code, Flex, Text } from '@radix-ui/themes';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { formatAnchorQuote } from '../lib/anchor-quote.js';
import {
  type Comment,
  getHistory,
  getHistoryDiff,
  type HistoryEntry,
  type Thread,
  type ThreadResolution,
} from '../lib/api.js';
import { formatTimestamp, formatTimestampLong } from '../lib/format-time.js';
import { describeEntry, historyActorLabel, shortOid } from '../lib/history-format.js';
import { reportError } from '../lib/log.js';
import { DiffDialog } from './DiffDialog.js';
import { InlineAvatar } from './inline-comments/InlineAvatar.js';
import { ShowDiffButton } from './ShowDiffButton.js';

function buildRowProps(
  targetId: string | undefined,
  onOpenThread: ((id: string) => void) | undefined,
  borderStyle: string | undefined,
) {
  if (!targetId || !onOpenThread) {
    return {
      style: { borderBottom: borderStyle },
    };
  }
  const open = () => onOpenThread(targetId);
  return {
    onClick: open,
    onKeyDown: (e: KeyboardEvent) => {
      // Ignore keydown bubbling up from inner controls (e.g. ShowDiffButton),
      // so Enter/Space activates the inner control instead of opening the row.
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    },
    role: 'button' as const,
    tabIndex: 0,
    style: { cursor: 'pointer', borderBottom: borderStyle },
  };
}

interface SelectedDiff {
  oid: string;
  title: string;
  before: string;
  after: string;
}

export type Activity =
  | { kind: 'history'; timestamp: number; id: string; entry: HistoryEntry }
  | { kind: 'thread'; timestamp: number; id: string; thread: Thread }
  | { kind: 'reply'; timestamp: number; id: string; thread: Thread; comment: Comment }
  | {
      kind: 'resolution';
      timestamp: number;
      id: string;
      thread: Thread;
      resolution: ThreadResolution;
    };

interface Props {
  uid: string;
  version: number;
  threads: Thread[];
  onOpenThread?: (threadId: string) => void;
}

export function ActivityList({ uid, version, threads, onOpenThread }: Props) {
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [loadingDiffOid, setLoadingDiffOid] = useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<SelectedDiff | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const diffRequestToken = useRef(0);

  useEffect(() => {
    let cancelled = false;
    setHistoryEntries(null);
    setLoadError(null);
    setDiffError(null);
    getHistory(uid).then(
      (r) => {
        if (!cancelled) setHistoryEntries(r.history);
      },
      (err) => {
        if (cancelled) return;
        reportError('ActivityList.loadHistory', err, { uid });
        setLoadError('Could not load history');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [uid, version]);

  useEffect(() => {
    diffRequestToken.current += 1;
    setLoadingDiffOid(null);
    setSelectedDiff(null);
    setDiffOpen(false);
    setDiffError(null);
  }, [uid]);

  const activities = useMemo(() => {
    if (!historyEntries) return [];

    const items: Activity[] = [];
    const historyAcceptedProposalIds = new Set<string>();

    for (const entry of historyEntries) {
      items.push({ kind: 'history', timestamp: entry.timestamp, id: `hist-${entry.oid}`, entry });
      if (entry.action === 'accept-proposal' && entry.proposal) {
        historyAcceptedProposalIds.add(entry.proposal.id);
      }
    }

    for (const thread of threads) {
      items.push({
        kind: 'thread',
        timestamp: thread.comments[0].created_at,
        id: `thread-${thread.id}`,
        thread,
      });
      for (let i = 1; i < thread.comments.length; i++) {
        const comment = thread.comments[i]!;
        items.push({
          kind: 'reply',
          timestamp: comment.created_at,
          id: `reply-${comment.id}`,
          thread,
          comment,
        });
      }

      if (thread.resolution) {
        // Deduplicate accepted proposal resolutions if a history entry exists
        if (thread.resolution.kind === 'accept' && historyAcceptedProposalIds.has(thread.id)) {
          continue;
        }
        items.push({
          kind: 'resolution',
          timestamp: thread.resolution.at,
          id: `res-${thread.id}-${thread.resolution.at}`,
          thread,
          resolution: thread.resolution,
        });
      }
    }

    items.sort((a, b) => b.timestamp - a.timestamp);
    return items;
  }, [historyEntries, threads]);

  async function handleShowDiff(entry: HistoryEntry): Promise<void> {
    if (loadingDiffOid) return;

    const requestToken = diffRequestToken.current + 1;
    diffRequestToken.current = requestToken;
    setDiffError(null);
    setLoadingDiffOid(entry.oid);
    try {
      const diff = await getHistoryDiff(uid, entry.oid);
      if (diffRequestToken.current !== requestToken) return;
      setSelectedDiff({
        oid: entry.oid,
        title: `${describeEntry(entry)} · ${shortOid(entry.oid)}`,
        before: diff.before,
        after: diff.after,
      });
      setDiffOpen(true);
    } catch (err) {
      if (diffRequestToken.current !== requestToken) return;
      reportError('ActivityList.loadDiff', err, { uid, oid: entry.oid });
      setDiffError('Could not load diff');
    } finally {
      if (diffRequestToken.current === requestToken) {
        setLoadingDiffOid(null);
      }
    }
  }

  if (loadError)
    return (
      <Box p="3">
        <Text size="1" color="red">
          {loadError}
        </Text>
      </Box>
    );
  if (!historyEntries)
    return (
      <Box p="3">
        <Text size="1" color="gray">
          Loading…
        </Text>
      </Box>
    );
  if (activities.length === 0) {
    return (
      <Box p="3">
        <Text size="1" color="gray">
          No activity yet.
        </Text>
      </Box>
    );
  }

  return (
    <>
      <Box p="3" className="history-list">
        {diffError ? (
          <Box pb="2">
            <Text size="1" color="red">
              {diffError}
            </Text>
          </Box>
        ) : null}
        {activities.map((activity, index) => {
          const isLast = index === activities.length - 1;
          const borderStyle = isLast ? undefined : '1px solid var(--gray-a4)';

          if (activity.kind === 'history') {
            const { entry } = activity;
            const actorName = historyActorLabel(entry.actor.display_name, entry.actor.client_id);
            const proposal = entry.proposal;
            const proposalAuthor = proposal
              ? historyActorLabel(proposal.author.display_name, proposal.author.client_id)
              : 'Unknown user';

            return (
              <Flex
                key={activity.id}
                direction="column"
                gap="2"
                pb="4"
                mb="4"
                className="history-entry"
                {...buildRowProps(proposal?.id, onOpenThread, borderStyle)}
              >
                <Flex align="start" gap="3" justify="between">
                  <Flex align="start" gap="2" style={{ flex: 1, minWidth: 0 }}>
                    <Box style={{ flexShrink: 0, marginTop: '2px' }}>
                      <InlineAvatar
                        name={actorName}
                        seed={entry.actor.client_id || actorName}
                        size="md"
                      />
                    </Box>
                    <Box style={{ flex: 1, minWidth: 0 }}>
                      <Flex align="baseline" gap="2" wrap="wrap">
                        <Text size="2" weight="medium">
                          {actorName}
                        </Text>
                        <Text size="1" color="gray" title={formatTimestampLong(entry.timestamp)}>
                          {formatTimestamp(entry.timestamp)}
                        </Text>
                      </Flex>
                      <Text size="1" color="gray">
                        {describeEntry(entry)} <Code size="1">{shortOid(entry.oid)}</Code>
                      </Text>
                      {proposal ? (
                        <Flex direction="column" gap="1" mt="2">
                          <Text size="1" color="gray">
                            Proposal by {proposalAuthor}
                          </Text>
                          <Text size="1">“{proposal.summary}”</Text>
                        </Flex>
                      ) : null}
                      {entry.restored_from_oid ? (
                        <Text size="1" color="gray" mt="2">
                          Restored from <Code size="1">{shortOid(entry.restored_from_oid)}</Code>
                        </Text>
                      ) : null}
                    </Box>
                  </Flex>
                  <Box onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
                    <ShowDiffButton
                      onClick={() => void handleShowDiff(entry)}
                      disabled={loadingDiffOid !== null}
                      loading={loadingDiffOid === entry.oid}
                    />
                  </Box>
                </Flex>
              </Flex>
            );
          }

          if (activity.kind === 'thread') {
            const { thread } = activity;
            const isProposal = thread.proposal !== null;
            const comment = thread.comments[0];
            const actionText = isProposal ? 'Proposed a change' : 'Started a thread';
            const quoteText = formatAnchorQuote(thread.anchor.quote, 180);

            return (
              <Flex
                key={activity.id}
                direction="column"
                gap="2"
                pb="4"
                mb="4"
                className="history-entry"
                {...buildRowProps(thread.id, onOpenThread, borderStyle)}
              >
                <Flex align="start" gap="3">
                  <Box style={{ flexShrink: 0, marginTop: '2px' }}>
                    <InlineAvatar
                      name={comment.author.display_name}
                      seed={comment.author.client_id}
                      size="md"
                    />
                  </Box>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Flex align="baseline" gap="2" wrap="wrap">
                      <Text size="2" weight="medium">
                        {comment.author.display_name}
                      </Text>
                      <Text size="1" color="gray" title={formatTimestampLong(activity.timestamp)}>
                        {formatTimestamp(activity.timestamp)}
                      </Text>
                    </Flex>
                    <Text size="1" color="gray">
                      {actionText}
                    </Text>
                    {quoteText ? (
                      <Text
                        size="1"
                        color="gray"
                        mt="1"
                        as="p"
                        style={{
                          borderLeft: '2px solid var(--gray-a4)',
                          paddingLeft: '8px',
                          fontStyle: 'italic',
                        }}
                      >
                        "{quoteText}"
                      </Text>
                    ) : null}
                  </Box>
                </Flex>
              </Flex>
            );
          }

          if (activity.kind === 'reply') {
            const { thread, comment } = activity;
            const isProposal = thread.proposal !== null;
            const threadAuthorName = thread.comments[0].author.display_name || 'someone';

            return (
              <Flex
                key={activity.id}
                direction="column"
                gap="2"
                pb="4"
                mb="4"
                className="history-entry"
                {...buildRowProps(thread.id, onOpenThread, borderStyle)}
              >
                <Flex align="start" gap="3">
                  <Box style={{ flexShrink: 0, marginTop: '2px' }}>
                    <InlineAvatar
                      name={comment.author.display_name}
                      seed={comment.author.client_id}
                      size="md"
                    />
                  </Box>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Flex align="baseline" gap="2" wrap="wrap">
                      <Text size="2" weight="medium">
                        {comment.author.display_name}
                      </Text>
                      <Text size="1" color="gray" title={formatTimestampLong(activity.timestamp)}>
                        {formatTimestamp(activity.timestamp)}
                      </Text>
                    </Flex>
                    <Text size="1" color="gray">
                      Replied to {isProposal ? 'proposal' : 'thread'} by {threadAuthorName}
                    </Text>
                  </Box>
                </Flex>
              </Flex>
            );
          }

          if (activity.kind === 'resolution') {
            const { thread, resolution } = activity;
            let text = 'Resolved thread';
            if (resolution.kind === 'accept') text = 'Accepted proposal';
            if (resolution.kind === 'reject') text = 'Rejected proposal';

            const name = resolution.by_name || 'Unknown';

            return (
              <Flex
                key={activity.id}
                direction="column"
                gap="2"
                pb="4"
                mb="4"
                className="history-entry"
                {...buildRowProps(thread.id, onOpenThread, borderStyle)}
              >
                <Flex align="start" gap="3">
                  <Box style={{ flexShrink: 0, marginTop: '2px' }}>
                    <InlineAvatar name={name} seed={name} size="md" />
                  </Box>
                  <Box style={{ flex: 1, minWidth: 0 }}>
                    <Flex align="baseline" gap="2" wrap="wrap">
                      <Text size="2" weight="medium">
                        {name}
                      </Text>
                      <Text size="1" color="gray" title={formatTimestampLong(activity.timestamp)}>
                        {formatTimestamp(activity.timestamp)}
                      </Text>
                    </Flex>
                    <Text size="1" color="gray">
                      {text}
                    </Text>
                  </Box>
                </Flex>
              </Flex>
            );
          }

          return null;
        })}
      </Box>

      <DiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        title={selectedDiff?.title ?? 'Revision diff'}
        before={selectedDiff?.before ?? ''}
        after={selectedDiff?.after ?? ''}
      />
    </>
  );
}
