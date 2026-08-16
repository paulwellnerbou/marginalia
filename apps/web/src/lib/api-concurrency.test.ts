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

test('a browser-created proposal carries the comment thread it answers', async () => {
  installLocalStorage();
  const { createEditProposal } = await import('./api.js');
  let requestBody: Record<string, unknown> | null = null;
  (globalThis as { fetch?: unknown }).fetch = async (_input: unknown, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        thread: {
          id: 'proposal-thread',
          comments: [{ created_at: 1 }],
        },
      }),
      { status: 201, headers: { 'content-type': 'application/json' } },
    );
  };

  await createEditProposal(
    'doc-linked-proposal',
    {
      anchor_block_id: 'paragraph-1',
      anchor_quote: 'Original paragraph',
      proposed_text: 'Rewritten paragraph',
      answers_thread_ids: ['comment-thread'],
    },
    { clientId: 'client-1', displayName: 'Alice' },
  );

  expect(requestBody).toMatchObject({
    proposal: {
      proposed_text: 'Rewritten paragraph',
      answers_thread_ids: ['comment-thread'],
    },
  });
});
