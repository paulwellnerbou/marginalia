import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Code, Flex, Modal, Text } from '@mantine/core';
import { getDocument, getHistory, getHistoryDiff, type HistoryEntry } from '../lib/api.js';
import { reportError } from '../lib/log.js';
import { DiffDialog } from './DiffDialog.js';
import { ShowDiffButton } from './ShowDiffButton.js';

interface SelectedDiff {
  oid: string;
  title: string;
  before: string;
  after: string;
}

interface Props {
  uid: string;
  version: number;
  canRestore?: boolean;
  onRestoreVersion?: (oid: string) => Promise<void>;
  onRevertLatest?: (entry: HistoryEntry) => Promise<void>;
  onRestoreAsNewDocument?: (oid: string) => Promise<void>;
  onOpenThread?: (threadId: string) => void;
}

/**
 * Right-pane view of the document's git log. Loads on mount; re-renders
 * when the `version` prop increments (bumped on document.updated events).
 */
export function HistoryList({
  uid,
  version,
  canRestore = false,
  onRestoreVersion,
  onRevertLatest,
  onRestoreAsNewDocument,
  onOpenThread,
}: Props) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [loadingDiffOid, setLoadingDiffOid] = useState<string | null>(null);
  const [restoringOid, setRestoringOid] = useState<string | null>(null);
  const [openingNewDocumentOid, setOpeningNewDocumentOid] = useState<string | null>(null);
  const [selectedDiff, setSelectedDiff] = useState<SelectedDiff | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [restoreTarget, setRestoreTarget] = useState<HistoryEntry | null>(null);
  const diffRequestToken = useRef(0);
  const currentOid = entries?.[0]?.oid ?? null;

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setDiffError(null);
    setRestoreError(null);
    getHistory(uid).then(
      (r) => {
        if (!cancelled) setEntries(r.history);
      },
      (err) => {
        if (cancelled) return;
        reportError('HistoryList.load', err, { uid });
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
    setRestoringOid(null);
    setOpeningNewDocumentOid(null);
    setSelectedDiff(null);
    setDiffOpen(false);
    setDiffError(null);
    setRestoreError(null);
    setRestoreTarget(null);
  }, [uid]);

  const displayedEntries = useMemo(() => entries ?? [], [entries]);

  async function handleShowDiff(entry: HistoryEntry): Promise<void> {
    if (loadingDiffOid || restoringOid || openingNewDocumentOid) return;

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
      reportError('HistoryList.loadDiff', err, { uid, oid: entry.oid });
      setDiffError('Could not load diff');
    } finally {
      if (diffRequestToken.current === requestToken) {
        setLoadingDiffOid(null);
      }
    }
  }

  async function handleCompareWithCurrent(entry: HistoryEntry): Promise<void> {
    if (loadingDiffOid || restoringOid || openingNewDocumentOid || entry.oid === currentOid) {
      return;
    }

    const requestToken = diffRequestToken.current + 1;
    diffRequestToken.current = requestToken;
    setDiffError(null);
    setLoadingDiffOid(entry.oid);
    try {
      const [diff, latestDoc] = await Promise.all([
        getHistoryDiff(uid, entry.oid),
        getDocument(uid),
      ]);
      if (diffRequestToken.current !== requestToken) return;
      setSelectedDiff({
        oid: entry.oid,
        title: `Compare ${shortOid(entry.oid)} with current`,
        before: diff.after,
        after: latestDoc.source,
      });
      setDiffOpen(true);
    } catch (err) {
      if (diffRequestToken.current !== requestToken) return;
      reportError('HistoryList.compareCurrent', err, { uid, oid: entry.oid });
      setDiffError('Could not compare with current');
    } finally {
      if (diffRequestToken.current === requestToken) {
        setLoadingDiffOid(null);
      }
    }
  }

  async function handleRestoreConfirmed(): Promise<void> {
    if (!restoreTarget || !onRestoreVersion || restoringOid) return;
    setRestoreError(null);
    setRestoringOid(restoreTarget.oid);
    try {
      await onRestoreVersion(restoreTarget.oid);
      setRestoreTarget(null);
    } catch (err) {
      reportError('HistoryList.restoreVersion', err, { uid, oid: restoreTarget.oid });
      setRestoreError(
        err instanceof Error && err.message === 'display-name-required'
          ? 'Please set your display name first'
          : 'Could not restore this version',
      );
    } finally {
      setRestoringOid(null);
    }
  }

  async function handleRevertLatest(entry: HistoryEntry): Promise<void> {
    if (!onRevertLatest || loadingDiffOid || restoringOid || openingNewDocumentOid) return;
    setRestoreError(null);
    setRestoringOid(entry.oid);
    try {
      await onRevertLatest(entry);
    } catch (err) {
      reportError('HistoryList.revertLatest', err, { uid, oid: entry.oid });
      setRestoreError(
        err instanceof Error && err.message === 'display-name-required'
          ? 'Please set your display name first'
          : 'Could not revert the latest change',
      );
    } finally {
      setRestoringOid(null);
    }
  }

  async function handleRestoreAsNewDocument(): Promise<void> {
    if (
      !restoreTarget ||
      !onRestoreAsNewDocument ||
      loadingDiffOid ||
      restoringOid ||
      openingNewDocumentOid
    ) {
      return;
    }

    setRestoreError(null);
    setOpeningNewDocumentOid(restoreTarget.oid);
    try {
      await onRestoreAsNewDocument(restoreTarget.oid);
      setRestoreTarget(null);
    } catch (err) {
      reportError('HistoryList.restoreAsNewDocument', err, { uid, oid: restoreTarget.oid });
      setRestoreError('Could not open version as new document');
    } finally {
      setOpeningNewDocumentOid(null);
    }
  }

  if (loadError)
    return (
      <Box p="3">
        <Text size="xs" c="red">
          {loadError}
        </Text>
      </Box>
    );
  if (!entries)
    return (
      <Box p="3">
        <Text size="xs" c="dimmed">
          Loading…
        </Text>
      </Box>
    );
  if (entries.length === 0) {
    return (
      <Box p="3">
        <Text size="xs" c="dimmed">
          No history yet.
        </Text>
      </Box>
    );
  }

  return (
    <>
      <Box p="3" className="history-list">
        {diffError ? (
          <Box pb="2">
            <Text size="xs" c="red">
              {diffError}
            </Text>
          </Box>
        ) : null}
        {restoreError ? (
          <Box pb="2">
            <Text size="xs" c="red">
              {restoreError}
            </Text>
          </Box>
        ) : null}
        {displayedEntries.map((entry) => {
          const isCurrent = entry.oid === currentOid;
          const canRevertLatest =
            isCurrent && displayedEntries.length > 1 && Boolean(onRevertLatest);
          const revertTitle =
            entry.action === 'accept-proposal'
              ? 'Revert and reopen the change proposal'
              : 'Revert';
          const actorName = historyActorLabel(entry.actor.display_name, entry.actor.client_id);
          const proposal = entry.proposal;
          const proposalAuthor = proposal
            ? historyActorLabel(proposal.author.display_name, proposal.author.client_id)
            : 'Unknown user';

          return (
            <Flex key={entry.oid} direction="column" gap="2" py="2" className="history-entry">
              <Flex align="start" justify="between" gap="3">
                <Box style={{ flex: 1, minWidth: 0 }}>
                  <Flex align="baseline" gap="2" wrap="wrap">
                    <Text size="sm" fw={500}>
                      {describeEntry(entry)}
                    </Text>
                    <Text size="xs" c="dimmed" title={formatFullTs(entry.timestamp)}>
                      {formatTs(entry.timestamp)}
                    </Text>
                  </Flex>
                  <Text size="xs" c="dimmed">
                    by {actorName} · <Code fz="xs">{shortOid(entry.oid)}</Code>
                  </Text>
                  {proposal ? (
                    <Flex direction="column" gap="1" mt="2">
                      <Text size="xs" c="dimmed">
                        Proposal by {proposalAuthor}
                      </Text>
                      <Text size="xs">“{proposal.summary}”</Text>
                    </Flex>
                  ) : null}
                  {entry.restored_from_oid ? (
                    <Text size="xs" c="dimmed" mt="2">
                      Restored from <Code fz="xs">{shortOid(entry.restored_from_oid)}</Code>
                    </Text>
                  ) : null}
                  <Flex gap="2" wrap="wrap" mt="2">
                    <ShowDiffButton
                      onClick={() => void handleShowDiff(entry)}
                      disabled={
                        loadingDiffOid !== null ||
                        restoringOid !== null ||
                        openingNewDocumentOid !== null
                      }
                      loading={loadingDiffOid === entry.oid}
                    />
                    {!isCurrent ? (
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => void handleCompareWithCurrent(entry)}
                        disabled={
                          loadingDiffOid !== null ||
                          restoringOid !== null ||
                          openingNewDocumentOid !== null
                        }
                      >
                        Compare with current
                      </Button>
                    ) : null}
                    {proposal && onOpenThread ? (
                      <Button
                        size="xs"
                        variant="light"
                        onClick={() => onOpenThread(proposal.id)}
                        disabled={
                          loadingDiffOid !== null ||
                          restoringOid !== null ||
                          openingNewDocumentOid !== null
                        }
                      >
                        Open proposal
                      </Button>
                    ) : null}
                    {canRestore && canRevertLatest ? (
                      <Button
                        size="xs"
                        variant="light"
                        color="amber"
                        title={revertTitle}
                        onClick={() => void handleRevertLatest(entry)}
                        disabled={
                          loadingDiffOid !== null ||
                          restoringOid !== null ||
                          openingNewDocumentOid !== null
                        }
                      >
                        {restoringOid === entry.oid ? 'Reverting…' : 'Revert'}
                      </Button>
                    ) : null}
                    {canRestore && onRestoreVersion && !isCurrent ? (
                      <Button
                        size="xs"
                        variant="light"
                        color="amber"
                        onClick={() => {
                          setRestoreError(null);
                          setRestoreTarget(entry);
                        }}
                        disabled={
                          loadingDiffOid !== null ||
                          restoringOid !== null ||
                          openingNewDocumentOid !== null
                        }
                      >
                        Restore version...
                      </Button>
                    ) : null}
                  </Flex>
                </Box>
              </Flex>
            </Flex>
          );
        })}
      </Box>

      <DiffDialog
        open={diffOpen}
        onOpenChange={setDiffOpen}
        title={selectedDiff?.title ?? 'Revision diff'}
        before={selectedDiff?.before ?? ''}
        after={selectedDiff?.after ?? ''}
      />

      <Modal
        opened={restoreTarget !== null}
        onClose={() => {
          if (restoringOid || openingNewDocumentOid) return;
          setRestoreTarget(null);
          setRestoreError(null);
        }}
        size="520px"
        title={<Text fw={600} size="lg">Restore this version?</Text>}
        withCloseButton={false}
      >
          <Text size="sm" mb="3">
            Choose what to do with version{' '}
            <Code fz="xs">{restoreTarget ? shortOid(restoreTarget.oid) : ''}</Code>.
          </Text>
          <Flex direction="column" gap="2" mb="4">
            <Text size="sm" component="p">
              <b>Restore version</b> replaces the current document source, creates a new history
              entry, and re-anchors comments and proposals where possible.
            </Text>
            <Text size="sm" component="p">
              <b>Restore as new document</b> opens the New document modal with this version's source
              prefilled, leaving the current document untouched.
            </Text>
          </Flex>
          <Flex gap="2" justify="end">
            <Button
              variant="light"
              color="gray"
              disabled={restoringOid !== null || openingNewDocumentOid !== null}
              onClick={() => {
                setRestoreTarget(null);
                setRestoreError(null);
              }}
            >
              Cancel
            </Button>
            {onRestoreAsNewDocument ? (
              <Button
                variant="light"
                onClick={() => void handleRestoreAsNewDocument()}
                disabled={restoringOid !== null || openingNewDocumentOid !== null}
              >
                {openingNewDocumentOid === restoreTarget?.oid
                  ? 'Opening…'
                  : 'Restore as new document'}
              </Button>
            ) : null}
            <Button
              color="amber"
              onClick={() => void handleRestoreConfirmed()}
              disabled={restoringOid !== null || openingNewDocumentOid !== null}
            >
              {restoringOid ? 'Restoring…' : 'Restore version'}
            </Button>
          </Flex>
      </Modal>
    </>
  );
}

function describeEntry(entry: HistoryEntry): string {
  switch (entry.action) {
    case 'upload':
      return 'Uploaded';
    case 'update':
      return 'Edited';
    case 'restore':
      return 'Restored';
    case 'accept-proposal':
      return 'Accepted proposal';
    default:
      return 'History entry';
  }
}

function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

function historyActorLabel(displayName: string | null, clientId: string | null): string {
  if (displayName) return displayName;
  if (clientId) return clientId.slice(0, 8);
  return 'Unknown user';
}

function formatTs(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString();
}

function formatFullTs(ts: number): string {
  return new Date(ts).toLocaleString([], {
    dateStyle: 'full',
    timeStyle: 'medium',
  });
}
