import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import {
  CLIENT_HEADER,
  CLIENT_NAME_HEADER,
  INVITE_HEADER,
  INVITE_SESSION_COOKIE,
  SESSION_COOKIE,
} from '../src/auth.js';
import { loadConfig, type ServerConfig } from '../src/config.js';
import { NAME_SET_AT_HEADER } from '../src/group-links.js';
import { KEYRING_HEADER } from '../src/routes/keyrings.js';
import { listDocUserNames } from '../src/users.js';

const ADMIN = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const VISITOR = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Amber Fox' };
const VISITOR_PHONE = { id: 'cccccccccccccccccccc', name: 'Coral Heron' };
const OTHER = { id: 'dddddddddddddddddddd', name: 'Dapper Lynx' };

type Client = { id: string; name: string };

interface Call {
  status: number;
  json: Record<string, unknown>;
  cookie: string;
}

interface InviteWire {
  token: string;
  kind: string;
  role: string;
  display_name: string | null;
  source_token: string | null;
  name_provisional: boolean;
  name_set_at: number | null;
  enabled: boolean | null;
  last_used_at: number | null;
  previous_names: string[];
}

describe('group links', () => {
  let dir: string;
  let app: App;

  async function boot(overrides: Partial<ServerConfig> = {}) {
    if (app) await app.close();
    app = await createApp(loadConfig({ dataDir: dir, port: 0, ...overrides }));
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-group-'));
    await boot();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function headers(
    client: Client,
    opts: { token?: string; setAt?: number; cookie?: string; extra?: Record<string, string> } = {},
  ): Headers {
    const h = new Headers({
      'content-type': 'application/json',
      [CLIENT_HEADER]: client.id,
      [CLIENT_NAME_HEADER]: encodeURIComponent(client.name),
      ...opts.extra,
    });
    if (opts.token) h.set(INVITE_HEADER, opts.token);
    if (opts.setAt !== undefined) h.set(NAME_SET_AT_HEADER, String(opts.setAt));
    if (opts.cookie) h.set('cookie', opts.cookie);
    return h;
  }

  async function call(
    path: string,
    init: { method?: string; headers: Headers; body?: unknown },
  ): Promise<Call> {
    const res = await app.hono.fetch(
      new Request(`http://test${path}`, {
        method: init.method ?? 'GET',
        headers: init.headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    );
    const text = await res.text();
    const json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return { status: res.status, json, cookie };
  }

  async function upload(
    body: Record<string, unknown> = {},
  ): Promise<{ uid: string; admin: string; password?: string }> {
    const res = await call('/api/documents', {
      method: 'POST',
      headers: headers(ADMIN),
      body: { markdown: '# Doc\n\nHello world.\n', ...body },
    });
    expect(res.status).toBe(201);
    const j = res.json as { uid: string; admin_invite: { token: string }; password?: string };
    return {
      uid: j.uid,
      admin: j.admin_invite.token,
      ...(j.password ? { password: j.password } : {}),
    };
  }

  async function createInvite(
    uid: string,
    admin: string,
    body: Record<string, unknown>,
    cookie?: string,
  ): Promise<InviteWire> {
    const res = await call(`/api/documents/${uid}/invites`, {
      method: 'POST',
      headers: headers(ADMIN, { token: admin, ...(cookie ? { cookie } : {}) }),
      body,
    });
    expect(res.status).toBe(201);
    return res.json.invite as InviteWire;
  }

  function createGroup(uid: string, admin: string, role = 'collaborator', cookie?: string) {
    return createInvite(uid, admin, { kind: 'group', role }, cookie);
  }

  function claim(
    uid: string,
    token: string,
    client: Client,
    opts: { held?: string; setAt?: number; cookie?: string } = {},
  ): Promise<Call> {
    return call(`/api/documents/${uid}/invites/${token}/claim`, {
      method: 'POST',
      headers: headers(client, {
        ...(opts.setAt !== undefined ? { setAt: opts.setAt } : {}),
        ...(opts.cookie ? { cookie: opts.cookie } : {}),
      }),
      body: opts.held ? { held_token: opts.held } : {},
    });
  }

  async function mint(uid: string, group: string, client: Client, setAt?: number) {
    const res = await claim(uid, group, client, setAt !== undefined ? { setAt } : {});
    expect(res.status).toBe(201);
    return res.json as { token: string; role: string; name_provisional: boolean };
  }

  function getDoc(uid: string, client: Client, token?: string, setAt?: number, cookie?: string) {
    return call(`/api/documents/${uid}`, {
      headers: headers(client, {
        ...(token ? { token } : {}),
        ...(setAt !== undefined ? { setAt } : {}),
        ...(cookie ? { cookie } : {}),
      }),
    });
  }

  async function listInvites(uid: string, admin: string): Promise<InviteWire[]> {
    const res = await call(`/api/documents/${uid}/invites`, {
      headers: headers(ADMIN, { token: admin }),
    });
    expect(res.status).toBe(200);
    return res.json.invites as InviteWire[];
  }

  async function personal(uid: string, admin: string, token: string): Promise<InviteWire> {
    const found = (await listInvites(uid, admin)).find((i) => i.token === token);
    expect(found).toBeDefined();
    return found!;
  }

  async function firstBlockId(uid: string, admin: string): Promise<string> {
    const res = await getDoc(uid, ADMIN, admin);
    return (res.json.rendered as { blocks: Array<{ id: string }> }).blocks[0]!.id;
  }

  function postThread(
    uid: string,
    client: Client,
    token: string,
    blockId: string,
    extra: Record<string, unknown> = {},
    setAt?: number,
  ) {
    return call(`/api/documents/${uid}/threads`, {
      method: 'POST',
      headers: headers(client, { token, ...(setAt !== undefined ? { setAt } : {}) }),
      body: { anchor: { block_id: blockId, quote: 'Doc' }, body: 'A thought', ...extra },
    });
  }

  test('the group token alone opens nothing on an invite-only document', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    expect(group.kind).toBe('group');
    expect(group.display_name).toBeNull();
    expect(group.enabled).toBe(true);

    const res = await getDoc(doc.uid, OTHER, group.token);
    expect(res.status).toBe(401);
    expect(res.json.error).toBe('invite-required');
  });

  test('the group token alone is no more than a stranger on a public document', async () => {
    const doc = await upload({ invite_only: false });
    const group = await createGroup(doc.uid, doc.admin);
    const res = await getDoc(doc.uid, OTHER, group.token);
    expect(res.status).toBe(200);
    expect(res.json.role).toBe('reader');
  });

  test('opening mints a personal link with the group role and a placeholder name', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);

    const res = await claim(doc.uid, group.token, VISITOR);
    expect(res.status).toBe(201);
    expect(res.cookie).toMatch(new RegExp(`^${INVITE_SESSION_COOKIE}=`));
    const minted = res.json as {
      token: string;
      role: string;
      name_provisional: boolean;
      reused: boolean;
    };
    expect(minted.token).not.toBe(group.token);
    expect(minted.role).toBe('collaborator');
    expect(minted.name_provisional).toBe(true);
    expect(minted.reused).toBe(false);

    const opened = await getDoc(doc.uid, VISITOR, minted.token);
    expect(opened.status).toBe(200);
    expect(opened.json.role).toBe('collaborator');
    expect(opened.json.display_name).toBe('Amber Fox');
    expect(opened.json.name_provisional).toBe(true);

    const row = await personal(doc.uid, doc.admin, minted.token);
    expect(row.kind).toBe('named');
    expect(row.source_token).toBe(group.token);
    expect(row.name_provisional).toBe(true);
    expect(row.last_used_at).toBeNumber();
  });

  test('a dated name mints a personal link that is not provisional', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    const minted = await mint(doc.uid, group.token, { ...VISITOR, name: 'Paul' }, 1000);
    expect(minted.name_provisional).toBe(false);
    const row = await personal(doc.uid, doc.admin, minted.token);
    expect(row.display_name).toBe('Paul');
    expect(row.name_set_at).toBe(1000);
  });

  test('a browser that already holds a good enough link keeps it', async () => {
    const doc = await upload();
    const other = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    const minted = await mint(doc.uid, group.token, VISITOR);

    const again = await claim(doc.uid, group.token, VISITOR, { held: minted.token });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ token: minted.token, reused: true });

    // The admin opening their own group link stays admin.
    const admin = await claim(doc.uid, group.token, ADMIN, { held: doc.admin });
    expect(admin.json).toMatchObject({ token: doc.admin, role: 'admin', reused: true });

    // A demoted personal link from this group link stays what it is.
    const patched = await call(`/api/documents/${doc.uid}/invites/${minted.token}`, {
      method: 'PATCH',
      headers: headers(ADMIN, { token: doc.admin }),
      body: { role: 'reader' },
    });
    expect(patched.status).toBe(200);
    const demoted = await claim(doc.uid, group.token, VISITOR, { held: minted.token });
    expect(demoted.json).toMatchObject({ token: minted.token, role: 'reader', reused: true });

    // A lesser link from elsewhere is replaced by a fresh personal link.
    const reader = await createInvite(doc.uid, doc.admin, {
      kind: 'named',
      role: 'reader',
      display_name: 'Someone',
    });
    const upgraded = await claim(doc.uid, group.token, OTHER, { held: reader.token });
    expect(upgraded.status).toBe(201);
    expect(upgraded.json.token).not.toBe(reader.token);

    // Another document's token is no reason to skip minting.
    const foreign = await claim(doc.uid, group.token, OTHER, { held: other.admin });
    expect(foreign.status).toBe(201);
  });

  test('a browser that lost its stored token is known by its session cookie', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    const first = await claim(doc.uid, group.token, VISITOR);
    const token = (first.json as { token: string }).token;
    const again = await claim(doc.uid, group.token, VISITOR, { cookie: first.cookie });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ token, reused: true });
    expect((await listInvites(doc.uid, doc.admin)).filter((i) => i.source_token)).toHaveLength(1);
  });

  test('turning the link off stops minting but keeps personal links working', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    const minted = await mint(doc.uid, group.token, VISITOR);

    const off = await call(`/api/documents/${doc.uid}/invites/${group.token}`, {
      method: 'PATCH',
      headers: headers(ADMIN, { token: doc.admin }),
      body: { enabled: false },
    });
    expect(off.status).toBe(200);
    expect((off.json.invite as InviteWire).enabled).toBe(false);

    expect((await claim(doc.uid, group.token, OTHER)).status).toBe(410);
    expect((await claim(doc.uid, group.token, OTHER)).json.error).toBe('group-link-off');
    // Reopening the mail in the browser that holds its personal link still works.
    expect((await claim(doc.uid, group.token, VISITOR, { held: minted.token })).status).toBe(200);
    expect((await getDoc(doc.uid, VISITOR, minted.token)).status).toBe(200);

    const on = await call(`/api/documents/${doc.uid}/invites/${group.token}`, {
      method: 'PATCH',
      headers: headers(ADMIN, { token: doc.admin }),
      body: { enabled: true },
    });
    expect((on.json.invite as InviteWire).enabled).toBe(true);
    expect((await claim(doc.uid, group.token, OTHER)).status).toBe(201);
  });

  test('on/off is only for group links', async () => {
    const doc = await upload();
    const named = await createInvite(doc.uid, doc.admin, {
      kind: 'named',
      role: 'reader',
      display_name: 'Someone',
    });
    const res = await call(`/api/documents/${doc.uid}/invites/${named.token}`, {
      method: 'PATCH',
      headers: headers(ADMIN, { token: doc.admin }),
      body: { enabled: false },
    });
    expect(res.status).toBe(400);
  });

  test('a new role applies to personal links minted afterwards only', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin, 'reader');
    const before = await mint(doc.uid, group.token, VISITOR);
    await call(`/api/documents/${doc.uid}/invites/${group.token}`, {
      method: 'PATCH',
      headers: headers(ADMIN, { token: doc.admin }),
      body: { role: 'editor' },
    });
    const after = await mint(doc.uid, group.token, OTHER);
    expect((await getDoc(doc.uid, VISITOR, before.token)).json.role).toBe('reader');
    expect((await getDoc(doc.uid, OTHER, after.token)).json.role).toBe('editor');
  });

  test('revoke all ends the group link, its personal links and their sessions', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    const claimed = await claim(doc.uid, group.token, VISITOR);
    const token = (claimed.json as { token: string }).token;
    const other = await mint(doc.uid, group.token, OTHER);

    const res = await call(`/api/documents/${doc.uid}/invites/${group.token}`, {
      method: 'DELETE',
      headers: headers(ADMIN, { token: doc.admin }),
    });
    expect(res.status).toBe(204);

    expect((await getDoc(doc.uid, VISITOR, token)).status).toBe(401);
    expect((await getDoc(doc.uid, OTHER, other.token)).status).toBe(401);
    expect((await getDoc(doc.uid, VISITOR, undefined, undefined, claimed.cookie)).status).toBe(401);
    expect((await claim(doc.uid, group.token, OTHER)).status).toBe(404);
    const left = await listInvites(doc.uid, doc.admin);
    expect(left.map((i) => i.kind)).toEqual(['admin']);
    const history = app.db
      .prepare('SELECT COUNT(*) AS n FROM invite_names WHERE doc_uid = ?')
      .get(doc.uid) as { n: number };
    expect(history.n).toBe(0);
  });

  test('revoking one personal link leaves the group link and the others', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    const one = await mint(doc.uid, group.token, VISITOR);
    const two = await mint(doc.uid, group.token, OTHER);
    const res = await call(`/api/documents/${doc.uid}/invites/${one.token}`, {
      method: 'DELETE',
      headers: headers(ADMIN, { token: doc.admin }),
    });
    expect(res.status).toBe(204);
    expect((await getDoc(doc.uid, VISITOR, one.token)).status).toBe(401);
    expect((await getDoc(doc.uid, OTHER, two.token)).status).toBe(200);
    expect((await claim(doc.uid, group.token, VISITOR)).status).toBe(201);
  });

  describe('the name gate', () => {
    test('a placeholder name may read, bookmark and keep private notes, nothing more', async () => {
      const doc = await upload();
      const group = await createGroup(doc.uid, doc.admin);
      const minted = await mint(doc.uid, group.token, VISITOR);
      const blockId = await firstBlockId(doc.uid, doc.admin);

      const visible = await postThread(doc.uid, VISITOR, minted.token, blockId);
      expect(visible.status).toBe(409);
      expect(visible.json.error).toBe('display-name-required');

      const proposal = await postThread(doc.uid, VISITOR, minted.token, blockId, {
        body: undefined,
        proposal: { proposed_text: '# Better doc' },
      });
      expect(proposal.json.error).toBe('display-name-required');

      const hidden = await postThread(doc.uid, VISITOR, minted.token, blockId, { hidden: true });
      expect(hidden.status).toBe(201);
      const bookmark = await postThread(doc.uid, VISITOR, minted.token, blockId, {
        body: undefined,
        bookmark: true,
      });
      expect(bookmark.status).toBe(201);

      // Making the private note public is gated like posting it.
      const hiddenId = (hidden.json.thread as { id: string }).id;
      const unhide = await call(`/api/documents/${doc.uid}/threads/${hiddenId}`, {
        method: 'PATCH',
        headers: headers(VISITOR, { token: minted.token }),
        body: { hidden: false },
      });
      expect(unhide.json.error).toBe('display-name-required');
      // Replying in one's own private thread is still private.
      const ownReply = await call(`/api/documents/${doc.uid}/threads/${hiddenId}/respond`, {
        method: 'POST',
        headers: headers(VISITOR, { token: minted.token }),
        body: { body: 'note to self' },
      });
      expect(ownReply.status).toBe(200);

      // Replying and reacting in a visible thread are gated.
      const adminThread = await postThread(doc.uid, ADMIN, doc.admin, blockId);
      expect(adminThread.status).toBe(201);
      const thread = adminThread.json.thread as { id: string; comments: Array<{ id: string }> };
      const reply = await call(`/api/documents/${doc.uid}/threads/${thread.id}/respond`, {
        method: 'POST',
        headers: headers(VISITOR, { token: minted.token }),
        body: { body: 'Agreed' },
      });
      expect(reply.json.error).toBe('display-name-required');
      const react = await call(
        `/api/documents/${doc.uid}/threads/${thread.id}/comments/${thread.comments[0]!.id}/reactions`,
        {
          method: 'POST',
          headers: headers(VISITOR, { token: minted.token }),
          body: { emoji: '👍' },
        },
      );
      expect(react.json.error).toBe('display-name-required');
    });

    test('a chosen name opens the gate, renames the link and records the placeholder', async () => {
      const doc = await upload();
      const group = await createGroup(doc.uid, doc.admin);
      const minted = await mint(doc.uid, group.token, VISITOR);
      const blockId = await firstBlockId(doc.uid, doc.admin);

      const res = await postThread(
        doc.uid,
        { ...VISITOR, name: 'Paul' },
        minted.token,
        blockId,
        {},
        5000,
      );
      expect(res.status).toBe(201);
      const thread = res.json.thread as { comments: Array<{ author: { display_name: string } }> };
      expect(thread.comments[0]!.author.display_name).toBe('Paul');

      const row = await personal(doc.uid, doc.admin, minted.token);
      expect(row.display_name).toBe('Paul');
      expect(row.name_provisional).toBe(false);
      expect(row.name_set_at).toBe(5000);
      expect(row.previous_names).toEqual(['Amber Fox']);
    });

    test('a reader is refused for its role, not asked for a name', async () => {
      const doc = await upload();
      const group = await createGroup(doc.uid, doc.admin, 'reader');
      const minted = await mint(doc.uid, group.token, VISITOR);
      const blockId = await firstBlockId(doc.uid, doc.admin);
      const res = await postThread(doc.uid, VISITOR, minted.token, blockId);
      expect(res.status).toBe(403);
      expect(res.json.error).toBe('forbidden');
    });

    test('keeping the placeholder on purpose is no previous name', async () => {
      const doc = await upload();
      const group = await createGroup(doc.uid, doc.admin);
      const minted = await mint(doc.uid, group.token, VISITOR);
      await getDoc(doc.uid, VISITOR, minted.token, 4000);
      const row = await personal(doc.uid, doc.admin, minted.token);
      expect(row.name_provisional).toBe(false);
      expect(row.display_name).toBe('Amber Fox');
      expect(row.previous_names).toEqual([]);
    });

    test('an undated name never lifts the placeholder', async () => {
      const doc = await upload();
      const group = await createGroup(doc.uid, doc.admin);
      const minted = await mint(doc.uid, group.token, VISITOR);
      const blockId = await firstBlockId(doc.uid, doc.admin);
      const res = await postThread(doc.uid, { ...VISITOR, name: 'Paul' }, minted.token, blockId);
      expect(res.json.error).toBe('display-name-required');
      expect((await personal(doc.uid, doc.admin, minted.token)).display_name).toBe('Amber Fox');
    });

    test('a group link is not a way around the gate for ordinary links', async () => {
      const doc = await upload();
      const named = await createInvite(doc.uid, doc.admin, {
        kind: 'named',
        role: 'collaborator',
        display_name: 'Bob',
      });
      const blockId = await firstBlockId(doc.uid, doc.admin);
      const res = await postThread(doc.uid, OTHER, named.token, blockId);
      expect(res.status).toBe(201);
    });
  });

  describe('names across devices', () => {
    test('the newest chosen name wins and an older device adopts it', async () => {
      const doc = await upload();
      const group = await createGroup(doc.uid, doc.admin);
      const minted = await mint(doc.uid, group.token, { ...VISITOR, name: 'Paul' }, 1000);

      // The phone still has an older name: the link's name stands.
      const stale = await getDoc(doc.uid, { ...VISITOR_PHONE, name: 'P.' }, minted.token, 500);
      expect(stale.json.display_name).toBe('Paul');
      expect(stale.json.name_set_at).toBe(1000);

      // An undated generated name on the phone signs as the link's name too.
      const generated = await getDoc(doc.uid, VISITOR_PHONE, minted.token);
      expect(generated.json.display_name).toBe('Paul');

      // A newer name from the phone renames the person.
      const renamed = await getDoc(
        doc.uid,
        { ...VISITOR_PHONE, name: 'Paul W.' },
        minted.token,
        2000,
      );
      expect(renamed.json.display_name).toBe('Paul W.');
      const back = await getDoc(doc.uid, { ...VISITOR, name: 'Paul' }, minted.token, 1000);
      expect(back.json.display_name).toBe('Paul W.');

      const row = await personal(doc.uid, doc.admin, minted.token);
      expect(row.previous_names).toEqual(['Paul']);
    });

    test('a time from the future is clamped to now', async () => {
      const doc = await upload();
      const group = await createGroup(doc.uid, doc.admin);
      const minted = await mint(doc.uid, group.token, VISITOR);
      const future = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
      await getDoc(doc.uid, { ...VISITOR, name: 'Paul' }, minted.token, future);
      const row = await personal(doc.uid, doc.admin, minted.token);
      expect(row.name_set_at).toBeLessThanOrEqual(Date.now());
      // So a later honest rename still wins. The pause keeps it from landing
      // in the very millisecond the clamped time was taken.
      await Bun.sleep(5);
      await getDoc(doc.uid, { ...VISITOR, name: 'Paula' }, minted.token, Date.now() + 1);
      expect((await personal(doc.uid, doc.admin, minted.token)).display_name).toBe('Paula');
    });

    test('a claimed session reads the live name, not its claim-time snapshot', async () => {
      const doc = await upload();
      const group = await createGroup(doc.uid, doc.admin);
      const claimed = await claim(doc.uid, group.token, VISITOR);
      const token = (claimed.json as { token: string }).token;
      await getDoc(doc.uid, { ...VISITOR, name: 'Paul' }, token, 3000);

      const viaCookie = await getDoc(doc.uid, VISITOR, undefined, undefined, claimed.cookie);
      expect(viaCookie.status).toBe(200);
      expect(viaCookie.json.display_name).toBe('Paul');
      expect(viaCookie.json.name_provisional).toBe(false);
    });

    test('name history keeps the newest twenty', async () => {
      const doc = await upload();
      const group = await createGroup(doc.uid, doc.admin);
      const minted = await mint(doc.uid, group.token, VISITOR);
      for (let i = 1; i <= 25; i++) {
        await getDoc(doc.uid, { ...VISITOR, name: `Name ${i}` }, minted.token, i);
      }
      const rows = app.db
        .prepare('SELECT COUNT(*) AS n FROM invite_names WHERE invite_token = ?')
        .get(minted.token) as { n: number };
      expect(rows.n).toBe(20);
      const row = await personal(doc.uid, doc.admin, minted.token);
      expect(row.display_name).toBe('Name 25');
      expect(row.previous_names[0]).toBe('Name 24');
    });
  });

  test('password documents need the password before minting, and set no session', async () => {
    const doc = await upload({ password_protected: true });
    const login = await call(`/api/documents/${doc.uid}/auth`, {
      method: 'POST',
      headers: headers(ADMIN),
      body: { password: doc.password, remember: true },
    });
    expect(login.status).toBe(204);
    const adminCookie = login.cookie;
    const group = await createGroup(doc.uid, doc.admin, 'collaborator', adminCookie);

    const refused = await claim(doc.uid, group.token, VISITOR);
    expect(refused.status).toBe(401);
    expect(refused.json.error).toBe('password-required');

    const visitorLogin = await call(`/api/documents/${doc.uid}/auth`, {
      method: 'POST',
      headers: headers(VISITOR),
      body: { password: doc.password, remember: true },
    });
    expect(visitorLogin.cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    const res = await claim(doc.uid, group.token, VISITOR, { cookie: visitorLogin.cookie });
    expect(res.status).toBe(201);
    expect(res.cookie).toBe('');
    const token = (res.json as { token: string }).token;
    const opened = await getDoc(doc.uid, VISITOR, token, undefined, visitorLogin.cookie);
    expect(opened.json.role).toBe('collaborator');
  });

  test('minting is rate limited per client', async () => {
    await boot({ groupLinkMintPerClient: 2 });
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    expect((await claim(doc.uid, group.token, VISITOR)).status).toBe(201);
    expect((await claim(doc.uid, group.token, OTHER)).status).toBe(201);
    const third = await claim(doc.uid, group.token, VISITOR_PHONE);
    expect(third.status).toBe(429);
    expect(third.json.error).toBe('too-many-requests');
  });

  test('a group link hands out a bounded number of personal links', async () => {
    await boot({ groupLinkMaxPeople: 1 });
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    expect((await claim(doc.uid, group.token, VISITOR)).status).toBe(201);
    const full = await claim(doc.uid, group.token, OTHER);
    expect(full.status).toBe(409);
    expect(full.json.error).toBe('group-link-full');
  });

  test('claiming needs an identity', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    const res = await call(`/api/documents/${doc.uid}/invites/${group.token}/claim`, {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {},
    });
    expect(res.status).toBe(400);
  });

  test('placeholders are left out of mention suggestions', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    const minted = await mint(doc.uid, group.token, VISITOR);
    // Opening the document registers the visitor, placeholder and all.
    expect((await getDoc(doc.uid, VISITOR, minted.token)).status).toBe(200);
    await mint(doc.uid, group.token, { ...OTHER, name: 'Paul' }, 1000);
    const names = listDocUserNames(app.db, doc.uid);
    expect(names).toContain('Paul');
    expect(names).not.toContain('Amber Fox');
  });

  test('copying a document copies the group link, not its personal links', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    await mint(doc.uid, group.token, VISITOR);
    await call(`/api/documents/${doc.uid}/invites/${group.token}`, {
      method: 'PATCH',
      headers: headers(ADMIN, { token: doc.admin }),
      body: { enabled: false },
    });
    const res = await call(`/api/documents/${doc.uid}/copy`, {
      method: 'POST',
      headers: headers(ADMIN, { token: doc.admin }),
      body: { name: 'Copy', include_access: true },
    });
    expect(res.status).toBe(201);
    const copy = res.json as { uid: string; admin_invite: { token: string } };
    const invites = await listInvites(copy.uid, copy.admin_invite.token);
    const groups = invites.filter((i) => i.kind === 'group');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.token).not.toBe(group.token);
    expect(groups[0]!.enabled).toBe(false);
    expect(invites.filter((i) => i.source_token !== null)).toHaveLength(0);
  });

  test('a keyring keeps when its name was chosen', async () => {
    const created = await call('/api/keyrings', {
      method: 'POST',
      headers: headers({ ...VISITOR, name: 'Paul' }, { setAt: 1000 }),
      body: { docs: [] },
    });
    expect(created.json.display_name_set_at).toBe(1000);
    const ringToken = created.json.token as string;
    const ringHeaders = headers(VISITOR, { extra: { [KEYRING_HEADER]: ringToken } });
    const renamed = await call('/api/keyrings/self', {
      method: 'PATCH',
      headers: ringHeaders,
      body: { display_name: 'Paul W.', display_name_set_at: 2000 },
    });
    expect(renamed.json.display_name_set_at).toBe(2000);
    const pulled = await call('/api/keyrings/self', { headers: ringHeaders });
    expect(pulled.json).toMatchObject({ display_name: 'Paul W.', display_name_set_at: 2000 });
    // Undated: chosen now.
    const before = Date.now();
    const plain = await call('/api/keyrings/self', {
      method: 'PATCH',
      headers: ringHeaders,
      body: { display_name: 'Paula' },
    });
    expect(plain.json.display_name_set_at as number).toBeGreaterThanOrEqual(before);
  });

  test('a keyring refuses to store a group link', async () => {
    const doc = await upload();
    const group = await createGroup(doc.uid, doc.admin);
    const ring = await call('/api/keyrings', {
      method: 'POST',
      headers: headers(VISITOR),
      body: { docs: [{ doc_uid: doc.uid, invite_token: group.token }] },
    });
    expect(ring.status).toBe(201);
    const ringToken = ring.json.token as string;
    const pull = await call('/api/keyrings/self', {
      headers: headers(VISITOR, { extra: { [KEYRING_HEADER]: ringToken } }),
    });
    expect(pull.json.docs).toEqual([]);
    const put = await call(`/api/keyrings/self/docs/${doc.uid}`, {
      method: 'PUT',
      headers: headers(VISITOR, { extra: { [KEYRING_HEADER]: ringToken } }),
      body: { invite_token: group.token },
    });
    expect(put.status).toBe(400);
  });
});
