/// <reference types="bun" />

import { beforeEach, describe, expect, test } from 'bun:test';

function installLocalStorage(): Map<string, string> {
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
  return store;
}

interface Sent {
  url: string;
  headers: Headers;
  body: unknown;
}

function stubFetch(responses: Array<{ status: number; body: unknown }>): Sent[] {
  const sent: Sent[] = [];
  (globalThis as { fetch?: unknown }).fetch = async (input: unknown, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return sent;
}

let store: Map<string, string>;

/**
 * api.ts and identity.ts signal through window events. Other test files in
 * the same run swap the global `CustomEvent` for stand-ins, one without a
 * `type`, so this file installs its own of both.
 */
function installWindow(): void {
  (globalThis as { CustomEvent?: unknown }).CustomEvent = class {
    type: string;
    detail: unknown;
    constructor(type: string, init?: { detail?: unknown }) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  const listeners = new Map<string, Set<(e: Event) => void>>();
  (globalThis as { window?: unknown }).window = {
    addEventListener: (type: string, fn: (e: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (e: Event) => {
      for (const fn of [...(listeners.get(e.type) ?? [])]) fn(e);
      return true;
    },
  };
}

beforeEach(() => {
  store = installLocalStorage();
  installWindow();
});

describe('when a name was chosen', () => {
  test('a made-up name has no time, a typed one does', async () => {
    const { getDisplayName, getDisplayNameSetAt, setDisplayName } = await import('./identity.js');
    getDisplayName();
    expect(getDisplayNameSetAt()).toBeNull();
    const before = Date.now();
    setDisplayName('Paul');
    expect(getDisplayNameSetAt()).toBeGreaterThanOrEqual(before);
  });

  test('saving the same name again keeps its time', async () => {
    const { getDisplayNameSetAt, setDisplayName } = await import('./identity.js');
    setDisplayName('Paul', { setAt: 1000 });
    setDisplayName('Paul');
    expect(getDisplayNameSetAt()).toBe(1000);
  });

  test('a browser from before the time was kept counts its own name as chosen, oldest', async () => {
    const { getClientId, getDisplayName, getDisplayNameSetAt } = await import('./identity.js');
    getClientId();
    store.set('marginalia.displayName', 'Paul');
    expect(getDisplayNameSetAt()).toBe(0);
    // ...and the name it made up for itself as not chosen at all.
    store.delete('marginalia.displayName');
    getDisplayName();
    store.delete('marginalia.displayNameSetAt');
    expect(getDisplayNameSetAt()).toBeNull();
  });

  test('an empty name falls back to the made-up one, undated', async () => {
    const { getDisplayNameSetAt, setDisplayName } = await import('./identity.js');
    setDisplayName('Paul');
    setDisplayName('  ');
    expect(getDisplayNameSetAt()).toBeNull();
  });

  test('requests carry the time only for a chosen name', async () => {
    const { claimInvite } = await import('./api.js');
    const { getDisplayName, setDisplayName } = await import('./identity.js');
    getDisplayName();
    const sent = stubFetch([
      { status: 200, body: { role: 'reader' } },
      { status: 200, body: { role: 'reader' } },
    ]);
    await claimInvite('doc', 'tok');
    expect(sent[0]!.headers.get('x-marginalia-name-set-at')).toBeNull();
    setDisplayName('Paul', { setAt: 1234 });
    await claimInvite('doc', 'tok');
    expect(sent[1]!.headers.get('x-marginalia-name-set-at')).toBe('1234');
  });
});

describe('the name gate', () => {
  test('a refused write waits for a name, then is sent once more with it', async () => {
    const api = await import('./api.js');
    const { getDisplayName, setDisplayName } = await import('./identity.js');
    getDisplayName();
    const sent = stubFetch([
      { status: 409, body: { error: 'display-name-required' } },
      { status: 200, body: { role: 'collaborator' } },
    ]);
    window.addEventListener(api.NAME_REQUIRED_EVENT, (e) => {
      const { docUid } = (e as CustomEvent<{ docUid: string }>).detail;
      setDisplayName('Paul', { setAt: 5000 });
      api.notifyNameResolved(docUid);
    });
    const placeholder = getDisplayName();
    const res = await api.claimInvite('doc', 'tok');
    expect(res.role).toBe('collaborator');
    expect(sent).toHaveLength(2);
    expect(decodeURIComponent(sent[0]!.headers.get('x-marginalia-client-name') ?? '')).toBe(
      placeholder,
    );
    expect(sent[1]!.headers.get('x-marginalia-client-name')).toBe('Paul');
    expect(sent[1]!.headers.get('x-marginalia-name-set-at')).toBe('5000');
  });

  test('dismissing the dialog rejects the write', async () => {
    const api = await import('./api.js');
    stubFetch([{ status: 409, body: { error: 'display-name-required' } }]);
    window.addEventListener(api.NAME_REQUIRED_EVENT, (e) => {
      api.notifyNameCancelled((e as CustomEvent<{ docUid: string }>).detail.docUid);
    });
    await expect(api.claimInvite('doc', 'tok')).rejects.toMatchObject({
      code: 'display-name-required',
    });
  });
});

describe('opening a link from the address bar', () => {
  test('a group link keeps the personal link it answers with, never itself', async () => {
    const { openInviteLink } = await import('./invite-link.js');
    const { loadInviteToken, pendingInviteClaim } = await import('./invite.js');
    store.set('marginalia.invite.doc', 'held');
    const sent = stubFetch([{ status: 201, body: { token: 'personal', role: 'collaborator' } }]);
    const outcome = openInviteLink('doc', 'group');
    expect(pendingInviteClaim('doc')).toBeDefined();
    expect(await outcome).toEqual({ kind: 'personal', token: 'personal', reused: false });
    expect(sent[0]!.body).toEqual({ held_token: 'held' });
    expect(loadInviteToken('doc')).toBe('personal');
  });

  test('opening the same link twice at once claims it once', async () => {
    const { openInviteLink } = await import('./invite-link.js');
    const sent = stubFetch([{ status: 201, body: { token: 'personal', role: 'collaborator' } }]);
    const [a, b] = await Promise.all([
      openInviteLink('doc-twice', 'group'),
      openInviteLink('doc-twice', 'group'),
    ]);
    expect(sent).toHaveLength(1);
    expect(a).toEqual(b);
  });

  test('a refused group link leaves what the browser held', async () => {
    const { openInviteLink } = await import('./invite-link.js');
    const { loadInviteToken } = await import('./invite.js');
    store.set('marginalia.invite.doc', 'held');
    stubFetch([{ status: 410, body: { error: 'group-link-off' } }]);
    expect(await openInviteLink('doc', 'group')).toEqual({
      kind: 'refused',
      code: 'group-link-off',
    });
    expect(loadInviteToken('doc')).toBe('held');
  });

  test('an ordinary link is kept as it is, claimable or not', async () => {
    const { openInviteLink } = await import('./invite-link.js');
    const { loadInviteToken } = await import('./invite.js');
    stubFetch([{ status: 201, body: { role: 'collaborator', display_name: 'Bob' } }]);
    expect(await openInviteLink('doc', 'named')).toEqual({ kind: 'plain' });
    expect(loadInviteToken('doc')).toBe('named');

    stubFetch([{ status: 400, body: { error: 'admin-invite-not-claimable' } }]);
    expect(await openInviteLink('doc2', 'admin')).toEqual({ kind: 'plain' });
    expect(loadInviteToken('doc2')).toBe('admin');
  });
});
