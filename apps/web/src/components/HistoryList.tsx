import { useEffect, useState } from 'react';
import { Box, Code, Flex, Text } from '@radix-ui/themes';
import { getHistory, type HistoryEntry } from '../lib/api.js';
import { reportError } from '../lib/log.js';

/**
 * Right-pane view of the document's git log. Loads on mount; re-renders
 * when the `version` prop increments (bumped on document.updated events).
 */
export function HistoryList({ uid, version }: { uid: string; version: number }) {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHistory(uid).then(
      (r) => {
        if (!cancelled) setEntries(r.history);
      },
      (err) => {
        if (cancelled) return;
        reportError('HistoryList.load', err, { uid });
        setError('Could not load history');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [uid, version]);

  if (error) return <Box p="3"><Text size="1" color="red">{error}</Text></Box>;
  if (!entries) return <Box p="3"><Text size="1" color="gray">Loading…</Text></Box>;
  if (entries.length === 0) {
    return <Box p="3"><Text size="1" color="gray">No history yet.</Text></Box>;
  }

  return (
    <Box p="3" className="history-list">
      {entries.map((e) => (
        <Flex key={e.oid} direction="column" gap="1" py="2" className="history-entry">
          <Flex align="baseline" gap="2">
            <Text size="2" weight="medium">{describeMessage(e.message)}</Text>
            <Text size="1" color="gray" title={formatFullTs(e.timestamp)}>
              {formatTs(e.timestamp)}
            </Text>
          </Flex>
          <Text size="1" color="gray">
            by {e.author.name} · <Code size="1">{e.oid.slice(0, 7)}</Code>
          </Text>
        </Flex>
      ))}
    </Box>
  );
}

function describeMessage(msg: string): string {
  const firstLine = msg.split('\n')[0]!;
  if (firstLine.startsWith('upload:')) return 'Uploaded';
  if (firstLine.startsWith('update:')) return 'Edited';
  if (firstLine.startsWith('restore:')) return 'Restored';
  return firstLine;
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
