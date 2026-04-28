import type { HistoryEntry } from './api.js';

export function describeEntry(entry: HistoryEntry): string {
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

export function shortOid(oid: string): string {
  return oid.slice(0, 7);
}

export function historyActorLabel(displayName: string | null, clientId: string | null): string {
  if (displayName) return displayName;
  if (clientId) return clientId.slice(0, 8);
  return 'Unknown user';
}
