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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function thread(id: string, createdAt = 1): Record<string, unknown> {
  return { id, comments: [{ id: `${id}-root`, created_at: createdAt }] };
}

/** Capture the URLs a block of api calls requests. */
function recordUrls(respond: (url: string) => Response): string[] {
  const urls: string[] = [];
  (globalThis as { fetch?: unknown }).fetch = async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    return respond(url);
  };
  return urls;
}

test('listThreads defaults to the whole archive', async () => {
  installLocalStorage();
  const { listThreads } = await import('./api.js');
  const urls = recordUrls(() =>
    json({ threads: [], mention_candidates: [], pending_mentions: [] }),
  );

  await listThreads('doc-default', { consumeMentions: false, fresh: true });

  expect(urls[0]).toContain('state=all');
});

test('listThreads can ask for only the open threads', async () => {
  installLocalStorage();
  const { listThreads } = await import('./api.js');
  const urls = recordUrls(() =>
    json({ threads: [], mention_candidates: [], pending_mentions: [] }),
  );

  await listThreads('doc-open', { state: 'open', consumeMentions: false, fresh: true });

  expect(urls[0]).toContain('state=open');
  expect(urls[0]).not.toContain('state=all');
});

test('an open-only read is never served to a caller that asked for the archive', async () => {
  installLocalStorage();
  const { listThreads } = await import('./api.js');
  const urls = recordUrls((url) =>
    json({
      threads: url.includes('state=open')
        ? [thread('open-1')]
        : [thread('open-1'), thread('done-1', 2)],
      mention_candidates: [],
      pending_mentions: [],
    }),
  );

  // Deliberately concurrent: the in-flight dedupe keys on the request, and
  // collapsing these two would hand the archive caller a partial list.
  const [open, all] = await Promise.all([
    listThreads('doc-split', { state: 'open', consumeMentions: false }),
    listThreads('doc-split', { state: 'all', consumeMentions: false }),
  ]);

  expect(urls).toHaveLength(2);
  expect(open.threads).toHaveLength(1);
  expect(all.threads).toHaveLength(2);
});

test('an open-only read does not evict resolved threads from the local index', async () => {
  installLocalStorage();
  const { listThreads, fetchThread } = await import('./api.js');
  const urls = recordUrls((url) => {
    if (url.includes('thread_id='))
      return json({ threads: [], mention_candidates: [], pending_mentions: [] });
    if (url.includes('state=open')) {
      return json({ threads: [thread('open-1')], mention_candidates: [], pending_mentions: [] });
    }
    return json({
      threads: [thread('open-1'), thread('done-1', 2)],
      mention_candidates: [],
      pending_mentions: [],
    });
  });

  // Archive first (populates the snapshot), then the narrower read.
  await listThreads('doc-index', { state: 'all', consumeMentions: false, fresh: true });
  await listThreads('doc-index', { state: 'open', consumeMentions: false, fresh: true });

  // `fetchThread` returning null forgets the id from the snapshot. If the
  // open-only read had overwritten the snapshot, the resolved thread would
  // already be missing and this would be reading a truncated index.
  urls.length = 0;
  await fetchThread('doc-index', 'done-1');
  expect(urls[0]).toContain('thread_id=done-1');
});

test('fetchThread reads exactly one thread and never consumes mentions', async () => {
  installLocalStorage();
  const { fetchThread } = await import('./api.js');
  const urls = recordUrls(() =>
    json({ threads: [thread('t-1')], mention_candidates: [], pending_mentions: [] }),
  );

  const result = await fetchThread('doc-one', 't-1');

  expect(result?.id).toBe('t-1');
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain('thread_id=t-1');
  expect(urls[0]).toContain('consume_mentions=false');
});

test('fetchThread resolves a reply id to the root thread the server returns', async () => {
  installLocalStorage();
  const { fetchThread } = await import('./api.js');
  recordUrls(() =>
    json({ threads: [thread('root-1')], mention_candidates: [], pending_mentions: [] }),
  );

  // The server matches "this id, or the root of the reply with this id",
  // so the row that comes back is not the id that was asked for.
  const result = await fetchThread('doc-reply', 'reply-9');

  expect(result?.id).toBe('root-1');
});

test('fetchThread reports a vanished thread as null', async () => {
  installLocalStorage();
  const { fetchThread } = await import('./api.js');
  recordUrls(() => json({ threads: [], mention_candidates: [], pending_mentions: [] }));

  expect(await fetchThread('doc-gone', 'deleted-1')).toBeNull();
});
