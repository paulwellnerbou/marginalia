import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER, SESSION_COOKIE } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const CLIENT_A = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const CLIENT_B = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Bob' };
const CLIENT_C = { id: 'cccccccccccccccccccc', name: 'Carol' };

function headersFor(
  client: { id: string; name: string },
  extra: Record<string, string> = {},
): Headers {
  return new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: client.id,
    [CLIENT_NAME_HEADER]: client.name,
    ...extra,
  });
}

function withInvite(h: Headers, token: string): Headers {
  const n = new Headers(h);
  n.set(INVITE_HEADER, token);
  return n;
}

interface CreateResponse {
  uid: string;
  admin_invite: { token: string; url: string; display_name: string };
  password?: string;
}

describe('documents API', () => {
  let dir: string;
  let webDir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-srv-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-web-'));
    writeFileSync(
      join(webDir, 'index.html'),
      '<!doctype html><title>Marginalia</title><div id="root"></div>',
    );
    writeFileSync(join(webDir, 'app.js'), 'console.log("ok");');
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir }));
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  async function upload(
    client: typeof CLIENT_A,
    body: Record<string, unknown> = { markdown: '# Hi' },
  ): Promise<CreateResponse> {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headersFor(client),
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as CreateResponse;
  }

  test('upload returns an admin invite URL; admin access via that invite', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Original\n\nBody.' });
    expect(created.uid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.admin_invite.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.admin_invite.url).toBe(`/d/${created.uid}/${created.admin_invite.token}`);
    expect(created.admin_invite.display_name).toBe('Alice');

    // With the admin invite header, Bob sees the doc as admin and as Alice.
    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), created.admin_invite.token),
      }),
    );
    expect(getRes.status).toBe(200);
    const doc = (await getRes.json()) as { role: string; display_name: string };
    expect(doc.role).toBe('admin');
    expect(doc.display_name).toBe('Alice');
  });

  test('non-public doc: stranger without invite → 401; with editor invite → editable', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi', password_protected: true });

    // Bob without invite or password → 401
    const denied = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(denied.status).toBe(401);

    // Alice (admin via invite) creates an editor invite for Bob
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'editor' }),
      }),
    );
    expect(mkRes.status).toBe(201);
    const { invite } = (await mkRes.json()) as {
      invite: { token: string; role: string; display_name: string; url: string };
    };
    expect(invite.role).toBe('editor');
    expect(invite.url).toBe(`/d/${created.uid}/${invite.token}`);

    // Bob opens the doc via his invite → editor, name forced to Bob
    const bobView = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor({ id: CLIENT_B.id, name: 'whatever' }), invite.token),
      }),
    );
    expect(bobView.status).toBe(200);
    const bobDoc = (await bobView.json()) as { role: string; display_name: string };
    expect(bobDoc.role).toBe('editor');
    expect(bobDoc.display_name).toBe('Bob');

    // Bob can edit (editor role) — and the git author is "Bob" from the invite.
    const bobEdit = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor({ id: CLIENT_B.id, name: 'whatever' }), invite.token),
        body: JSON.stringify({ markdown: '# Hi\n\nBob was here.\n' }),
      }),
    );
    expect(bobEdit.status).toBe(200);
  });

  test('reader invite cannot edit', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Oli', role: 'reader' }),
      }),
    );
    const { invite } = (await mkRes.json()) as { invite: { token: string } };

    const oliEdit = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor(CLIENT_C), invite.token),
        body: JSON.stringify({ markdown: '# Changed' }),
      }),
    );
    expect(oliEdit.status).toBe(403);
  });

  test('public doc is readable without invite', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Public' });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { role: string };
    expect(doc.role).toBe('reader');
  });

  test('editable_by_anyone grants editor to stranger with no invite', async () => {
    const created = await upload(CLIENT_A, { markdown: '# X', editable_by_anyone: true });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: headersFor(CLIENT_B),
        body: JSON.stringify({ markdown: '# Edited by B' }),
      }),
    );
    expect(res.status).toBe(200);
  });

  test('non-admin invite cannot create more invites', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'editor' }),
      }),
    );
    const { invite } = (await mkRes.json()) as { invite: { token: string } };

    const bobInviteAttempt = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_B), invite.token),
        body: JSON.stringify({ display_name: 'Mallory', role: 'admin' }),
      }),
    );
    expect(bobInviteAttempt.status).toBe(403);
  });

  test('admin lists invites; can revoke a non-admin invite; last admin invite is protected', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'editor' }),
      }),
    );
    const { invite: bob } = (await mkRes.json()) as { invite: { token: string } };

    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    const { invites } = (await listRes.json()) as {
      invites: Array<{ token: string; role: string; display_name: string }>;
    };
    expect(invites.map((i) => i.role).sort()).toEqual(['admin', 'editor']);
    expect(invites.some((i) => i.token === bob.token)).toBe(true);

    // Revoke Bob's invite → 204
    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites/${bob.token}`, {
        method: 'DELETE',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(del.status).toBe(204);

    // Now Bob's invite no longer works
    const bobView = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), bob.token),
      }),
    );
    // The invite is gone so the header is ignored; doc is public → reader.
    const role = ((await bobView.json()) as { role: string }).role;
    expect(role).toBe('reader');

    // Revoking the last admin invite is refused
    const killAdmin = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/invites/${created.admin_invite.token}`,
        {
          method: 'DELETE',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        },
      ),
    );
    expect(killAdmin.status).toBe(400);
  });

  test('password-protected docs: invite bypasses the password; no-invite needs session', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Secret',
      password_protected: true,
    });
    expect(created.password).toBeString();

    // Invite grants access without password
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);

    // No invite, no session → 401
    const denied = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(denied.status).toBe(401);

    // With the password, /auth grants a session cookie
    const authRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/auth`, {
        method: 'POST',
        headers: headersFor(CLIENT_B),
        body: JSON.stringify({ password: created.password }),
      }),
    );
    expect(authRes.status).toBe(204);
    const setCookie = authRes.headers.get('set-cookie');
    expect(setCookie).toBeString();
    if (!setCookie) throw new Error('missing set-cookie header');
    const token = setCookie.split(';')[0]?.split('=')[1];
    expect(token).toBeString();
    if (!token) throw new Error('missing session token');

    const afterAuth = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: headersFor(CLIENT_B, { cookie: `${SESSION_COOKIE}=${token}` }),
      }),
    );
    expect(afterAuth.status).toBe(200);
  });

  test('missing identity header is a 400 on upload', async () => {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown: '# Hi' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test('GET on unknown UID returns 404', async () => {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents/nonsense-uid', { headers: headersFor(CLIENT_A) }),
    );
    expect(res.status).toBe(404);
  });

  test('health endpoint', async () => {
    const res = await app.hono.fetch(new Request('http://test/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('PATCH settings: admin-only, updates flags, rotates password', async () => {
    const created = await upload(CLIENT_A);

    // Bob (no invite) → 403 (he's a reader, not admin)
    const forbid = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: headersFor(CLIENT_B),
        body: JSON.stringify({ editable_by_anyone: true }),
      }),
    );
    expect(forbid.status).toBe(403);

    // Alice (admin via invite) updates
    const r1 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ editable_by_anyone: true, default_theme: 'book' }),
      }),
    );
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as {
      editable_by_anyone: boolean;
      default_theme: string;
    };
    expect(j1.editable_by_anyone).toBe(true);
    expect(j1.default_theme).toBe('book');

    const r2 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ password: 'rotate' }),
      }),
    );
    expect(r2.status).toBe(200);
    const j2 = (await r2.json()) as { password_protected: boolean; password?: string };
    expect(j2.password_protected).toBe(true);
    expect(j2.password).toBeString();
  });

  test('serves the built SPA and falls back to index.html for document routes', async () => {
    const assetRes = await app.hono.fetch(new Request('http://test/app.js'));
    expect(assetRes.status).toBe(200);
    expect(await assetRes.text()).toContain('console.log');

    const spaRes = await app.hono.fetch(new Request('http://test/d/example-token/edit'));
    expect(spaRes.status).toBe(200);
    expect(spaRes.headers.get('content-type')).toContain('text/html');
    expect(await spaRes.text()).toContain('<div id="root"></div>');
  });
});
