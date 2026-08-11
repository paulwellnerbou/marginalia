/// <reference types="bun" />

import { expect, test } from 'bun:test';

function installLocalStorage(): void {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

test('a fresh thread reconciliation bypasses an older in-flight snapshot', async () => {
  installLocalStorage();
  const { listThreads } = await import('./api.js');
  const responders: Array<(response: Response) => void> = [];
  (globalThis as { fetch?: unknown }).fetch = () =>
    new Promise<Response>((resolve) => responders.push(resolve));

  const older = listThreads('doc-concurrency', { consumeMentions: false });
  const newer = listThreads('doc-concurrency', { consumeMentions: false, fresh: true });

  // Without the fresh bypass both calls share one promise, which lets a read
  // started before the second mutation overwrite that mutation afterward.
  expect(responders).toHaveLength(2);

  const response = () =>
    new Response(JSON.stringify({ threads: [], mention_candidates: [], pending_mentions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  responders[1]?.(response());
  responders[0]?.(response());
  await Promise.all([older, newer]);
});
