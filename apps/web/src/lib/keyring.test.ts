/// <reference types="bun" />

import { beforeEach, expect, test } from 'bun:test';

/**
 * The subscription lifecycle, which the home page relies on: the panel
 * mounts, listens for connect/disconnect/rotate, and must leave nothing
 * behind when it unmounts. Callers wire the returned function up as a
 * React effect cleanup, so a leak here would accumulate a listener per
 * mount for the life of the tab.
 *
 * Plus what a pull reports back, which is what the home page turns into
 * the "syncing stopped" notice.
 */

interface Listener {
  type: string;
  fn: EventListenerOrEventListenerObject;
}

let listeners: Listener[];

function installDom(): void {
  listeners = [];
  const store = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0,
  };
  const session = new Map<string, string>();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
    clear: () => session.clear(),
    key: () => null,
    length: 0,
  };
  (globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
      listeners.push({ type, fn });
    },
    removeEventListener: (type: string, fn: EventListenerOrEventListenerObject) => {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: (event: { type: string }) => {
      for (const l of [...listeners]) {
        if (l.type !== event.type) continue;
        if (typeof l.fn === 'function') l.fn(event as unknown as Event);
      }
      return true;
    },
  };
  (globalThis as { CustomEvent?: unknown }).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
}

let fetches = 0;

/** Answer every fetch with this status and body, whatever the URL. */
function stubFetch(status: number, body: unknown): void {
  (globalThis as { fetch?: unknown }).fetch = () =>
    ++fetches &&
    Promise.resolve(
      new Response(body === undefined ? null : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
}

beforeEach(() => {
  installDom();
  fetches = 0;
});

test('unsubscribing removes every listener it added', async () => {
  const { onKeyringChange } = await import('./keyring.js');

  const before = listeners.length;
  const unsubscribe = onKeyringChange(() => {});
  // Both the in-app event and the cross-tab `storage` channel.
  expect(listeners.length).toBe(before + 2);

  unsubscribe();
  expect(listeners.length).toBe(before);
});

test('repeated subscribe/unsubscribe cycles do not accumulate listeners', async () => {
  const { onKeyringChange } = await import('./keyring.js');

  const before = listeners.length;
  for (let i = 0; i < 5; i++) onKeyringChange(() => {})();
  expect(listeners.length).toBe(before);
});

test('a pull that finds no ring drops the token and says so', async () => {
  const { pullKeyring } = await import('./keyring.js');

  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(404, { error: 'not-found' });

  const { listKeyrings } = await import('./keyring.js');
  const pull = await pullKeyring();
  // The pair the home page needs: something to say, and a reason to say
  // it. Without `dropped` the panel just silently flips to disconnected.
  expect(pull.dropped).toEqual(['Unnamed project']);
  expect(pull.docs).toBeNull();
  expect(listKeyrings()).toEqual([]);
});

test('a pull carries the idle window back for the panel to quote', async () => {
  const { pullKeyring } = await import('./keyring.js');

  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(200, {
    client_id: 'aaaaaaaaaaaaaaaaaaaa',
    display_name: 'Paul',
    idle_ttl_ms: 180 * 24 * 60 * 60 * 1000,
    docs: [],
  });

  const { listKeyrings } = await import('./keyring.js');
  const pull = await pullKeyring();
  expect(pull.dropped).toEqual([]);
  expect(pull.idleTtlMs).toBe(180 * 24 * 60 * 60 * 1000);
  expect(listKeyrings()[0]?.token).toBe('tok');
});

test('an older overlapping pull cannot land after a newer snapshot', async () => {
  const { pullKeyring } = await import('./keyring.js');

  localStorage.setItem('marginalia.keyring', 'tok');
  const responders: Array<(response: Response) => void> = [];
  (globalThis as { fetch?: unknown }).fetch = () =>
    new Promise<Response>((resolve) => responders.push(resolve));

  const older = pullKeyring();
  const newer = pullKeyring();
  const response = (idleTtlMs: number) =>
    new Response(
      JSON.stringify({
        client_id: 'aaaaaaaaaaaaaaaaaaaa',
        display_name: 'Paul',
        idle_ttl_ms: idleTtlMs,
        docs: [],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  responders[1]?.(response(222));
  expect((await newer).idleTtlMs).toBe(222);

  responders[0]?.(response(111));
  expect((await older).idleTtlMs).toBeNull();
});

test('a pull that fails for any other reason keeps the token', async () => {
  const { pullKeyring } = await import('./keyring.js');

  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(500, { error: 'boom' });

  const { listKeyrings } = await import('./keyring.js');
  const pull = await pullKeyring();
  // A server having a bad minute must not read as "your ring is gone" —
  // that would drop a live credential and show the wrong notice.
  expect(pull.dropped).toEqual([]);
  expect(listKeyrings()[0]?.token).toBe('tok');
});

test('an unsubscribed listener stops hearing changes', async () => {
  const { disconnectKeyring, listKeyrings, onKeyringChange } = await import('./keyring.js');

  const seen: number[] = [];
  const unsubscribe = onKeyringChange((rings) => seen.push(rings.length));

  localStorage.setItem('marginalia.keyring', 'tok');
  disconnectKeyring(listKeyrings()[0]!.id);
  expect(seen).toEqual([0]);

  unsubscribe();
  localStorage.setItem('marginalia.keyring', 'tok');
  disconnectKeyring(listKeyrings()[0]!.id);
  expect(seen).toEqual([0]);
});

test('a synced browser keeps the ring’s name when a document names it otherwise', async () => {
  const { adoptDocumentName } = await import('./keyring.js');
  const { getDisplayName, setDisplayName } = await import('./identity.js');
  setDisplayName('Paul');

  localStorage.setItem('marginalia.keyring', 'tok');
  adoptDocumentName('Claude');
  expect(getDisplayName()).toBe('Paul');

  localStorage.removeItem('marginalia.keyrings');
  adoptDocumentName('Ann');
  expect(getDisplayName()).toBe('Ann');
});

test('a bare link finds its token in the ring and keeps it for the viewer', async () => {
  const { inviteFromKeyring } = await import('./keyring.js');

  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(200, {
    client_id: 'aaaaaaaaaaaaaaaaaaaa',
    display_name: 'Paul',
    docs: [
      {
        doc_uid: 'fresh-doc',
        invite_token: 'admin-token',
        title: 'Made by an agent',
        role: 'admin',
        format: 'markdown',
        password_protected: false,
        folder_uid: null,
        updated_at: 1,
        added_at: 1,
        cover: null,
      },
    ],
  });

  expect((await inviteFromKeyring('fresh-doc')).token).toBe('admin-token');
  expect(localStorage.getItem('marginalia.invite.fresh-doc')).toBe('admin-token');
  expect((await inviteFromKeyring('not-in-ring')).token).toBeNull();
  expect(localStorage.getItem('marginalia.invite.not-in-ring')).toBeNull();
});

test('without a ring, a bare link asks nobody', async () => {
  const { inviteFromKeyring } = await import('./keyring.js');

  let fetched = false;
  (globalThis as { fetch?: unknown }).fetch = () => {
    fetched = true;
    return Promise.reject(new Error('no request expected'));
  };
  expect((await inviteFromKeyring('any-doc')).token).toBeNull();
  expect(fetched).toBe(false);
});

function ringWith(docs: Array<{ uid: string; token: string }>) {
  return {
    client_id: 'aaaaaaaaaaaaaaaaaaaa',
    display_name: 'Paul',
    docs: docs.map((d) => ({
      doc_uid: d.uid,
      invite_token: d.token,
      title: null,
      role: 'admin',
      format: 'markdown',
      password_protected: false,
      folder_uid: null,
      updated_at: 1,
      added_at: 1,
      cover: null,
    })),
  };
}

test('a token an earlier pull left in the local list needs no request', async () => {
  const { inviteFromKeyring } = await import('./keyring.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(200, ringWith([{ uid: 'known', token: 'from-ring' }]));
  const { pullKeyring } = await import('./keyring.js');
  await pullKeyring();
  const before = fetches;

  expect((await inviteFromKeyring('known')).token).toBe('from-ring');
  expect(fetches).toBe(before);
});

test('a document the ring does not have is not asked about again soon', async () => {
  const { inviteFromKeyring } = await import('./keyring.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(200, ringWith([]));

  expect((await inviteFromKeyring('public-doc')).token).toBeNull();
  expect((await inviteFromKeyring('public-doc')).token).toBeNull();
  expect(fetches).toBe(1);
  // A token that stopped working still gets a fresh answer.
  await inviteFromKeyring('public-doc', { refresh: true });
  expect(fetches).toBe(2);
});

test('a ring the viewer finds gone is still announced on the home page, once', async () => {
  const { inviteFromKeyring, takeKeyringDropped } = await import('./keyring.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(404, { error: 'not-found' });

  expect((await inviteFromKeyring('any')).token).toBeNull();
  expect(takeKeyringDropped()).toEqual(['Unnamed project']);
  expect(takeKeyringDropped()).toEqual([]);
});

test('a stored token that stopped working is replaced from the ring', async () => {
  const { openDocument } = await import('./open-document.js');
  const { ApiError } = await import('./api.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  localStorage.setItem('marginalia.invite.doc', 'rotated-away');
  stubFetch(200, ringWith([{ uid: 'doc', token: 'current' }]));

  const seen: Array<string | null> = [];
  const doc = await openDocument('doc', async () => {
    const token = localStorage.getItem('marginalia.invite.doc');
    seen.push(token);
    if (token !== 'current') throw new ApiError(401, 'invite-required');
    return { uid: 'doc' } as never;
  });
  expect(doc).toEqual({ uid: 'doc' } as never);
  expect(seen).toEqual(['rotated-away', 'current']);
});

test('without a token of its own, a refused bare link asks the ring only once', async () => {
  const { openDocument } = await import('./open-document.js');
  const { ApiError } = await import('./api.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(200, ringWith([]));

  await expect(
    openDocument('elsewhere', async () => {
      throw new ApiError(401, 'invite-required');
    }),
  ).rejects.toThrow();
  expect(fetches).toBe(1);
});

test('a pull that failed is not remembered as the ring lacking the document', async () => {
  const { inviteFromKeyring } = await import('./keyring.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(503, { error: 'unavailable' });
  expect((await inviteFromKeyring('doc')).token).toBeNull();

  stubFetch(200, ringWith([{ uid: 'doc', token: 'from-ring' }]));
  expect((await inviteFromKeyring('doc')).token).toBe('from-ring');
});

test('the home page’s own drop is announced once, not again on the next load', async () => {
  const { pullKeyring, takeKeyringDropped } = await import('./keyring.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  stubFetch(404, { error: 'not-found' });

  const pull = await pullKeyring();
  const droppedElsewhere = takeKeyringDropped();
  expect([...pull.dropped, ...droppedElsewhere].length).toBeGreaterThan(0);
  // The next load: no ring, no pull, and nothing left to announce.
  expect(takeKeyringDropped()).toEqual([]);
});

test('a stale token from the local list is replaced from the ring', async () => {
  const { openDocument } = await import('./open-document.js');
  const { ApiError } = await import('./api.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  // An earlier pull left a link that has since been rotated away.
  stubFetch(200, ringWith([{ uid: 'doc', token: 'rotated-away' }]));
  const { pullKeyring } = await import('./keyring.js');
  await pullKeyring();
  stubFetch(200, ringWith([{ uid: 'doc', token: 'current' }]));

  const seen: Array<string | null> = [];
  await openDocument('doc', async () => {
    const token = localStorage.getItem('marginalia.invite.doc');
    seen.push(token);
    if (token !== 'current') throw new ApiError(401, 'invite-required');
    return { uid: 'doc', role: 'admin' } as never;
  });
  expect(seen).toEqual(['rotated-away', 'current']);
});

test('a document that opens only as a reader where it was known as more asks the ring', async () => {
  const { openDocument } = await import('./open-document.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  localStorage.setItem('marginalia.invite.doc', 'rotated-away');
  stubFetch(200, ringWith([{ uid: 'doc', token: 'rotated-away' }]));
  const { pullKeyring } = await import('./keyring.js');
  await pullKeyring();
  stubFetch(200, ringWith([{ uid: 'doc', token: 'current' }]));

  const doc = await openDocument('doc', async () => {
    const token = localStorage.getItem('marginalia.invite.doc');
    return { uid: 'doc', role: token === 'current' ? 'admin' : 'reader' } as never;
  });
  expect((doc as { role: string }).role).toBe('admin');
});

// --- several rings ---------------------------------------------------

interface Seen {
  method: string;
  path: string;
  ring: string | null;
  body: unknown;
}

/**
 * A server holding a few rings by token: GET answers with that ring's
 * documents, PUT and DELETE change them. Every request is recorded.
 */
function stubRings(rings: Record<string, Array<{ uid: string; token: string }>>): Seen[] {
  const seen: Seen[] = [];
  (globalThis as { fetch?: unknown }).fetch = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    const ring = headers.get('x-marginalia-keyring');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    seen.push({ method, path, ring, body });
    const json = (status: number, payload: unknown) =>
      new Response(payload === null ? null : JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    const docs = ring ? rings[ring] : undefined;
    const docPath = path.match(/^\/api\/keyrings\/self\/docs\/(.+)$/);
    if (docPath && docs) {
      const uid = decodeURIComponent(docPath[1]!);
      const rest = docs.filter((d) => d.uid !== uid);
      if (method === 'PUT')
        rest.push({ uid, token: (body as { invite_token: string }).invite_token });
      rings[ring!] = rest;
      return method === 'DELETE' ? json(204, null) : json(200, { ok: true });
    }
    if (path === '/api/keyrings/self' && docs) {
      return json(200, {
        ...ringWith(docs),
        label: `label of ${ring}`,
        display_name: `display name of ${ring}`,
      });
    }
    return json(404, { error: 'not-found' });
  };
  return seen;
}

function storeTwoRings(): void {
  localStorage.setItem(
    'marginalia.keyrings',
    JSON.stringify([
      { id: 'ring-a', token: 'tok-a', label: 'Acme', displayName: 'Paul (Acme)' },
      { id: 'ring-b', token: 'tok-b', label: 'Beta', displayName: 'Paul' },
    ]),
  );
}

test('a token from an older version becomes the first ring', async () => {
  const { listKeyrings } = await import('./keyring.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  const rings = listKeyrings();
  expect(rings.map((r) => r.token)).toEqual(['tok']);
  expect(localStorage.getItem('marginalia.keyring')).toBeNull();
  // Read again: the same ring, not another one.
  expect(listKeyrings()).toEqual(rings);
});

test('each ring’s pull says which documents it holds, and a document it dropped stays here', async () => {
  const { pullKeyring } = await import('./keyring.js');
  const { loadRecentDocs } = await import('./recent-docs.js');
  storeTwoRings();
  const server: Record<string, Array<{ uid: string; token: string }>> = {
    'tok-a': [{ uid: 'a1', token: 't-a1' }],
    'tok-b': [
      { uid: 'b1', token: 't-b1' },
      { uid: 'shared', token: 't-s' },
    ],
  };
  stubRings(server);
  await pullKeyring();
  const ringsOf = () =>
    Object.fromEntries(loadRecentDocs().map((d) => [d.uid, d.rings ?? []] as const));
  expect(ringsOf()).toEqual({ a1: ['ring-a'], b1: ['ring-b'], shared: ['ring-b'] });

  server['tok-b'] = [{ uid: 'b1', token: 't-b1' }];
  await pullKeyring();
  expect(ringsOf()).toEqual({ a1: ['ring-a'], b1: ['ring-b'], shared: [] });
});

test('a pull keeps each ring’s label and name', async () => {
  const { listKeyrings, pullKeyring } = await import('./keyring.js');
  storeTwoRings();
  stubRings({ 'tok-a': [], 'tok-b': [] });
  await pullKeyring();
  expect(listKeyrings().map((r) => r.label)).toEqual(['label of tok-a', 'label of tok-b']);
});

test('a document in no ring is filed only into the ring in front', async () => {
  const { filingKeyring, pushDoc, setRingView } = await import('./keyring.js');
  const { recordVisit } = await import('./recent-docs.js');
  storeTwoRings();
  const seen = stubRings({ 'tok-a': [], 'tok-b': [] });
  recordVisit({
    uid: 'fresh',
    title: 'Fresh',
    role: 'admin',
    password_protected: false,
    format: 'markdown',
    visited_at: 1,
    updated_at: 1,
  });

  setRingView('all');
  expect(filingKeyring()).toBeNull();
  pushDoc('fresh', 't-fresh');
  expect(seen).toEqual([]);

  setRingView('ring-b');
  pushDoc('fresh', 't-fresh');
  expect(seen.map((s) => [s.method, s.ring])).toEqual([['PUT', 'tok-b']]);
});

test('a document already in a ring is pushed to that ring, whichever is in front', async () => {
  const { pullKeyring, pushDoc, setRingView } = await import('./keyring.js');
  storeTwoRings();
  const seen = stubRings({ 'tok-a': [{ uid: 'a1', token: 't-a1' }], 'tok-b': [] });
  await pullKeyring();
  seen.length = 0;

  setRingView('ring-b');
  pushDoc('a1', 't-a1-rotated');
  expect(seen.map((s) => [s.method, s.ring])).toEqual([['PUT', 'tok-a']]);
});

test('with one ring everything goes into it, as before there could be several', async () => {
  const { filingKeyring, setRingView } = await import('./keyring.js');
  localStorage.setItem('marginalia.keyring', 'tok');
  setRingView('all');
  expect(filingKeyring()?.token).toBe('tok');
});

test('moving adds to the new ring before it removes from the old one', async () => {
  const { moveDocsToKeyring, pullKeyring } = await import('./keyring.js');
  const { loadRecentDocs } = await import('./recent-docs.js');
  storeTwoRings();
  const server: Record<string, Array<{ uid: string; token: string }>> = {
    'tok-a': [{ uid: 'a1', token: 't-a1' }],
    'tok-b': [],
  };
  const seen = stubRings(server);
  await pullKeyring();
  seen.length = 0;

  await moveDocsToKeyring([{ uid: 'a1', invite_token: 't-a1' }], 'ring-a', 'ring-b');
  expect(seen.map((s) => [s.method, s.ring])).toEqual([
    ['PUT', 'tok-b'],
    ['DELETE', 'tok-a'],
  ]);
  expect(server).toEqual({ 'tok-a': [], 'tok-b': [{ uid: 'a1', token: 't-a1' }] });
  expect(loadRecentDocs().find((d) => d.uid === 'a1')?.rings).toEqual(['ring-b']);
});

test('a move that fails halfway leaves the document in both rings, not in neither', async () => {
  const { moveDocsToKeyring, pullKeyring } = await import('./keyring.js');
  const { loadRecentDocs } = await import('./recent-docs.js');
  storeTwoRings();
  stubRings({ 'tok-a': [{ uid: 'a1', token: 't-a1' }], 'tok-b': [] });
  await pullKeyring();
  const fetchOk = globalThis.fetch;
  (globalThis as { fetch?: unknown }).fetch = (path: string, init: RequestInit = {}) =>
    init.method === 'DELETE'
      ? Promise.resolve(new Response(JSON.stringify({ error: 'boom' }), { status: 500 }))
      : fetchOk(path, init);

  await expect(
    moveDocsToKeyring([{ uid: 'a1', invite_token: 't-a1' }], 'ring-a', 'ring-b'),
  ).rejects.toThrow();
  expect(
    loadRecentDocs()
      .find((d) => d.uid === 'a1')
      ?.rings?.sort(),
  ).toEqual(['ring-a', 'ring-b']);
});

test('pairing a second ring keeps the identity this browser already authors under', async () => {
  const { pairWithCode } = await import('./keyring.js');
  const { getClientId } = await import('./identity.js');
  storeTwoRings();
  const mine = getClientId();
  const bodies: unknown[] = [];
  (globalThis as { fetch?: unknown }).fetch = async (_path: string, init: RequestInit = {}) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(
      JSON.stringify({ ...ringWith([]), token: 'tok-c', label: 'Gamma', client_id: 'other' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const paired = await pairWithCode('ABCD-EFGH');
  expect(bodies).toEqual([{ code: 'ABCD-EFGH', keep_client_id: true }]);
  expect(getClientId()).toBe(mine);
  expect(paired.identityKept).toBe(true);
  expect(paired.ring.label).toBe('Gamma');
});

test('the name in use is the one of the ring the document is in', async () => {
  const { pullKeyring, scopeIdentityTo, setRingView } = await import('./keyring.js');
  const { getDisplayName, setDisplayName } = await import('./identity.js');
  storeTwoRings();
  stubRings({ 'tok-a': [{ uid: 'a1', token: 't-a1' }], 'tok-b': [] });
  await pullKeyring();
  setRingView('all');
  scopeIdentityTo(null);
  setDisplayName('Paul W');

  scopeIdentityTo('a1');
  expect(getDisplayName()).toBe('display name of tok-a');
  setDisplayName('Paul for Acme');
  expect(getDisplayName()).toBe('Paul for Acme');

  // Every project at once files nowhere, so the browser's own name applies.
  scopeIdentityTo(null);
  expect(getDisplayName()).toBe('Paul W');
});

test('a name typed in one project keeps its own time and reaches only that ring', async () => {
  const { findKeyring, pullKeyring, pushDisplayName, scopeIdentityTo, setRingView } = await import(
    './keyring.js'
  );
  const { getDisplayNameSetAt, setDisplayName } = await import('./identity.js');
  storeTwoRings();
  const seen = stubRings({ 'tok-a': [{ uid: 'a1', token: 't-a1' }], 'tok-b': [] });
  await pullKeyring();
  setRingView('all');
  seen.length = 0;

  scopeIdentityTo('a1');
  const before = Date.now();
  setDisplayName('Paul for Acme');
  pushDisplayName('Paul for Acme');

  const acme = findKeyring('ring-a');
  expect(acme?.displayName).toBe('Paul for Acme');
  expect(acme?.displayNameSetAt).toBeGreaterThanOrEqual(before);
  expect(getDisplayNameSetAt()).toBe(acme?.displayNameSetAt ?? -1);
  expect(findKeyring('ring-b')?.displayName).toBe('display name of tok-b');
  expect(seen.map((s) => [s.method, s.ring, s.body])).toEqual([
    [
      'PATCH',
      'tok-a',
      { display_name: 'Paul for Acme', display_name_set_at: acme?.displayNameSetAt },
    ],
  ]);
  scopeIdentityTo(null);
});

test('a browser left with one of several rings keeps the client id it authors under', async () => {
  const { disconnectKeyring, pullKeyring } = await import('./keyring.js');
  const { getClientId } = await import('./identity.js');
  storeTwoRings();
  const mine = getClientId();
  stubRings({ 'tok-a': [], 'tok-b': [] });
  disconnectKeyring('ring-a');
  (globalThis as { fetch?: unknown }).fetch = async () =>
    new Response(JSON.stringify({ ...ringWith([]), client_id: 'someone-else' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  await pullKeyring();
  expect(getClientId()).toBe(mine);
});

test('a tab that chose no project files nothing, whatever another tab chose last', async () => {
  const { claimRingView, filingKeyring } = await import('./keyring.js');
  storeTwoRings();
  // Chosen in another tab: this tab's session storage has never seen it.
  localStorage.setItem('marginalia.keyrings.view', 'ring-a');
  expect(filingKeyring()).toBeNull();
  // The home page shows that project's documents, so it takes the choice on.
  claimRingView();
  expect(filingKeyring()?.id).toBe('ring-a');
});

test('a request for a document signs with its own ring’s name, whatever page is in front', async () => {
  const { pullKeyring, scopeIdentityTo, setRingView } = await import('./keyring.js');
  const { getDisplayName, getDisplayNameFor } = await import('./identity.js');
  storeTwoRings();
  stubRings({ 'tok-a': [{ uid: 'a1', token: 't-a1' }], 'tok-b': [{ uid: 'b1', token: 't-b1' }] });
  await pullKeyring();
  setRingView('all');

  scopeIdentityTo('b1');
  expect(getDisplayName()).toBe('display name of tok-b');
  // Still on screen while b1 loads: a request for a1 keeps a1's name.
  expect(getDisplayNameFor('a1')).toBe('display name of tok-a');
  scopeIdentityTo(null);
});

test('a ring that never held a removed document does not let another ring revive it', async () => {
  const { pullKeyring } = await import('./keyring.js');
  const { loadRecentDocs, removeFromRecent } = await import('./recent-docs.js');
  // B listed first, so its snapshot is merged before A's.
  localStorage.setItem(
    'marginalia.keyrings',
    JSON.stringify([
      { id: 'ring-b', token: 'tok-b', label: 'Beta', displayName: 'Paul' },
      { id: 'ring-a', token: 'tok-a', label: 'Acme', displayName: 'Paul' },
    ]),
  );
  const server: Record<string, Array<{ uid: string; token: string }>> = {
    'tok-a': [{ uid: 'gone', token: 't' }],
    'tok-b': [],
  };
  stubRings(server);
  await pullKeyring();
  removeFromRecent('gone');

  // A's DELETE has not landed yet: A still lists it.
  await pullKeyring();
  expect(loadRecentDocs().some((d) => d.uid === 'gone')).toBe(false);
  await pullKeyring();
  expect(loadRecentDocs().some((d) => d.uid === 'gone')).toBe(false);
});

test('a ring that failed to answer may hold the document, so it is not a miss', async () => {
  const { inviteFromKeyring } = await import('./keyring.js');
  storeTwoRings();
  stubRings({ 'tok-a': [] });
  const ok = globalThis.fetch;
  (globalThis as { fetch?: unknown }).fetch = (path: string, init: RequestInit = {}) =>
    new Headers(init.headers).get('x-marginalia-keyring') === 'tok-b'
      ? Promise.resolve(new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }))
      : ok(path, init);
  expect((await inviteFromKeyring('in-b')).token).toBeNull();

  stubRings({ 'tok-a': [], 'tok-b': [{ uid: 'in-b', token: 't-b' }] });
  expect((await inviteFromKeyring('in-b')).token).toBe('t-b');
});

test('a token another tab on an older version writes is taken in and announced', async () => {
  const { onKeyringChange } = await import('./keyring.js');
  const seen: string[][] = [];
  const unsubscribe = onKeyringChange((rings) => seen.push(rings.map((r) => r.token)));

  localStorage.setItem('marginalia.keyring', 'from-old-tab');
  window.dispatchEvent({
    type: 'storage',
    key: 'marginalia.keyring',
    newValue: 'from-old-tab',
  } as unknown as Event);
  expect(seen).toEqual([['from-old-tab']]);
  expect(localStorage.getItem('marginalia.keyring')).toBeNull();
  unsubscribe();
});
