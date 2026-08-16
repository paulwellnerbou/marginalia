import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateAllBlocks } from '@marginalia/renderer';
import JSZip from 'jszip';
import { type App, createApp } from '../src/app.js';
import {
  CLIENT_HEADER,
  CLIENT_NAME_HEADER,
  INVITE_HEADER,
  INVITE_SESSION_COOKIE,
  SESSION_COOKIE,
} from '../src/auth.js';
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

/**
 * EPUB content documents are parsed as XML, so a reader aborts on a
 * chapter that isn't well-formed — a class of bug string assertions
 * can't see. `xmllint` ships with macOS and the Ubuntu CI image; where
 * it's absent the surrounding assertions still carry the test.
 */
function expectWellFormedXml(name: string, xml: string): void {
  const probe = spawnSync('xmllint', ['--noout', '-'], { input: xml, encoding: 'utf8' });
  if (probe.error) return;
  expect(`${name}: ${probe.stderr.trim()}`).toBe(`${name}: `);
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
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir, releaseVersion: '1a2b3c4' }));
  });

  afterEach(async () => {
    await app.close();
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
        // Documents are invite-only unless asked otherwise. Most cases here
        // are about roles, passwords or content and want an ordinary
        // readable document, so opt out unless the case says otherwise.
        body: JSON.stringify({ invite_only: false, ...body }),
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as CreateResponse;
  }

  async function authenticateForDoc(
    uid: string,
    password: string,
    client: { id: string; name: string },
    opts: { remember?: boolean } = {},
  ): Promise<string> {
    const authRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/auth`, {
        method: 'POST',
        headers: headersFor(client),
        body: JSON.stringify({ password, remember: opts.remember !== false }),
      }),
    );
    expect(authRes.status).toBe(204);
    const setCookie = authRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(SESSION_COOKIE);
    return setCookie.split(';')[0] ?? '';
  }

  async function claimInvite(
    uid: string,
    token: string,
    client: typeof CLIENT_A,
  ): Promise<{ status: number; cookie: string; body: unknown }> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/invites/${token}/claim`, {
        method: 'POST',
        headers: headersFor(client),
      }),
    );
    const setCookie = res.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';')[0] ?? '';
    return { status: res.status, cookie, body: await res.json() };
  }

  test('claim-invite: named invite sets invite-session cookie, not password-session cookie', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Doc\n\nPara.\n' });
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);

    // Create a named collaborator invite.
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'named', role: 'collaborator', display_name: 'Bob' }),
      }),
    );
    expect(mkRes.status).toBe(201);
    const { invite } = (await mkRes.json()) as { invite: { token: string } };

    // Claim the invite.
    const { status, cookie, body } = await claimInvite(created.uid, invite.token, CLIENT_B);
    expect(status).toBe(201);
    expect(cookie).toMatch(new RegExp(`^${INVITE_SESSION_COOKIE}=`));
    expect(cookie).not.toContain(SESSION_COOKIE + '=');
    expect((body as { role: string }).role).toBe('collaborator');
    expect((body as { display_name: string }).display_name).toBe('Bob');
  });

  test('claim-invite: session cookie grants access without the invite header', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Doc\n\nPara.\n' });
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);

    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'named', role: 'collaborator', display_name: 'Bob' }),
      }),
    );
    const { invite } = (await mkRes.json()) as { invite: { token: string } };

    const { cookie } = await claimInvite(created.uid, invite.token, CLIENT_B);
    expect(cookie).toMatch(new RegExp(`^${INVITE_SESSION_COOKIE}=`));

    // Access the doc using only the invite-session cookie (no invite header).
    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: new Headers({
          'content-type': 'application/json',
          [CLIENT_HEADER]: CLIENT_B.id,
          [CLIENT_NAME_HEADER]: CLIENT_B.name,
          cookie,
        }),
      }),
    );
    expect(getRes.status).toBe(200);
    const docBody = (await getRes.json()) as { role: string; display_name: string | null };
    expect(docBody.role).toBe('collaborator');
    expect(docBody.display_name).toBe('Bob');
  });

  test('claim-invite: admin invite token is not claimable (returns 400)', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Doc\n' });
    const { status } = await claimInvite(created.uid, created.admin_invite.token, CLIENT_B);
    expect(status).toBe(400);
  });

  test('claim-invite: password-protected doc returns 409', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Doc\n',
      password_protected: true,
    });
    expect(created.password).toBeString();

    // Authenticate to get a session cookie for admin operations.
    const aliceCookie = await authenticateForDoc(created.uid, created.password!, CLIENT_A);

    // Create a named invite (password-protected docs need both session + invite).
    const adminHeaders = withInvite(
      headersFor(CLIENT_A, { cookie: aliceCookie }),
      created.admin_invite.token,
    );
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'named', role: 'collaborator', display_name: 'Bob' }),
      }),
    );
    expect(mkRes.status).toBe(201);
    const { invite } = (await mkRes.json()) as { invite: { token: string } };

    // Claiming should return 409 because the doc is password-protected.
    const { status } = await claimInvite(created.uid, invite.token, CLIENT_B);
    expect(status).toBe(409);
  });

  test('claim-invite: invite-session cookie does NOT clobber password session', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Doc\n' });
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);

    // Mint a named invite on a non-password-protected doc.
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'named', role: 'collaborator', display_name: 'Bob' }),
      }),
    );
    const { invite } = (await mkRes.json()) as { invite: { token: string } };

    // Enable password after invite creation; the server generates the password.
    const settingsRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: adminHeaders,
        body: JSON.stringify({ password: 'rotate' }),
      }),
    );
    expect(settingsRes.status).toBe(200);
    const { password } = (await settingsRes.json()) as { password: string };

    // Authenticate with the generated password to get a SESSION_COOKIE.
    const pwCookie = await authenticateForDoc(created.uid, password, CLIENT_A);
    expect(pwCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));

    // Claiming the invite should 409 (password-protected), and the invite-session
    // cookie must not be set, ensuring the password session is not polluted.
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites/${invite.token}/claim`, {
        method: 'POST',
        headers: new Headers({
          'content-type': 'application/json',
          [CLIENT_HEADER]: CLIENT_B.id,
          [CLIENT_NAME_HEADER]: CLIENT_B.name,
          cookie: pwCookie,
        }),
      }),
    );
    expect(res.status).toBe(409);
    expect(res.headers.get('set-cookie') ?? '').not.toContain(SESSION_COOKIE + '=');

    // The original password session must still be valid.
    const checkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: new Headers({
          'content-type': 'application/json',
          [CLIENT_HEADER]: CLIENT_A.id,
          [CLIENT_NAME_HEADER]: CLIENT_A.name,
          cookie: pwCookie,
        }),
      }),
    );
    expect(checkRes.status).toBe(200);
  });

  test('claim-invite: admin invite header overrides an active invite session', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Doc\n\nPara.\n' });
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);

    // Mint a named reader invite and claim it.
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'named', role: 'reader', display_name: 'Bob' }),
      }),
    );
    const { invite } = (await mkRes.json()) as { invite: { token: string } };
    const { cookie } = await claimInvite(created.uid, invite.token, CLIENT_B);

    // With both the invite-session cookie and the admin invite header,
    // the admin invite should win (higher privilege).
    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: new Headers({
          'content-type': 'application/json',
          [CLIENT_HEADER]: CLIENT_B.id,
          [CLIENT_NAME_HEADER]: CLIENT_B.name,
          [INVITE_HEADER]: created.admin_invite.token,
          cookie,
        }),
      }),
    );
    expect(getRes.status).toBe(200);
    const docBody = (await getRes.json()) as { role: string };
    expect(docBody.role).toBe('admin');
  });

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

  test('admin invite display name tracks the current admin identity in invite listings and rotation', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Original\n\nBody.' });

    const primeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(primeRes.status).toBe(200);

    const renamedHeaders = withInvite(
      headersFor({ id: CLIENT_A.id, name: 'Alicia' }),
      created.admin_invite.token,
    );

    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        headers: renamedHeaders,
      }),
    );
    expect(listRes.status).toBe(200);
    const { invites } = (await listRes.json()) as {
      invites: Array<{ kind: string; display_name: string | null }>;
    };
    expect(invites.find((invite) => invite.kind === 'admin')?.display_name).toBe('Alicia');

    const rotateRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites/admin/rotate`, {
        method: 'POST',
        headers: renamedHeaders,
      }),
    );
    expect(rotateRes.status).toBe(200);
    const rotated = (await rotateRes.json()) as {
      admin_invite: { token: string; display_name: string };
    };
    expect(rotated.admin_invite.display_name).toBe('Alicia');

    const relistedRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        headers: withInvite(
          headersFor({ id: CLIENT_A.id, name: 'Alicia' }),
          rotated.admin_invite.token,
        ),
      }),
    );
    expect(relistedRes.status).toBe(200);
    const relisted = (await relistedRes.json()) as {
      invites: Array<{ kind: string; display_name: string | null }>;
    };
    expect(relisted.invites.find((invite) => invite.kind === 'admin')?.display_name).toBe('Alicia');
  });

  test('password-protected doc: invite AND password are both required', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi', password_protected: true });
    expect(created.password).toBeString();

    // No invite, no password → 401.
    const denied = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(denied.status).toBe(401);

    const aliceCookie = await authenticateForDoc(created.uid, created.password!, CLIENT_A);

    // Alice creates an editor invite for Bob.
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(
          headersFor(CLIENT_A, { cookie: aliceCookie }),
          created.admin_invite.token,
        ),
        body: JSON.stringify({ display_name: 'Bob', role: 'editor' }),
      }),
    );
    expect(mkRes.status).toBe(201);
    const { invite } = (await mkRes.json()) as { invite: { token: string } };

    // Bob with invite but no password session → still 401 (password required).
    const inviteOnly = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor({ id: CLIENT_B.id, name: 'whatever' }), invite.token),
      }),
    );
    expect(inviteOnly.status).toBe(401);

    const token = await authenticateForDoc(created.uid, created.password!, {
      id: CLIENT_B.id,
      name: 'whatever',
    });

    // Now invite + session cookie → editor role, name forced to Bob.
    const bobView = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(
          headersFor({ id: CLIENT_B.id, name: 'whatever' }, { cookie: token }),
          invite.token,
        ),
      }),
    );
    expect(bobView.status).toBe(200);
    const bobDoc = (await bobView.json()) as { role: string; display_name: string };
    expect(bobDoc.role).toBe('editor');
    expect(bobDoc.display_name).toBe('Bob');
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

  test('a document is invite_only unless the upload opts out', async () => {
    // Deliberately not via `upload()`, which opts out: the point is what an
    // upload that never mentions invite_only gets. Old clients are that case.
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headersFor(CLIENT_A),
        body: JSON.stringify({ markdown: '# Fresh' }),
      }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as CreateResponse & { invite_only: boolean };
    expect(created.invite_only).toBe(true);

    const stranger = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(stranger.status).toBe(401);
    expect((await stranger.json()) as { error: string }).toEqual({ error: 'invite-required' });

    // The creator's own admin link still opens it — the default closes the
    // document to strangers, not to its author.
    const asAdmin = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(asAdmin.status).toBe(200);
    expect(((await asAdmin.json()) as { invite_only: boolean }).invite_only).toBe(true);
  });

  test('invite_only: false opts a document back onto the open web', async () => {
    const created = (await upload(CLIENT_A, {
      markdown: '# Public',
      invite_only: false,
    })) as CreateResponse & { invite_only: boolean };
    expect(created.invite_only).toBe(false);

    const stranger = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(stranger.status).toBe(200);
    expect(((await stranger.json()) as { role: string }).role).toBe('reader');
  });

  test('invite_only doc rejects a stranger with no invite', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Private', invite_only: true });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(res.status).toBe(401);
    expect((await res.json()) as { error: string }).toEqual({ error: 'invite-required' });
  });

  test('invite_only doc still opens for the admin and for invite holders', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Private', invite_only: true });

    const asAdmin = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(asAdmin.status).toBe(200);
    const adminDoc = (await asAdmin.json()) as { role: string; invite_only: boolean };
    expect(adminDoc.role).toBe('admin');
    expect(adminDoc.invite_only).toBe(true);

    const mk = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'reader' }),
      }),
    );
    const { invite } = (await mk.json()) as { invite: { token: string } };

    const asGuest = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), invite.token),
      }),
    );
    expect(asGuest.status).toBe(200);
    expect(((await asGuest.json()) as { role: string }).role).toBe('reader');
  });

  test('invite_only doc opens for a claimed invite session (no token in the URL)', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Private', invite_only: true });
    const mk = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'collaborator' }),
      }),
    );
    const { invite } = (await mk.json()) as { invite: { token: string } };

    // Claiming must work on an invite_only doc — it is how the token
    // leaves the address bar.
    const claimed = await claimInvite(created.uid, invite.token, CLIENT_B);
    expect(claimed.status).toBe(201);
    expect(claimed.cookie).toContain(INVITE_SESSION_COOKIE);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: headersFor(CLIENT_B, { cookie: claimed.cookie }),
      }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { role: string }).role).toBe('collaborator');
  });

  test('invite_only is toggleable by an admin and takes effect immediately', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Public for now' });

    const before = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(before.status).toBe(200);
    expect(((await before.json()) as { invite_only: boolean }).invite_only).toBe(false);

    const patch = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ invite_only: true }),
      }),
    );
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { invite_only: boolean }).invite_only).toBe(true);

    const after = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(after.status).toBe(401);

    const reopen = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ invite_only: false }),
      }),
    );
    expect(reopen.status).toBe(200);
    const reopened = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(reopened.status).toBe(200);
  });

  test('non-admin cannot turn invite_only off', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Private', invite_only: true });
    const mk = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'editor' }),
      }),
    );
    const { invite } = (await mk.json()) as { invite: { token: string } };

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_B), invite.token),
        body: JSON.stringify({ invite_only: false }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test('invite_only gates every read surface, not just the document body', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Private', invite_only: true });
    const stranger = headersFor(CLIENT_B);
    for (const path of [
      `/api/documents/${created.uid}/export`,
      `/api/documents/${created.uid}/history`,
      `/api/documents/${created.uid}/threads`,
      `/api/documents/${created.uid}/assets`,
    ]) {
      const res = await app.hono.fetch(new Request(`http://test${path}`, { headers: stranger }));
      expect(`${path}: ${res.status}`).toBe(`${path}: 401`);
    }
  });

  test('invite_only and password are independent gates', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Both',
      invite_only: true,
      password_protected: true,
    });
    expect(created.password).toBeTruthy();

    // Password first: without a session the password gate answers.
    const noSession = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(noSession.status).toBe(401);
    expect(((await noSession.json()) as { error: string }).error).toBe('password-required');

    // Knowing the password is not enough once the doc is invite-only.
    const cookie = await authenticateForDoc(created.uid, created.password as string, CLIENT_B);
    const withPassword = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: headersFor(CLIENT_B, { cookie }),
      }),
    );
    expect(withPassword.status).toBe(401);
    expect(((await withPassword.json()) as { error: string }).error).toBe('invite-required');

    // Password session + invite clears both. The admin needs a password
    // session of their own here — the password gate is unconditional, so
    // the admin token alone does not reach the invites route.
    const adminCookie = await authenticateForDoc(created.uid, created.password as string, CLIENT_A);
    const mk = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(
          headersFor(CLIENT_A, { cookie: adminCookie }),
          created.admin_invite.token,
        ),
        body: JSON.stringify({ display_name: 'Bob', role: 'reader' }),
      }),
    );
    const { invite } = (await mk.json()) as { invite: { token: string } };
    const both = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_B, { cookie }), invite.token),
      }),
    );
    expect(both.status).toBe(200);
  });

  test('revoking an invite closes the door again on an invite_only doc', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Private', invite_only: true });
    const mk = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'reader' }),
      }),
    );
    const { invite } = (await mk.json()) as { invite: { token: string } };

    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites/${invite.token}`, {
        method: 'DELETE',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(del.status).toBe(204);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), invite.token),
      }),
    );
    expect(res.status).toBe(401);
  });

  // ACCESS_CONTROL Step 2: the `editable_by_anyone` toggle is gone.
  // Editing rights now require an editor (or admin) invite — anonymous
  // visitors are always reader, never editor.
  test('stranger with no invite is reader, cannot edit', async () => {
    const created = await upload(CLIENT_A, { markdown: '# X' });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: headersFor(CLIENT_B),
        body: JSON.stringify({ markdown: '# Edited by B' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  test('editor invite lets a stranger edit', async () => {
    const created = await upload(CLIENT_A, { markdown: '# X' });
    const mk = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'editor' }),
      }),
    );
    const { invite } = (await mk.json()) as { invite: { token: string } };

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor(CLIENT_B), invite.token),
        body: JSON.stringify({ markdown: '# Edited by B' }),
      }),
    );
    expect(res.status).toBe(200);
  });

  test('conditional update refuses to overwrite a document that changed', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Original' });
    const headers = withInvite(headersFor(CLIENT_A), created.admin_invite.token);

    const first = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ source: '# Current' }),
      }),
    );
    expect(first.status).toBe(200);

    const stale = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ source: '# Stale replacement', expected_source: '# Original' }),
      }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'document-changed' });

    const current = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers }),
    );
    expect(((await current.json()) as { source: string }).source).toBe('# Current');
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

    // Admin invites are not deletable at all.
    const killAdmin = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/invites/${created.admin_invite.token}`,
        {
          method: 'DELETE',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        },
      ),
    );
    expect(killAdmin.status).toBe(403);
  });

  test('copy: the copy holds the current source, a history of its own, and no threads', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Title\n\nalpha' });
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);

    // Give the source a second revision and a thread. Neither may travel.
    const updated = '# Title\n\nbeta';
    const editRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: adminHeaders,
        body: JSON.stringify({ markdown: updated }),
      }),
    );
    expect(editRes.status).toBe(200);
    const blockId = [...locateAllBlocks(updated).entries()].find(
      ([, range]) => range.text === 'beta',
    )?.[0];
    expect(blockId).toBeString();
    const threadRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'beta' },
          body: 'a note that stays behind',
        }),
      }),
    );
    expect(threadRes.status).toBe(201);

    const copyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/copy`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ name: 'Title - Copy' }),
      }),
    );
    expect(copyRes.status).toBe(201);
    const copy = (await copyRes.json()) as CreateResponse & {
      name: string;
      copied_from: string;
      invite_only: boolean;
    };
    expect(copy.uid).not.toBe(created.uid);
    expect(copy.copied_from).toBe(created.uid);
    expect(copy.name).toBe('Title - Copy');

    const copyHeaders = withInvite(headersFor(CLIENT_A), copy.admin_invite.token);
    const copyDocRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}`, { headers: copyHeaders }),
    );
    expect(copyDocRes.status).toBe(200);
    const copyDoc = (await copyDocRes.json()) as { source: string; role: string };
    expect(copyDoc.source).toBe(updated);
    expect(copyDoc.role).toBe('admin');

    // One commit, not the source's two: the copy's history starts here.
    const historyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}/history`, { headers: copyHeaders }),
    );
    const { history } = (await historyRes.json()) as {
      history: Array<{ action: string }>;
    };
    expect(history).toHaveLength(1);
    expect(history[0]?.action).toBe('upload');

    const copyThreads = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}/threads`, { headers: copyHeaders }),
    );
    expect(((await copyThreads.json()) as { threads: unknown[] }).threads).toHaveLength(0);

    // The source is untouched by having been copied.
    const sourceThreads = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, { headers: adminHeaders }),
    );
    expect(((await sourceThreads.json()) as { threads: unknown[] }).threads).toHaveLength(1);
  });

  test('copy: without include_access the copy is closed and the copier is its only member', async () => {
    // `upload` opts out of invite_only; the copy must not inherit that.
    const created = await upload(CLIENT_A, { markdown: '# Hi' });
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);
    const inviteRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ display_name: 'Bob', role: 'editor' }),
      }),
    );
    const { invite: bob } = (await inviteRes.json()) as { invite: { token: string } };

    const copyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/copy`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ name: 'Hi - Copy' }),
      }),
    );
    expect(copyRes.status).toBe(201);
    const copy = (await copyRes.json()) as CreateResponse & { invite_only: boolean };
    expect(copy.invite_only).toBe(true);

    // Bob's link opens the source, and nothing on the copy.
    const bobOnSource = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), bob.token),
      }),
    );
    expect(bobOnSource.status).toBe(200);
    const bobOnCopy = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), bob.token),
      }),
    );
    expect(bobOnCopy.status).toBe(401);

    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}/invites`, {
        headers: withInvite(headersFor(CLIENT_A), copy.admin_invite.token),
      }),
    );
    const { invites } = (await listRes.json()) as { invites: Array<{ kind: string }> };
    expect(invites.map((i) => i.kind)).toEqual(['admin']);
  });

  test('copy: include_access carries roles as new links, leaving the old ones on the source', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi', invite_only: true });
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);
    const inviteRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ display_name: 'Bob', role: 'editor', note: 'reviewer' }),
      }),
    );
    const { invite: bob } = (await inviteRes.json()) as { invite: { token: string } };

    const copyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/copy`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ name: 'Hi - Copy', include_access: true }),
      }),
    );
    expect(copyRes.status).toBe(201);
    const copy = (await copyRes.json()) as CreateResponse & { invite_only: boolean };
    expect(copy.invite_only).toBe(true);

    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}/invites`, {
        headers: withInvite(headersFor(CLIENT_A), copy.admin_invite.token),
      }),
    );
    const { invites } = (await listRes.json()) as {
      invites: Array<{ token: string; role: string; display_name: string; note: string | null }>;
    };
    const copiedBob = invites.find((i) => i.role === 'editor');
    expect(copiedBob?.display_name).toBe('Bob');
    expect(copiedBob?.note).toBe('reviewer');
    // A token is the credential as well as the primary key, so the copy
    // mints its own — the source's link must not reach it.
    expect(copiedBob?.token).not.toBe(bob.token);
    const bobsOldLink = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), bob.token),
      }),
    );
    expect(bobsOldLink.status).toBe(401);

    const bobsNewLink = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), copiedBob?.token ?? ''),
      }),
    );
    expect(bobsNewLink.status).toBe(200);
    expect(((await bobsNewLink.json()) as { role: string }).role).toBe('editor');
  });

  test('copy: a non-admin cannot copy the document', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });
    const inviteRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'editor' }),
      }),
    );
    const { invite: bob } = (await inviteRes.json()) as { invite: { token: string } };

    const copyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/copy`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_B), bob.token),
        body: JSON.stringify({ name: 'Bob’s fork' }),
      }),
    );
    expect(copyRes.status).toBe(403);
  });

  test('copy: a password-protected document copies protected, with a new password', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Secret', password_protected: true });
    expect(created.password).toBeString();
    const cookie = await authenticateForDoc(created.uid, created.password!, CLIENT_A);

    const copyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/copy`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A, { cookie }), created.admin_invite.token),
        body: JSON.stringify({ name: 'Secret - Copy' }),
      }),
    );
    expect(copyRes.status).toBe(201);
    const copy = (await copyRes.json()) as CreateResponse;
    // Only the hash is stored, so the password itself cannot travel —
    // but the gate has to, or copying would quietly unlock the content.
    expect(copy.password).toBeString();
    expect(copy.password).not.toBe(created.password);

    const noPassword = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), copy.admin_invite.token),
      }),
    );
    expect(noPassword.status).toBe(401);
    expect(((await noPassword.json()) as { error: string }).error).toBe('password-required');

    const copyCookie = await authenticateForDoc(copy.uid, copy.password!, CLIENT_A);
    const withPassword = await app.hono.fetch(
      new Request(`http://test/api/documents/${copy.uid}`, {
        headers: withInvite(headersFor(CLIENT_A, { cookie: copyCookie }), copy.admin_invite.token),
      }),
    );
    expect(withPassword.status).toBe(200);
  });

  test('password-protected docs require a password session; invite still controls role', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Secret',
      password_protected: true,
    });
    expect(created.password).toBeString();

    // Invite alone is not enough.
    const inviteOnly = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), created.admin_invite.token),
      }),
    );
    expect(inviteOnly.status).toBe(401);

    // No invite, no session → 401
    const denied = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(denied.status).toBe(401);

    const sessionCookie = await authenticateForDoc(created.uid, created.password!, CLIENT_B);

    // With only the password session, Bob is a plain reader.
    const afterAuth = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: headersFor(CLIENT_B, { cookie: sessionCookie }),
      }),
    );
    expect(afterAuth.status).toBe(200);
    expect(((await afterAuth.json()) as { role: string }).role).toBe('reader');

    // With session + invite, the invite controls the role. Under
    // ACCESS_CONTROL option 1 the display_name is only seeded by the
    // invite on first visit; since Bob already showed up as reader
    // (line above) his prior doc_users row exists and the header he
    // sends now wins — so this second request correctly reflects the
    // visitor's chosen name rather than forcibly becoming the invite's.
    const inviteAfterAuth = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(
          headersFor({ id: CLIENT_B.id, name: 'Whatever' }, { cookie: sessionCookie }),
          created.admin_invite.token,
        ),
      }),
    );
    expect(inviteAfterAuth.status).toBe(200);
    const doc = (await inviteAfterAuth.json()) as { role: string; display_name: string };
    expect(doc.role).toBe('admin');
    expect(doc.display_name).toBe('Whatever');
  });

  test('admin invite can recover the current password without a password session', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Secret',
      password_protected: true,
    });
    expect(created.password).toBeString();

    const recovered = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/password/recover`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(recovered.status).toBe(200);
    expect((await recovered.json()) as { password: string }).toEqual({
      password: created.password!,
    });

    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(
          headersFor(CLIENT_A, {
            cookie: await authenticateForDoc(created.uid, created.password!, CLIENT_A),
          }),
          created.admin_invite.token,
        ),
        body: JSON.stringify({ display_name: 'Bob', role: 'editor' }),
      }),
    );
    expect(mkRes.status).toBe(201);
    const { invite } = (await mkRes.json()) as { invite: { token: string } };

    const forbidden = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/password/recover`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_B), invite.token),
      }),
    );
    expect(forbidden.status).toBe(403);
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

  test('history diff returns a revision against its previous revision', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Title\n\nalpha' });

    const updateRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ markdown: '# Title\n\nbeta' }),
      }),
    );
    expect(updateRes.status).toBe(200);

    const historyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(historyRes.status).toBe(200);
    const { history } = (await historyRes.json()) as {
      history: Array<{ oid: string }>;
    };
    expect(history).toHaveLength(2);

    const latestDiffRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${history[0]!.oid}/diff`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(latestDiffRes.status).toBe(200);
    expect(await latestDiffRes.json()).toEqual({
      before: '# Title\n\nalpha',
      after: '# Title\n\nbeta',
    });

    const initialDiffRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${history[1]!.oid}/diff`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(initialDiffRes.status).toBe(200);
    expect(await initialDiffRes.json()).toEqual({
      before: '',
      after: '# Title\n\nalpha',
    });
  });

  test('commit_message is stored in git commit body', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Original' });

    const updateRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ markdown: '# Updated', commit_message: 'Fix typo in introduction' }),
      }),
    );
    expect(updateRes.status).toBe(200);

    const doc = app.db
      .prepare('SELECT uid, format FROM documents WHERE uid = ?')
      .get(created.uid) as { uid: string; format: 'markdown' | 'asciidoc' };
    const history = await app.store.history(doc);
    expect(history[0]?.message).toContain('Fix typo in introduction');
    expect(history[0]?.message).toContain(`X-Marginalia-Client-ID: ${CLIENT_A.id}`);
  });

  test('X-Marginalia-* lines in commit_message are stripped', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Original' });

    await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          markdown: '# Updated',
          commit_message:
            'Legit message\nX-Marginalia-Client-ID: spoofed-id\n  X-Marginalia-Client-ID: whitespace-spoofed',
        }),
      }),
    );

    const doc = app.db
      .prepare('SELECT uid, format FROM documents WHERE uid = ?')
      .get(created.uid) as { uid: string; format: 'markdown' | 'asciidoc' };
    const history = await app.store.history(doc);
    expect(history[0]?.message).not.toContain('spoofed-id');
    expect(history[0]?.message).not.toContain('whitespace-spoofed');
    expect(history[0]?.message).toContain(`X-Marginalia-Client-ID: ${CLIENT_A.id}`);
  });

  test('actor attribution is correct when commit_message is provided', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Original' });

    await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ markdown: '# Updated', commit_message: 'My commit message' }),
      }),
    );

    const historyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(historyRes.status).toBe(200);
    const { history } = (await historyRes.json()) as {
      history: Array<{ action: string; actor: { client_id: string } }>;
    };
    const update = history.find((e) => e.action === 'update');
    expect(update?.actor.client_id).toBe(CLIENT_A.id);
  });

  test('history resolves the current display name from the per-document user table', async () => {
    const created = await upload({ id: CLIENT_A.id, name: 'Sky Pica' }, { markdown: '# Title' });
    const renamedHeaders = withInvite(
      headersFor({ id: CLIENT_A.id, name: 'Paul' }),
      created.admin_invite.token,
    );

    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: renamedHeaders,
      }),
    );
    expect(docRes.status).toBe(200);

    const historyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: renamedHeaders,
      }),
    );
    expect(historyRes.status).toBe(200);
    const { history } = (await historyRes.json()) as {
      history: Array<{
        action: string;
        actor: { client_id: string | null; display_name: string | null };
      }>;
    };
    expect(history[0]?.action).toBe('upload');
    expect(history[0]?.actor.client_id).toBe(CLIENT_A.id);
    expect(history[0]?.actor.display_name).toBe('Paul');
  });

  test('accepted proposal history includes proposal metadata and current author name', async () => {
    const source = '# Title\n\nalpha';
    const created = await upload(CLIENT_A, { markdown: source });
    const blockId = [...locateAllBlocks(source).entries()].find(
      ([, range]) => range.text === 'alpha',
    )?.[0];
    expect(blockId).toBeString();

    const inviteRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'collaborator' }),
      }),
    );
    expect(inviteRes.status).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { token: string } };

    const bobHeaders = withInvite(headersFor(CLIENT_B), invite.token);
    const bobDocRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: bobHeaders,
      }),
    );
    expect(bobDocRes.status).toBe(200);

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: bobHeaders,
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'alpha' },
          proposal: {
            proposed_text: 'First replacement\nSecond line',
          },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()) as {
      thread: { id: string };
    };

    const acceptRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ action: 'accept' }),
        },
      ),
    );
    expect(acceptRes.status).toBe(200);

    const renamedBobRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor({ id: CLIENT_B.id, name: 'Robert' }), invite.token),
      }),
    );
    expect(renamedBobRes.status).toBe(200);

    const historyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(historyRes.status).toBe(200);
    const { history } = (await historyRes.json()) as {
      history: Array<{
        action: string;
        proposal: {
          id: string;
          author: { client_id: string; display_name: string };
          summary: string;
          deleted: boolean;
        } | null;
      }>;
    };
    const accepted = history.find((entry) => entry.action === 'accept-proposal');
    expect(accepted?.proposal).toEqual({
      id: proposal.thread.id,
      author: { client_id: CLIENT_B.id, display_name: 'Robert' },
      summary: 'Proposed change',
      deleted: false,
    });
  });

  test('accepting a proposal reanchors the thread to the updated block when the block id changes', async () => {
    const source = '## 2. Loesungskonzept & App-Architektur (Q1 - 30 %)\n\nBody.\n';
    const created = await upload(CLIENT_A, { markdown: source });
    const currentBlocks = [...locateAllBlocks(source).entries()];
    const original = currentBlocks.find(
      ([, range]) => range.kind === 'heading' && range.text.includes('30 %'),
    );
    expect(original).toBeDefined();
    const [blockId, block] = original!;

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: block.text },
          proposal: {
            proposed_text: '## 2. Loesungskonzept & App-Architektur (Q1 - 30%)',
          },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()) as {
      thread: { id: string };
    };

    const acceptedSource = '## 2. Loesungskonzept & App-Architektur (Q1 - 30%)\n\nBody.\n';
    const expectedAcceptedBlockId =
      [...locateAllBlocks(acceptedSource).entries()].find(
        ([, range]) => range.kind === 'heading' && range.text.includes('30%'),
      )?.[0] ?? null;
    expect(expectedAcceptedBlockId).toBeString();

    const acceptRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ action: 'accept' }),
        },
      ),
    );
    expect(acceptRes.status).toBe(200);
    const accepted = (await acceptRes.json()) as {
      thread: {
        state: string;
        link_status: string;
        anchor: { block_id: string | null; quote: string | null } | null;
      };
    };
    expect(accepted.thread.state).toBe('resolved');
    expect(accepted.thread.link_status).toBe('linked');
    expect(accepted.thread.anchor?.block_id).toBe(expectedAcceptedBlockId);
    expect(accepted.thread.anchor?.block_id).not.toBe(blockId);
    expect(accepted.thread.anchor?.quote).toBe('2. Loesungskonzept & App-Architektur (Q1 - 30%)');

    const stored = app.db
      .prepare(
        `SELECT anchor_block_id, link_status
         FROM comments
        WHERE id = ?`,
      )
      .get(proposal.thread.id) as {
      anchor_block_id: string | null;
      link_status: string;
    };
    expect(stored).toEqual({
      anchor_block_id: expectedAcceptedBlockId,
      link_status: 'linked',
    });
  });

  test('restoring a history version creates a restore entry and restores the source', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Title\n\nalpha' });

    const updateRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ markdown: '# Title\n\nbeta' }),
      }),
    );
    expect(updateRes.status).toBe(200);

    const historyBeforeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(historyBeforeRes.status).toBe(200);
    const historyBefore = (await historyBeforeRes.json()) as {
      history: Array<{ oid: string }>;
    };
    const initialOid = historyBefore.history[1]?.oid;
    expect(initialOid).toBeString();

    const restoreRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${initialOid}/restore`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(restoreRes.status).toBe(200);
    const restored = (await restoreRes.json()) as { oid: string };
    expect(restored.oid).toBeString();

    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(docRes.status).toBe(200);
    const doc = (await docRes.json()) as { source: string };
    expect(doc.source).toBe('# Title\n\nalpha');

    const historyAfterRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(historyAfterRes.status).toBe(200);
    const historyAfter = (await historyAfterRes.json()) as {
      history: Array<{
        oid: string;
        action: string;
        restored_from_oid: string | null;
      }>;
    };
    expect(historyAfter.history[0]).toMatchObject({
      oid: restored.oid,
      action: 'restore',
      restored_from_oid: initialOid,
    });

    const restoreDiffRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${restored.oid}/diff`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(restoreDiffRes.status).toBe(200);
    expect(await restoreDiffRes.json()).toEqual({
      before: '# Title\n\nbeta',
      after: '# Title\n\nalpha',
    });
  });

  test('reverting the latest history change restores the previous source', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Title\n\nalpha' });

    const updateRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ markdown: '# Title\n\nbeta' }),
      }),
    );
    expect(updateRes.status).toBe(200);

    const historyBeforeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(historyBeforeRes.status).toBe(200);
    const historyBefore = (await historyBeforeRes.json()) as {
      history: Array<{ oid: string }>;
    };
    const latestOid = historyBefore.history[0]?.oid;
    expect(latestOid).toBeString();

    const revertRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${latestOid}/revert`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(revertRes.status).toBe(200);
    const reverted = (await revertRes.json()) as { oid: string };
    expect(reverted.oid).toBeString();

    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(docRes.status).toBe(200);
    const doc = (await docRes.json()) as { source: string };
    expect(doc.source).toBe('# Title\n\nalpha');

    const historyAfterRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(historyAfterRes.status).toBe(200);
    const historyAfter = (await historyAfterRes.json()) as {
      history: Array<{
        oid: string;
        action: string;
        reverted_oid: string | null;
      }>;
    };
    expect(historyAfter.history[0]).toMatchObject({
      oid: reverted.oid,
      action: 'revert',
      reverted_oid: latestOid,
    });

    const revertDiffRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${reverted.oid}/diff`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(revertDiffRes.status).toBe(200);
    expect(await revertDiffRes.json()).toEqual({
      before: '# Title\n\nbeta',
      after: '# Title\n\nalpha',
    });
  });

  test('reverting an older plain edit preserves unrelated later changes', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Title\n\nalpha\n\none' });

    const edit = async (markdown: string) => {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}`, {
          method: 'PUT',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ markdown }),
        }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { oid: string };
    };

    const firstEdit = await edit('# Title\n\nbeta\n\none');
    await edit('# Title\n\nbeta\n\ntwo');

    const revertRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${firstEdit.oid}/revert`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(revertRes.status).toBe(200);

    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(docRes.status).toBe(200);
    expect(((await docRes.json()) as { source: string }).source).toBe('# Title\n\nalpha\n\ntwo');
  });

  test('a conflicting git revert leaves the current document untouched', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Title\n\nalpha' });
    const edit = async (markdown: string) => {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}`, {
          method: 'PUT',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ markdown }),
        }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { oid: string };
    };

    const firstEdit = await edit('# Title\n\nbeta');
    await edit('# Title\n\ngamma');

    const revertRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${firstEdit.oid}/revert`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(revertRes.status).toBe(409);
    expect(await revertRes.json()).toEqual({ error: 'revert-conflict' });

    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(((await docRes.json()) as { source: string }).source).toBe('# Title\n\ngamma');
  });

  test('reverting the latest accepted proposal restores the source and reopens the proposal', async () => {
    const source = '# Title\n\nalpha';
    const created = await upload(CLIENT_A, { markdown: source });
    const blockId = [...locateAllBlocks(source).entries()].find(
      ([, range]) => range.text === 'alpha',
    )?.[0];
    expect(blockId).toBeString();

    const inviteRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Bob', role: 'collaborator' }),
      }),
    );
    expect(inviteRes.status).toBe(201);
    const { invite } = (await inviteRes.json()) as { invite: { token: string } };
    const bobHeaders = withInvite(headersFor(CLIENT_B), invite.token);

    const bobDocRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: bobHeaders,
      }),
    );
    expect(bobDocRes.status).toBe(200);

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: bobHeaders,
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'alpha' },
          proposal: { proposed_text: 'beta' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()) as {
      thread: { id: string };
    };

    const acceptRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ action: 'accept' }),
        },
      ),
    );
    expect(acceptRes.status).toBe(200);

    const historyBeforeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(historyBeforeRes.status).toBe(200);
    const historyBefore = (await historyBeforeRes.json()) as {
      history: Array<{
        oid: string;
        action: string;
        proposal: { id: string } | null;
      }>;
    };
    const latestAccepted = historyBefore.history[0];
    const previousOid = historyBefore.history[1]?.oid;
    expect(latestAccepted?.action).toBe('accept-proposal');
    expect(latestAccepted?.proposal?.id).toBe(proposal.thread.id);
    expect(previousOid).toBeString();

    const revertRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/history/${latestAccepted?.oid}/revert`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        },
      ),
    );
    expect(revertRes.status).toBe(200);
    const reverted = (await revertRes.json()) as {
      oid: string;
      reopened_proposal_id: string | null;
    };
    expect(reverted.oid).toBeString();
    expect(reverted.reopened_proposal_id).toBe(proposal.thread.id);

    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(docRes.status).toBe(200);
    const doc = (await docRes.json()) as { source: string };
    expect(doc.source).toBe(source);

    const proposalRow = app.db
      .prepare(
        `SELECT status, accepted_oid
         FROM comments_edit_proposals
        WHERE comment_id = ?`,
      )
      .get(proposal.thread.id) as {
      status: string;
      accepted_oid: string | null;
    };
    expect(proposalRow).toEqual({
      status: 'open',
      accepted_oid: null,
    });
    const restoredAnchor = app.db
      .prepare(
        `SELECT anchor_block_id, anchor_quote, link_status
           FROM comments
          WHERE id = ?`,
      )
      .get(proposal.thread.id) as {
      anchor_block_id: string | null;
      anchor_quote: string | null;
      link_status: string;
    };
    expect(restoredAnchor).toEqual({
      anchor_block_id: blockId!,
      anchor_quote: 'alpha',
      link_status: 'linked',
    });

    const historyAfterRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(historyAfterRes.status).toBe(200);
    const historyAfter = (await historyAfterRes.json()) as {
      history: Array<{
        oid: string;
        action: string;
        restored_from_oid: string | null;
      }>;
    };
    expect(historyAfter.history[0]).toMatchObject({
      oid: reverted.oid,
      action: 'restore',
      restored_from_oid: previousOid,
    });
  });

  test('rejecting a proposal preserves its branch ref so reopen + accept still work (#25)', async () => {
    const source = '# Title\n\nalpha';
    const created = await upload(CLIENT_A, { markdown: source });
    const blockId = [...locateAllBlocks(source).entries()].find(
      ([, range]) => range.text === 'alpha',
    )?.[0];
    expect(blockId).toBeString();

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'alpha' },
          body: 'please change',
          proposal: { proposed_text: 'beta' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()) as { thread: { id: string } };

    const docLocator = { uid: created.uid, format: 'markdown' as const };
    expect(await app.store.readProposalTip(docLocator, proposal.thread.id)).toBe('# Title\n\nbeta');

    const rejectRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ action: 'reject' }),
        },
      ),
    );
    expect(rejectRes.status).toBe(200);

    // The branch ref is intentionally kept after reject so reopen +
    // accept don't have to reconstruct it from columns that Phase 3
    // drops. The proposal is just status='rejected' in the DB.
    expect(await app.store.readProposalTip(docLocator, proposal.thread.id)).toBe('# Title\n\nbeta');

    const reopenRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ action: 'reopen' }),
        },
      ),
    );
    expect(reopenRes.status).toBe(200);

    expect(await app.store.readProposalTip(docLocator, proposal.thread.id)).toBe('# Title\n\nbeta');

    const acceptRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ action: 'accept' }),
        },
      ),
    );
    expect(acceptRes.status).toBe(200);
    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(((await docRes.json()) as { source: string }).source).toBe('# Title\n\nbeta');
  });

  test('deleting a proposal thread also deletes its branch ref (#25)', async () => {
    const source = '# Title\n\nalpha';
    const created = await upload(CLIENT_A, { markdown: source });
    const blockId = [...locateAllBlocks(source).entries()].find(
      ([, range]) => range.text === 'alpha',
    )?.[0];
    expect(blockId).toBeString();

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'alpha' },
          body: 'please change',
          proposal: { proposed_text: 'beta' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()) as { thread: { id: string } };

    const docLocator = { uid: created.uid, format: 'markdown' as const };
    expect(await app.store.readProposalTip(docLocator, proposal.thread.id)).toBeString();

    const deleteRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads/${proposal.thread.id}`, {
        method: 'DELETE',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(deleteRes.status).toBe(204);

    expect(await app.store.readProposalTip(docLocator, proposal.thread.id)).toBeNull();
  });

  /** Upload a doc and open one proposal on the block containing `anchorText`. */
  async function seedProposal(
    source: string,
    anchorText: string,
    proposedText: string,
  ): Promise<{ created: CreateResponse; threadId: string; blockId: string }> {
    const created = await upload(CLIENT_A, { markdown: source });
    const blockId = [...locateAllBlocks(source).entries()].find(([, range]) =>
      range.text.includes(anchorText),
    )?.[0] as string;
    expect(blockId).toBeString();
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: anchorText },
          body: 'please change',
          proposal: { proposed_text: proposedText },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { thread } = (await res.json()) as { thread: { id: string } };
    return { created, threadId: thread.id, blockId };
  }

  async function patchThread(
    created: CreateResponse,
    threadId: string,
    body: Record<string, unknown>,
    client: typeof CLIENT_A = CLIENT_A,
  ): Promise<Response> {
    return app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads/${threadId}`, {
        method: 'PATCH',
        headers: withInvite(headersFor(client), created.admin_invite.token),
        body: JSON.stringify(body),
      }),
    );
  }

  async function saveSource(created: CreateResponse, source: string): Promise<void> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ source }),
      }),
    );
    expect(res.status).toBe(200);
  }

  async function acceptThread(created: CreateResponse, threadId: string): Promise<Response> {
    return app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads/${threadId}/respond`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
  }

  async function readSource(created: CreateResponse): Promise<string> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    return ((await res.json()) as { source: string }).source;
  }

  test('PATCH proposal.proposed_text revises the branch in place; accept applies the new text', async () => {
    const source = '# Title\n\nalpha';
    const { created, threadId } = await seedProposal(source, 'alpha', 'beta');
    const docLocator = { uid: created.uid, format: 'markdown' as const };
    expect(await app.store.readProposalTip(docLocator, threadId)).toBe('# Title\n\nbeta');

    const res = await patchThread(created, threadId, { proposal: { proposed_text: 'gamma' } });
    expect(res.status).toBe(200);
    const { thread } = (await res.json()) as {
      thread: {
        link_status: string;
        proposal: { proposed_text: string | null; source_snapshot: string | null };
        capabilities: Record<string, boolean>;
        comments: Array<{ body: string }>;
      };
    };
    expect(thread.proposal.proposed_text).toBe('gamma');
    expect(thread.proposal.source_snapshot).toBe('alpha');
    expect(thread.comments[0]?.body).toBe('please change');
    expect(thread.capabilities.update).toBe(true);
    expect(await app.store.readProposalTip(docLocator, threadId)).toBe('# Title\n\ngamma');

    // Re-sending the same text is a no-op: the row is left untouched.
    const updatedAtBefore = (
      app.db.prepare('SELECT updated_at FROM comments WHERE id = ?').get(threadId) as {
        updated_at: number;
      }
    ).updated_at;
    const noop = await patchThread(created, threadId, { proposal: { proposed_text: 'gamma' } });
    expect(noop.status).toBe(200);
    const updatedAtAfter = (
      app.db.prepare('SELECT updated_at FROM comments WHERE id = ?').get(threadId) as {
        updated_at: number;
      }
    ).updated_at;
    expect(updatedAtAfter).toBe(updatedAtBefore);

    // Rationale and text can change together in one request.
    const combined = await patchThread(created, threadId, {
      body: 'sharper wording',
      proposal: { proposed_text: 'delta' },
    });
    expect(combined.status).toBe(200);
    const combinedThread = (await combined.json()) as {
      thread: { proposal: { proposed_text: string | null }; comments: Array<{ body: string }> };
    };
    expect(combinedThread.thread.proposal.proposed_text).toBe('delta');
    expect(combinedThread.thread.comments[0]?.body).toBe('sharper wording');

    expect((await acceptThread(created, threadId)).status).toBe(200);
    expect(await readSource(created)).toBe('# Title\n\ndelta');

    // A decided proposal is frozen.
    const afterAccept = await patchThread(created, threadId, {
      proposal: { proposed_text: 'epsilon' },
    });
    expect(afterAccept.status).toBe(400);
    expect(await afterAccept.json()).toEqual({ error: 'not-open' });
  });

  test('PATCH proposal update with `comment` posts the revision note as a reply', async () => {
    const source = '# Title\n\nalpha';
    const { created, threadId } = await seedProposal(source, 'alpha', 'beta');
    const docLocator = { uid: created.uid, format: 'markdown' as const };

    const res = await patchThread(created, threadId, {
      proposal: { proposed_text: 'gamma' },
      comment: 'Tightened the phrasing per feedback.',
    });
    expect(res.status).toBe(200);
    const { thread, created_reply_id } = (await res.json()) as {
      thread: {
        proposal: { proposed_text: string | null };
        comments: Array<{ id: string; body: string; author: { display_name: string } }>;
      };
      created_reply_id: string | null;
    };
    expect(thread.proposal.proposed_text).toBe('gamma');
    expect(await app.store.readProposalTip(docLocator, threadId)).toBe('# Title\n\ngamma');
    expect(thread.comments).toHaveLength(2);
    expect(thread.comments[1]?.body).toBe('Tightened the phrasing per feedback.');
    expect(thread.comments[1]?.author.display_name).toBe(CLIENT_A.name);
    expect(created_reply_id).toBe(thread.comments[1]?.id as string);
    // The rationale (opener) is untouched by a comment-only note.
    expect(thread.comments[0]?.body).toBe('please change');

    // Identical text + comment: the branch rewrite is skipped but the
    // note still lands, so nothing the author wrote is dropped.
    const noop = await patchThread(created, threadId, {
      proposal: { proposed_text: 'gamma' },
      comment: 'Same text, just confirming.',
    });
    expect(noop.status).toBe(200);
    const noopBody = (await noop.json()) as {
      thread: { comments: Array<{ body: string }> };
      created_reply_id: string | null;
    };
    expect(noopBody.thread.comments).toHaveLength(3);
    expect(noopBody.thread.comments[2]?.body).toBe('Same text, just confirming.');
    expect(noopBody.created_reply_id).toBeString();

    // A comment needs a proposal update to annotate — plain replies go
    // through POST /respond.
    const withoutProposal = await patchThread(created, threadId, {
      body: 'new rationale',
      comment: 'orphan note',
    });
    expect(withoutProposal.status).toBe(400);
    expect(await withoutProposal.json()).toEqual({ error: 'comment-requires-proposal' });
  });

  test('PATCH proposal.proposed_text rebases the branch onto current main', async () => {
    const source = '# Title\n\nalpha\n\nomega';
    const { created, threadId } = await seedProposal(source, 'alpha', 'beta');
    const docLocator = { uid: created.uid, format: 'markdown' as const };

    // Move main underneath the proposal with an unrelated direct edit.
    await saveSource(created, '# Title\n\nalpha\n\nOMEGA');

    const res = await patchThread(created, threadId, { proposal: { proposed_text: 'gamma' } });
    expect(res.status).toBe(200);

    // The rewritten branch parents at the moved main: stored base
    // follows, and the tip carries the other edit.
    const row = app.db
      .prepare('SELECT base_oid FROM comments_edit_proposals WHERE comment_id = ?')
      .get(threadId) as { base_oid: string };
    expect(row.base_oid).toBe(await app.store.mainOid(docLocator));
    expect(await app.store.readProposalTip(docLocator, threadId)).toBe('# Title\n\ngamma\n\nOMEGA');

    const diffRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads/${threadId}/diff`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(diffRes.status).toBe(200);
    const diff = (await diffRes.json()) as { before: string; after: string; mergeable: string };
    expect(diff.before).toBe('alpha');
    expect(diff.after).toBe('gamma');
    expect(diff.mergeable).toBe('clean');

    expect((await acceptThread(created, threadId)).status).toBe(200);
    expect(await readSource(created)).toBe('# Title\n\ngamma\n\nOMEGA');
  });

  test('PATCH proposal guards: author/admin-only, proposals-only, well-formed, branch-backed, anchored', async () => {
    const source = '# Title\n\nalpha';
    const { created, threadId, blockId } = await seedProposal(source, 'alpha', 'beta');

    // An admin sees the update capability and can revise a proposal they
    // did not author.
    const adminListRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        headers: withInvite(headersFor(CLIENT_B), created.admin_invite.token),
      }),
    );
    expect(adminListRes.status).toBe(200);
    const adminList = (await adminListRes.json()) as {
      threads: Array<{ id: string; capabilities: Record<string, boolean> }>;
    };
    expect(adminList.threads.find((thread) => thread.id === threadId)?.capabilities.update).toBe(
      true,
    );

    const asAdmin = await patchThread(
      created,
      threadId,
      {
        proposal: { proposed_text: 'x' },
        comment: 'Admin revision note.',
      },
      CLIENT_B,
    );
    expect(asAdmin.status).toBe(200);
    const adminUpdate = (await asAdmin.json()) as {
      thread: {
        proposal: { proposed_text: string | null };
        comments: Array<{ body: string; author: { client_id: string } }>;
      };
    };
    expect(adminUpdate.thread.proposal.proposed_text).toBe('x');
    expect(adminUpdate.thread.comments.at(-1)).toMatchObject({
      body: 'Admin revision note.',
      author: { client_id: CLIENT_B.id },
    });

    // A non-admin who is not the author remains forbidden.
    const asReader = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads/${threadId}`, {
        method: 'PATCH',
        headers: headersFor(CLIENT_C),
        body: JSON.stringify({ proposal: { proposed_text: 'reader rewrite' } }),
      }),
    );
    expect(asReader.status).toBe(403);

    // Admin proposal updates do not grant permission to replace another
    // author's rationale.
    const adminRationaleEdit = await patchThread(
      created,
      threadId,
      { body: 'admin-authored rationale', proposal: { proposed_text: 'y' } },
      CLIENT_B,
    );
    expect(adminRationaleEdit.status).toBe(403);

    // Payload validation stays role-independent: malformed admin
    // revisions reach the same dedicated errors as author requests.
    const adminCommentWithoutProposal = await patchThread(
      created,
      threadId,
      { comment: 'orphan note' },
      CLIENT_B,
    );
    expect(adminCommentWithoutProposal.status).toBe(400);
    expect(await adminCommentWithoutProposal.json()).toEqual({
      error: 'comment-requires-proposal',
    });
    const emptyAdminUpdate = await patchThread(created, threadId, {}, CLIENT_B);
    expect(emptyAdminUpdate.status).toBe(400);
    expect(await emptyAdminUpdate.json()).toEqual({ error: 'body-required' });

    const nonObject = await patchThread(created, threadId, { proposal: 'x' });
    expect(nonObject.status).toBe(400);
    expect(await nonObject.json()).toEqual({ error: 'proposal-text-required' });
    const wrongType = await patchThread(created, threadId, { proposal: { proposed_text: 42 } });
    expect(wrongType.status).toBe(400);
    expect(await wrongType.json()).toEqual({ error: 'proposal-text-required' });

    // A plain comment thread has no proposed text to update.
    const commentRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'alpha' }, body: 'a note' }),
      }),
    );
    expect(commentRes.status).toBe(201);
    const commentThread = ((await commentRes.json()) as { thread: { id: string } }).thread;
    const onComment = await patchThread(created, commentThread.id, {
      proposal: { proposed_text: 'x' },
    });
    expect(onComment.status).toBe(400);
    expect(await onComment.json()).toEqual({ error: 'proposal-required' });

    // A legacy row without branch storage cannot be updated in place.
    app.db
      .prepare('UPDATE comments_edit_proposals SET branch_ref = NULL WHERE comment_id = ?')
      .run(threadId);
    const legacy = await patchThread(created, threadId, { proposal: { proposed_text: 'x' } });
    expect(legacy.status).toBe(409);
    expect(await legacy.json()).toEqual({ error: 'proposal-update-unavailable' });
    app.db
      .prepare('UPDATE comments_edit_proposals SET branch_ref = ? WHERE comment_id = ?')
      .run(`refs/proposals/${threadId}`, threadId);

    // Rewriting the anchored paragraph out from under it orphans the
    // proposal; an orphan needs repair, not new text.
    await saveSource(created, '# Title\n\nsomething else entirely');
    const orphaned = await patchThread(created, threadId, { proposal: { proposed_text: 'x' } });
    expect(orphaned.status).toBe(409);
    expect(await orphaned.json()).toEqual({ error: 'proposal-orphaned' });
  });

  test('updating a conflicted proposal rebuilds it against current main and clears the conflict', async () => {
    const source = '# Title\n\nalpha line here\n\nend';
    const { created, threadId } = await seedProposal(source, 'alpha line here', 'beta line here');

    // Rewrite the anchored paragraph directly: the proposal orphans, and
    // repair can re-attach it only as a conflict (both sides edited the
    // same line).
    await saveSource(created, '# Title\n\ngamma line here\n\nend');
    const repairRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads/${threadId}/repair`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(repairRes.status).toBe(200);
    const repaired = (await repairRes.json()) as { thread: { link_status: string } };
    expect(repaired.thread.link_status).toBe('conflict');

    // The author rewrites the suggestion against what is there now —
    // that is the fix for a conflict, and it clears the flag.
    const res = await patchThread(created, threadId, {
      proposal: { proposed_text: 'delta line here' },
    });
    expect(res.status).toBe(200);
    const { thread } = (await res.json()) as {
      thread: {
        link_status: string;
        proposal: { source_snapshot: string | null };
        capabilities: Record<string, boolean>;
      };
    };
    expect(thread.link_status).toBe('linked');
    expect(thread.proposal.source_snapshot).toBe('gamma line here');
    expect(thread.capabilities.accept).toBe(true);

    expect((await acceptThread(created, threadId)).status).toBe(200);
    expect(await readSource(created)).toBe('# Title\n\ndelta line here\n\nend');
  });

  test('updating a whole-document proposal replaces the whole current source', async () => {
    const source = '# Title\n\nalpha';
    const created = await upload(CLIENT_A, { markdown: source });
    const blockId = [...locateAllBlocks(source).keys()][0] as string;
    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: '' },
          body: 'full rewrite',
          proposal: { proposed_text: '# Rewrite\n\none\n', whole_document: true },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const threadId = ((await proposeRes.json()) as { thread: { id: string } }).thread.id;

    // Whole-document proposals survive any drift — update splices the
    // full current source even after main moved.
    await saveSource(created, '# Title\n\nalpha\n\nadded');
    const res = await patchThread(created, threadId, {
      proposal: { proposed_text: '# Rewrite\n\ntwo\n' },
    });
    expect(res.status).toBe(200);
    const docLocator = { uid: created.uid, format: 'markdown' as const };
    expect(await app.store.readProposalTip(docLocator, threadId)).toBe('# Rewrite\n\ntwo\n');
    const row = app.db
      .prepare(
        'SELECT base_block_start, base_block_end FROM comments_edit_proposals WHERE comment_id = ?',
      )
      .get(threadId) as { base_block_start: number; base_block_end: number };
    expect(row.base_block_start).toBe(0);
    expect(row.base_block_end).toBe('# Title\n\nalpha\n\nadded'.length);

    expect((await acceptThread(created, threadId)).status).toBe(200);
    expect(await readSource(created)).toBe('# Rewrite\n\ntwo\n');
  });

  test('accept returns 409 proposal-orphaned when the branch ref has vanished (#25)', async () => {
    // Without `proposed_text` in a column anymore the branch tip is the
    // only source of truth, so a missing ref means the proposal can't
    // be accepted. The route returns 409 rather than crashing.
    const source = '# Title\n\nalpha';
    const created = await upload(CLIENT_A, { markdown: source });
    const blockId = [...locateAllBlocks(source).entries()].find(
      ([, range]) => range.text === 'alpha',
    )?.[0];
    expect(blockId).toBeString();

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'alpha' },
          body: 'change it',
          proposal: { proposed_text: 'beta' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()) as { thread: { id: string } };

    await app.store.deleteProposalBranch(
      { uid: created.uid, format: 'markdown' },
      proposal.thread.id,
    );

    const acceptRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ action: 'accept' }),
        },
      ),
    );
    expect(acceptRes.status).toBe(409);
    expect(await acceptRes.json()).toEqual({ error: 'proposal-orphaned' });
  });

  test('accepted proposal diff renders the original block content via base_block_{start,end} (#25)', async () => {
    // anchor_block_id is rewritten on accept (block ids are content-
    // hash-derived), so it can't be used to locate the splice in
    // base_oid afterwards. The persisted byte range is what makes the
    // diff path work for accepted proposals without falling back to
    // the source_snapshot column.
    const source = '# Title\n\nalpha';
    const created = await upload(CLIENT_A, { markdown: source });
    const blockId = [...locateAllBlocks(source).entries()].find(
      ([, range]) => range.text === 'alpha',
    )?.[0];
    expect(blockId).toBeString();

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'alpha' },
          body: 'change it',
          proposal: { proposed_text: 'beta' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()) as { thread: { id: string } };

    // The byte range is persisted at proposal-create time.
    const row = app.db
      .prepare(
        `SELECT base_block_start, base_block_end FROM comments_edit_proposals WHERE comment_id = ?`,
      )
      .get(proposal.thread.id) as {
      base_block_start: number;
      base_block_end: number;
    };
    expect(row.base_block_start).toBeNumber();
    expect(row.base_block_end).toBeNumber();
    expect(source.slice(row.base_block_start, row.base_block_end)).toBe('alpha');

    const acceptRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ action: 'accept' }),
        },
      ),
    );
    expect(acceptRes.status).toBe(200);

    // Diff renders the original block content from base_oid using the
    // stored byte range — no anchor_block_id lookup, no source_snapshot.
    const diffRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/diff`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(diffRes.status).toBe(200);
    const diff = (await diffRes.json()) as { before: string; after: string };
    expect(diff.before).toBe('alpha');
    expect(diff.after).toBe('beta');
  });

  test('createThread populates branch_ref and base_oid for proposal threads (#25)', async () => {
    // The proposal route now also writes a one-commit branch on
    // refs/proposals/<id>. The branch ref + the main tip at create time
    // are persisted alongside proposed_text so accept can use git.merge
    // for conflict detection.
    const source = '# Title\n\nalpha';
    const created = await upload(CLIENT_A, { markdown: source });
    const blockId = [...locateAllBlocks(source).entries()].find(
      ([, range]) => range.text === 'alpha',
    )?.[0];
    expect(blockId).toBeString();

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'alpha' },
          proposal: { proposed_text: 'beta' },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { thread } = (await res.json()) as {
      thread: { id: string; comments: [{ body: string }] };
    };
    expect(thread.comments[0].body).toBe('Proposed change');

    const row = app.db
      .prepare(`SELECT branch_ref, base_oid FROM comments_edit_proposals WHERE comment_id = ?`)
      .get(thread.id) as { branch_ref: string | null; base_oid: string | null };
    expect(row.branch_ref).toBe(`refs/proposals/${thread.id}`);
    expect(row.base_oid).toBeString();

    // The branch's tip must contain the spliced source (full doc with the
    // block replaced) so accept can git-merge it later.
    const tip = await app.store.readProposalTip(
      { uid: created.uid, format: 'markdown' },
      thread.id,
    );
    expect(tip).toBe('# Title\n\nbeta');
  });

  test('two proposals on different blocks both accept cleanly even after the first one moves main (#25)', async () => {
    // Adjacent-but-non-overlapping edits — iso-git's 3-way merge handles
    // this for us via the precheck (status='clean'), so the second accept
    // must succeed.
    const source = '# Title\n\nfirst\n\nsecond';
    const created = await upload(CLIENT_A, { markdown: source });
    const blocks = [...locateAllBlocks(source).entries()];
    const firstId = blocks.find(([, r]) => r.text === 'first')?.[0];
    const secondId = blocks.find(([, r]) => r.text === 'second')?.[0];
    expect(firstId).toBeString();
    expect(secondId).toBeString();

    async function propose(blockId: string, quote: string, text: string): Promise<string> {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}/threads`, {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({
            anchor: { block_id: blockId, quote },
            proposal: { proposed_text: text },
          }),
        }),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { thread: { id: string } };
      return body.thread.id;
    }

    const a = await propose(firstId!, 'first', 'first edited');
    const b = await propose(secondId!, 'second', 'second edited');

    for (const id of [a, b]) {
      const acceptRes = await app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}/threads/${id}/respond`, {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ action: 'accept' }),
        }),
      );
      expect(acceptRes.status).toBe(200);
    }

    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(docRes.status).toBe(200);
    const doc = (await docRes.json()) as { source: string };
    expect(doc.source).toContain('first edited');
    expect(doc.source).toContain('second edited');
  });

  test('health endpoint', async () => {
    const res = await app.hono.fetch(new Request('http://test/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('version endpoint returns the release without allowing a cached response', async () => {
    const res = await app.hono.fetch(new Request('http://test/api/version'));

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(await res.json()).toEqual({ releaseVersion: '1a2b3c4' });
  });

  test('PATCH settings: admin-only, updates theme + rotates password', async () => {
    const created = await upload(CLIENT_A);

    // Bob (no invite) → 403 (he's a reader, not admin)
    const forbid = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: headersFor(CLIENT_B),
        body: JSON.stringify({ default_theme: 'book' }),
      }),
    );
    expect(forbid.status).toBe(403);

    // Alice (admin via invite) updates the theme.
    const r1 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ default_theme: 'book' }),
      }),
    );
    expect(r1.status).toBe(200);
    const j1 = (await r1.json()) as { default_theme: string };
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
    expect(r2.headers.get('set-cookie')).toContain(SESSION_COOKIE);
  });

  test('PATCH settings: mermaid_renderer accepts mmdr / chromium / null and rejects garbage', async () => {
    const created = await upload(CLIENT_A);

    // mmdr override
    const r1 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ mermaid_renderer: 'mmdr' }),
      }),
    );
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { mermaid_renderer: string | null }).mermaid_renderer).toBe(
      'mmdr',
    );

    // chromium override
    const r2 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ mermaid_renderer: 'chromium' }),
      }),
    );
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { mermaid_renderer: string | null }).mermaid_renderer).toBe(
      'chromium',
    );

    // explicit null clears the override
    const r3 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ mermaid_renderer: null }),
      }),
    );
    expect(r3.status).toBe(200);
    expect(((await r3.json()) as { mermaid_renderer: string | null }).mermaid_renderer).toBeNull();

    // garbage rejected (don't silently coerce — old client typos
    // shouldn't accidentally clear the value).
    const r4 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ mermaid_renderer: 'merman' }),
      }),
    );
    expect(r4.status).toBe(400);
    expect((await r4.json()) as { error: string }).toEqual({ error: 'invalid-mermaid-renderer' });

    // GET surfaces the field in the document payload.
    const get = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(get.status).toBe(200);
    const docJson = (await get.json()) as { mermaid_renderer: string | null };
    expect(docJson).toHaveProperty('mermaid_renderer');
    expect(docJson.mermaid_renderer).toBeNull(); // last patch was a clear
  });

  test('password auth supports session-only cookies and explicit logout', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Secret',
      password_protected: true,
    });

    const authRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/auth`, {
        method: 'POST',
        headers: headersFor(CLIENT_A),
        body: JSON.stringify({ password: created.password, remember: false }),
      }),
    );
    expect(authRes.status).toBe(204);
    const setCookie = authRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(SESSION_COOKIE);
    expect(setCookie).not.toContain('Max-Age=');
    const cookie = setCookie.split(';')[0] ?? '';

    const beforeLogout = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: headersFor(CLIENT_A, { cookie }),
      }),
    );
    expect(beforeLogout.status).toBe(200);

    const logout = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/logout`, {
        method: 'POST',
        headers: headersFor(CLIENT_A, { cookie }),
      }),
    );
    expect(logout.status).toBe(204);
    expect(logout.headers.get('set-cookie')).toContain(`${SESSION_COOKIE}=;`);

    const afterLogout = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: headersFor(CLIENT_A, { cookie }),
      }),
    );
    expect(afterLogout.status).toBe(401);
    expect((await afterLogout.json()) as { error: string }).toEqual({
      error: 'password-required',
    });
  });

  test('enabling password protection keeps the admin authenticated so it can be undone immediately', async () => {
    const created = await upload(CLIENT_A);

    const enable = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ password: 'rotate' }),
      }),
    );
    expect(enable.status).toBe(200);
    const enableCookie = (enable.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(enableCookie).toContain(SESSION_COOKIE);

    const disable = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(
          headersFor(CLIENT_A, { cookie: enableCookie }),
          created.admin_invite.token,
        ),
        body: JSON.stringify({ password: null }),
      }),
    );
    expect(disable.status).toBe(200);
    const disabled = (await disable.json()) as { password_protected: boolean };
    expect(disabled.password_protected).toBe(false);
  });

  test('password rotation preserves a session-only login when refreshing the initiator session', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Secret',
      password_protected: true,
    });
    const cookie = await authenticateForDoc(created.uid, created.password!, CLIENT_A, {
      remember: false,
    });

    const rotate = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A, { cookie }), created.admin_invite.token),
        body: JSON.stringify({ password: 'rotate' }),
      }),
    );
    expect(rotate.status).toBe(200);
    expect(rotate.headers.get('set-cookie')).toContain(SESSION_COOKIE);
    expect(rotate.headers.get('set-cookie')).not.toContain('Max-Age=');
  });

  test('DELETE /api/documents/:uid (admin only) removes doc + all per-doc tables', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });

    // Populate every per-doc table we care about so the delete has
    // something to wipe. Authorizing as admin also inserts a doc_users row.
    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    const doc = (await docRes.json()) as { rendered: { blocks: Array<{ id: string }> } };
    const blockId = doc.rendered.blocks[0]!.id;
    const threadRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Hi' }, body: 'a' }),
      }),
    );
    const thread = (await threadRes.json()) as { thread: { id: string } };
    await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${thread.thread.id}/comments/${thread.thread.id}/reactions`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ emoji: '👍' }),
        },
      ),
    );
    await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Hi' },
          proposal: {
            anchor_kind: 'heading',
            proposed_text: '# Hello',
          },
        }),
      }),
    );

    const assetForm = new FormData();
    assetForm.append('file', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'a.png');
    assetForm.append('ref_name', 'a.png');
    await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/assets`, {
        method: 'POST',
        // No content-type: FormData sets the multipart boundary itself.
        headers: new Headers({
          [CLIENT_HEADER]: CLIENT_A.id,
          [CLIENT_NAME_HEADER]: CLIENT_A.name,
          [INVITE_HEADER]: created.admin_invite.token,
        }),
        body: assetForm,
      }),
    );

    // A keyring holding this doc's invite token — the copy that survives
    // on the owner's other devices unless deletion sweeps it too.
    await app.hono.fetch(
      new Request('http://test/api/keyrings', {
        method: 'POST',
        headers: headersFor(CLIENT_A),
        body: JSON.stringify({
          docs: [{ doc_uid: created.uid, invite_token: created.admin_invite.token }],
        }),
      }),
    );

    // Sanity — the rows we expect to be wiped actually exist.
    const countBefore = (table: string): number => {
      if (table === 'comments_edit_proposals') {
        return (
          app.db
            .prepare(
              `SELECT count(*) AS n
               FROM comments_edit_proposals
              WHERE comment_id IN (SELECT id FROM comments WHERE doc_uid = ?)`,
            )
            .get(created.uid) as { n: number }
        ).n;
      }
      return (
        app.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE doc_uid = ?`).get(created.uid) as {
          n: number;
        }
      ).n;
    };
    expect(countBefore('doc_users')).toBeGreaterThan(0);
    expect(countBefore('comments_edit_proposals')).toBeGreaterThan(0);
    expect(countBefore('comments')).toBeGreaterThan(0);
    expect(countBefore('comment_reactions')).toBeGreaterThan(0);
    expect(countBefore('invites')).toBeGreaterThan(0);
    expect(countBefore('document_assets')).toBeGreaterThan(0);
    expect(countBefore('keyring_docs')).toBeGreaterThan(0);

    // Non-admin can't delete. Bob is a reader on this public doc (no
    // invite) → authorize succeeds with role=reader, then the admin check
    // inside deleteDocument rejects with 403.
    const denied = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'DELETE',
        headers: headersFor(CLIENT_B),
      }),
    );
    expect(denied.status).toBe(403);

    const ok = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'DELETE',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(ok.status).toBe(204);

    // Gone from every API surface:
    for (const path of [`/api/documents/${created.uid}`, `/api/documents/${created.uid}/history`]) {
      const r = await app.hono.fetch(
        new Request(`http://test${path}`, {
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        }),
      );
      expect(r.status).toBe(404);
    }

    // And gone from every per-doc table — no orphaned rows.
    for (const table of [
      'comments',
      'comments_edit_proposals',
      'comment_mentions',
      'comment_reactions',
      'doc_users',
      'invites',
      'sessions',
      'document_assets',
      'keyring_docs',
    ]) {
      expect(countBefore(table)).toBe(0);
    }

    // The blob itself, not just the junction row: nothing else referenced it.
    expect((app.db.prepare('SELECT count(*) AS n FROM assets').get() as { n: number }).n).toBe(0);
  });

  test('admin invite cannot be deleted; other invites can', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });

    // Try to delete the admin invite → 403.
    const rAdmin = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/invites/${created.admin_invite.token}`,
        {
          method: 'DELETE',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        },
      ),
    );
    expect(rAdmin.status).toBe(403);
    const body = (await rAdmin.json()) as { error: string };
    expect(body.error).toBe('admin-invite-not-deletable');

    // Create a collaborator invite and delete it → 204.
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Oli', role: 'collaborator' }),
      }),
    );
    expect(mkRes.status).toBe(201);
    const { invite } = (await mkRes.json()) as { invite: { token: string } };
    const rOli = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites/${invite.token}`, {
        method: 'DELETE',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(rOli.status).toBe(204);
  });

  test('role gating: reader cannot comment, collaborator can, editor can edit', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });
    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    const block = ((await docRes.json()) as { rendered: { blocks: Array<{ id: string }> } })
      .rendered.blocks[0]!.id;

    async function mkInvite(role: string) {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}/invites`, {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ display_name: role, role }),
        }),
      );
      return ((await res.json()) as { invite: { token: string } }).invite.token;
    }

    const readerToken = await mkInvite('reader');
    const collaboratorToken = await mkInvite('collaborator');
    const editorToken = await mkInvite('editor');

    async function postComment(token: string) {
      return app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}/threads`, {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_B), token),
          body: JSON.stringify({ anchor: { block_id: block, quote: 'Hi' }, body: 'x' }),
        }),
      );
    }

    expect((await postComment(readerToken)).status).toBe(403);
    expect((await postComment(collaboratorToken)).status).toBe(201);

    async function editAs(token: string) {
      return app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}`, {
          method: 'PUT',
          headers: withInvite(headersFor(CLIENT_B), token),
          body: JSON.stringify({ markdown: '# Edited' }),
        }),
      );
    }
    expect((await editAs(collaboratorToken)).status).toBe(403);
    expect((await editAs(editorToken)).status).toBe(200);
  });

  test('export + import roundtrip preserves source, name, theme, threads, and proposals', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Hi\n\nOriginal.\n',
      name: 'Original Name',
      default_theme: 'book',
    });
    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    const doc = (await docRes.json()) as {
      rendered: {
        blocks: Array<{
          id: string;
          headingPath: string[];
          sectionIndex: number;
          sectionIndexPath: number[];
        }>;
      };
    };
    const firstBlock = doc.rendered.blocks[0]!;
    const commentRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: {
            block_id: firstBlock.id,
            quote: 'Hi',
            heading_path: firstBlock.headingPath,
            section_index: firstBlock.sectionIndex,
            section_index_path: firstBlock.sectionIndexPath,
          },
          body: 'export me',
        }),
      }),
    );
    expect(commentRes.status).toBe(201);
    const commentThread = (await commentRes.json()) as { thread: { id: string } };

    const commentReplyRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${commentThread.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ body: 'plain reply' }),
        },
      ),
    );
    expect(commentReplyRes.status).toBe(200);

    const proposalRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: {
            block_id: firstBlock.id,
            quote: 'Hi',
            heading_path: firstBlock.headingPath,
            section_index: firstBlock.sectionIndex,
            section_index_path: firstBlock.sectionIndexPath,
          },
          body: 'please improve this heading',
          proposal: {
            anchor_kind: 'heading',
            proposed_text: '# Better Hi',
          },
        }),
      }),
    );
    expect(proposalRes.status).toBe(201);
    const proposalThread = (await proposalRes.json()) as { thread: { id: string } };

    const proposalReplyRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposalThread.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ body: 'proposal reply' }),
        },
      ),
    );
    expect(proposalReplyRes.status).toBe(200);

    const rejectRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposalThread.thread.id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
          body: JSON.stringify({ action: 'reject' }),
        },
      ),
    );
    expect(rejectRes.status).toBe(200);

    const exportRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(exportRes.status).toBe(200);
    const bundle = (await exportRes.json()) as {
      version: number;
      kind: string;
      document: { name: string | null; source: string; default_theme: string };
      representation: {
        blocks: Array<{ id: string; text: string }>;
        anchors: Array<{ id: string; text: string }>;
      };
      comments: Array<{
        id: string;
        body: string;
        parent_id: string | null;
        parent_proposal_id: string | null;
        anchor_heading_path: string[] | null;
        anchor_section_index: number | null;
        anchor_section_index_path: number[] | null;
        edit_proposal: {
          source_snapshot: string;
          proposed_text: string;
          status: string;
          accepted_oid: string | null;
          answers_comment_id: string | null;
        } | null;
      }>;
    };
    expect(bundle.kind).toBe('marginalia.document-bundle');
    expect(bundle.version).toBe(5);
    expect(bundle.document.name).toBe('Original Name');
    expect(bundle.document.source).toContain('Original.');
    expect(bundle.document.default_theme).toBe('book');
    expect(bundle.representation.blocks[0]!.text).toBe('Hi');
    expect(bundle.representation.anchors[0]!.id).toBe('hi');
    expect(bundle.comments).toHaveLength(4);
    const exportedComment = bundle.comments.find((comment) => comment.body === 'export me')!;
    expect(exportedComment.anchor_heading_path).toEqual(firstBlock.headingPath);
    expect(exportedComment.anchor_section_index).toBe(firstBlock.sectionIndex);
    expect(exportedComment.anchor_section_index_path).toEqual(firstBlock.sectionIndexPath);
    expect(bundle.comments.find((comment) => comment.body === 'plain reply')!.parent_id).toBe(
      exportedComment.id,
    );
    const exportedProposal = bundle.comments.find(
      (comment) => comment.body === 'please improve this heading',
    )!;
    expect(exportedProposal.edit_proposal).toEqual({
      source_snapshot: '# Hi',
      proposed_text: '# Better Hi',
      status: 'rejected',
      accepted_oid: null,
      answers_comment_id: null,
    });
    expect(
      bundle.comments.find((comment) => comment.body === 'proposal reply')!.parent_proposal_id,
    ).toBe(exportedProposal.id);

    // Import: anonymous-ish (Carol) creates a new doc from the bundle.
    const importRes = await app.hono.fetch(
      new Request('http://test/api/documents/import', {
        method: 'POST',
        headers: headersFor(CLIENT_C),
        body: JSON.stringify(bundle),
      }),
    );
    expect(importRes.status).toBe(201);
    const imported = (await importRes.json()) as {
      uid: string;
      admin_invite: { token: string };
      imported_comments: number;
      imported_edit_proposals: number;
    };
    expect(imported.imported_comments).toBe(4);
    expect(imported.imported_edit_proposals).toBe(1);

    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}`, {
        headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token),
      }),
    );
    const dupe = (await getRes.json()) as { source: string; name: string | null };
    expect(dupe.source).toContain('Original.');
    expect(dupe.name).toBe('Original Name');

    // `state=all`: the roundtrip is supposed to preserve resolution, so
    // the resolved thread is exactly the one worth looking at.
    const threadsRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}/threads?state=all`, {
        headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token),
      }),
    );
    expect(threadsRes.status).toBe(200);
    const importedThreads = (await threadsRes.json()) as {
      threads: Array<{
        id: string;
        state: string;
        resolution: { kind: string } | null;
        comments: [{ body: string }, ...Array<{ body: string }>];
        proposal: Record<string, unknown> | null;
      }>;
    };
    expect(importedThreads.threads).toHaveLength(2);
    const importedCommentThread = importedThreads.threads.find(
      (thread) => thread.comments[0].body === 'export me',
    )!;
    expect(importedCommentThread.proposal).toBeNull();
    expect(importedCommentThread.comments.slice(1).map((reply) => reply.body)).toEqual([
      'plain reply',
    ]);
    const importedProposalThread = importedThreads.threads.find(
      (thread) => thread.comments[0].body === 'please improve this heading',
    )!;
    expect(importedProposalThread.proposal).toEqual({
      source_snapshot: null,
      proposed_text: null,
      whole_document: false,
      answers_thread_id: null,
    });
    expect(importedProposalThread.state).toBe('resolved');
    expect(importedProposalThread.resolution?.kind).toBe('reject');
    expect(importedProposalThread.comments.slice(1).map((reply) => reply.body)).toEqual([
      'proposal reply',
    ]);
    // Diff endpoint recovers proposed_text + source_snapshot from the
    // proposal's branch + base_oid, even after the columns are gone.
    const importedDiffRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${imported.uid}/threads/${importedProposalThread.id}/diff`,
        { headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token) },
      ),
    );
    expect(importedDiffRes.status).toBe(200);
    // Rejected proposals don't carry a mergeable status — only open ones do.
    expect(await importedDiffRes.json()).toEqual({
      before: '# Hi',
      after: '# Better Hi',
      original: {
        before: '# Hi\n\nOriginal.\n',
        after: '# Better Hi\n\nOriginal.\n',
      },
      mergeable: null,
    });
  });

  test('export + import of an open proposal rebuilds the branch on import so accept goes through git.merge (#25)', async () => {
    // The bundle format intentionally carries proposed_text / source_snapshot
    // but not branch_ref / base_oid (those are per-repo identifiers that
    // can't survive a cross-environment transfer). Import re-uses the
    // boot-time backfill helper to rebuild refs/proposals/<pid> from
    // proposed_text against the imported main tip — making the imported
    // proposal eligible for the git.merge accept path, not the legacy
    // splice fallback.
    const created = await upload(CLIENT_A, {
      markdown: '# Title\n\nalpha',
    });
    const blockId = [...locateAllBlocks('# Title\n\nalpha').entries()].find(
      ([, range]) => range.text === 'alpha',
    )?.[0];
    expect(blockId).toBeString();

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'alpha' },
          body: 'please change this',
          proposal: { proposed_text: 'beta' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);

    const exportRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(exportRes.status).toBe(200);
    const bundle = (await exportRes.json()) as Record<string, unknown>;

    // Bundle shape contract: branch_ref / base_oid are NOT in the per-
    // proposal payload. proposed_text + source_snapshot are.
    const exportedComments = bundle.comments as Array<{
      edit_proposal: Record<string, unknown> | null;
    }>;
    const exportedProposal = exportedComments
      .map((c) => c.edit_proposal)
      .find((p) => p !== null) as Record<string, unknown>;
    expect(Object.keys(exportedProposal)).toEqual(
      expect.arrayContaining(['proposed_text', 'source_snapshot', 'status']),
    );
    expect(Object.keys(exportedProposal)).not.toContain('branch_ref');
    expect(Object.keys(exportedProposal)).not.toContain('base_oid');
    expect(exportedProposal.proposed_text).toBe('beta');
    expect(exportedProposal.source_snapshot).toBe('alpha');

    const importRes = await app.hono.fetch(
      new Request('http://test/api/documents/import', {
        method: 'POST',
        headers: headersFor(CLIENT_C),
        body: JSON.stringify(bundle),
      }),
    );
    expect(importRes.status).toBe(201);
    const imported = (await importRes.json()) as {
      uid: string;
      admin_invite: { token: string };
    };

    // After import, the open proposal must have a fresh branch_ref +
    // base_oid pointing into the imported repo.
    const importedProposalRow = app.db
      .prepare(
        `SELECT cep.comment_id, cep.branch_ref, cep.base_oid, cep.base_block_start, cep.base_block_end
           FROM comments_edit_proposals cep
           JOIN comments c ON c.id = cep.comment_id
          WHERE c.doc_uid = ? AND cep.status = 'open'`,
      )
      .get(imported.uid) as {
      comment_id: string;
      branch_ref: string;
      base_oid: string;
      base_block_start: number;
      base_block_end: number;
    };
    expect(importedProposalRow.branch_ref).toBe(`refs/proposals/${importedProposalRow.comment_id}`);
    expect(importedProposalRow.base_oid).toBeString();
    expect(importedProposalRow.base_block_start).toBeNumber();
    expect(importedProposalRow.base_block_end).toBeNumber();

    // The branch tip must contain the spliced source — confirms inline
    // branch creation ran end-to-end and the branch is mergeable.
    const tip = await app.store.readProposalTip(
      { uid: imported.uid, format: 'markdown' },
      importedProposalRow.comment_id,
    );
    expect(tip).toBe('# Title\n\nbeta');

    // And accepting it should now go through git.merge — exercise it
    // and confirm the doc source updates.
    const acceptRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${imported.uid}/threads/${importedProposalRow.comment_id}/respond`,
        {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token),
          body: JSON.stringify({ action: 'accept' }),
        },
      ),
    );
    expect(acceptRes.status).toBe(200);

    const docAfter = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}`, {
        headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token),
      }),
    );
    const docBody = (await docAfter.json()) as { source: string };
    expect(docBody.source).toBe('# Title\n\nbeta');
  });

  test('import preserves orphaned open proposals as proposal threads', async () => {
    const importRes = await app.hono.fetch(
      new Request('http://test/api/documents/import', {
        method: 'POST',
        headers: headersFor(CLIENT_C),
        body: JSON.stringify({
          version: 4,
          kind: 'marginalia.document-bundle',
          exported_at: Date.now(),
          document: {
            name: 'Orphaned proposal bundle',
            source: '# Imported\n\nCurrent text.\n',
            format: 'markdown',
            default_theme: 'default',
          },
          comments: [
            {
              id: 'orphan-proposal',
              parent_id: null,
              parent_proposal_id: null,
              anchor_block_id: null,
              anchor_quote: 'Old text that no longer exists.',
              author_client_id: CLIENT_A.id,
              author_display_name: CLIENT_A.name,
              body: '',
              link_status: 'orphaned',
              created_at: 1,
              updated_at: 1,
              edit_proposal: {
                source_snapshot: 'Old text that no longer exists.',
                proposed_text: 'Replacement text.',
                status: 'open',
                accepted_oid: null,
              },
            },
          ],
        }),
      }),
    );
    expect(importRes.status).toBe(201);
    const imported = (await importRes.json()) as {
      uid: string;
      admin_invite: { token: string };
      imported_comments: number;
      imported_edit_proposals: number;
    };
    expect(imported.imported_comments).toBe(1);
    expect(imported.imported_edit_proposals).toBe(1);

    const threadsRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}/threads`, {
        headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token),
      }),
    );
    expect(threadsRes.status).toBe(200);
    const importedThreads = (await threadsRes.json()) as {
      threads: Array<{
        id: string;
        link_status: string;
        anchor: { block_id: string | null };
        capabilities: { accept: boolean; reject: boolean };
        proposal: {
          source_snapshot: string | null;
          proposed_text: string | null;
          whole_document: boolean;
          answers_thread_id: string | null;
        } | null;
        comments: [{ body: string }];
      }>;
    };
    expect(importedThreads.threads).toHaveLength(1);
    const [thread] = importedThreads.threads;
    expect(thread!.link_status).toBe('orphaned');
    expect(thread!.anchor.block_id).toBeNull();
    expect(thread!.proposal).toEqual({
      source_snapshot: null,
      proposed_text: null,
      whole_document: false,
      answers_thread_id: null,
    });
    expect(thread!.capabilities.accept).toBe(false);
    expect(thread!.capabilities.reject).toBe(true);

    const diffRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}/threads/${thread!.id}/diff`, {
        headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token),
      }),
    );
    expect(diffRes.status).toBe(410);
  });

  test('GET /:uid/export.docx returns a themed Word document (binary)', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Export me\n\nA paragraph with **bold** text.\n',
      name: 'DOCX fixture',
      default_theme: 'beautiful',
    });

    // No explicit theme query → route uses doc.default_theme.
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.docx`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(res.headers.get('content-disposition')).toMatch(/filename="DOCX_fixture\.docx"/);
    const buf = Buffer.from(await res.arrayBuffer());
    // ZIP magic (docx is a zip).
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf[2]).toBe(0x03);
    expect(buf[3]).toBe(0x04);
    expect(buf.length).toBeGreaterThan(500);

    // Explicit ?theme=... overrides the default and still works.
    const res2 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.docx?theme=technical`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res2.status).toBe(200);
    const buf2 = Buffer.from(await res2.arrayBuffer());
    // Different tokens → different bytes (sanity check).
    expect(buf.equals(buf2)).toBe(false);
  });

  test('GET /:uid/export.chapters.zip returns numbered, lossless Markdown chapters', async () => {
    const source =
      '# The Salt Road\n\nIntroduction.\n\n## Departure\n\nFirst.\n\n## The Dunes\n\nSecond.\n';
    const created = await upload(CLIENT_A, { markdown: source, name: 'Salt Road' });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.chapters.zip`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/zip');
    expect(res.headers.get('content-disposition')).toContain('Salt_Road-chapters.zip');

    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const names = Object.keys(zip.files).sort();
    expect(names).toEqual(['Salt_Road-chapter-001.md', 'Salt_Road-chapter-002.md']);
    const chapterOne = await zip.file(names[0]!)!.async('string');
    const chapterTwo = await zip.file(names[1]!)!.async('string');
    expect(chapterOne).toContain('# The Salt Road');
    expect(chapterOne).toContain('## Departure');
    expect(chapterTwo).toStartWith('## The Dunes');
    expect(chapterOne + chapterTwo).toBe(source);
  });

  test('POST /:uid/export.epub creates chapters and a title-generated cover', async () => {
    const created = await upload(CLIENT_A, {
      markdown:
        '# The Salt Road\n\n## Departure\n\nFirst.\n\n---\n\nA scene break.\n\n## The Dunes\n\nSecond.\n',
    });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.epub?theme=beautiful`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/epub+zip');
    expect(res.headers.get('content-disposition')).toContain('The_Salt_Road.epub');

    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(await zip.file('mimetype')!.async('string')).toBe('application/epub+zip');
    expect(zip.file('META-INF/container.xml')).not.toBeNull();
    expect(zip.file('EPUB/images/cover.svg')).not.toBeNull();
    expect(zip.file('EPUB/chapter-001.xhtml')).not.toBeNull();
    expect(zip.file('EPUB/chapter-002.xhtml')).not.toBeNull();
    const packageXml = await zip.file('EPUB/package.opf')!.async('string');
    expect(packageXml).toContain('properties="cover-image"');
    expect(packageXml).toContain('<dc:title>The Salt Road</dc:title>');
    const firstChapter = await zip.file('EPUB/chapter-001.xhtml')!.async('string');
    expect(firstChapter).toContain('class="epub-hr-ornament"');
    expect(firstChapter).toContain('360,20 374,36 360,52 346,36');
    expect(firstChapter).not.toContain('<hr');
  });

  test('POST /:uid/export.epub embeds an uploaded raster cover', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Covered Book\n\nBody.\n' });
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      ),
      (char) => char.charCodeAt(0),
    );
    const form = new FormData();
    form.append('cover', new Blob([png], { type: 'image/png' }), 'cover.png');
    const headers = withInvite(headersFor(CLIENT_A), created.admin_invite.token);
    headers.delete('content-type');
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.epub`, {
        method: 'POST',
        headers,
        body: form,
      }),
    );
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const exported = await zip.file('EPUB/images/cover.png')!.async('uint8array');
    expect(exported).toEqual(png);
    expect(zip.file('EPUB/images/cover.svg')).toBeNull();
  });

  test('POST /:uid/export.epub falls back to the document’s stored cover', async () => {
    // The dialog saves the cover on the document once; every later
    // export has to pick it up without the client re-sending bytes.
    const created = await upload(CLIENT_A, { markdown: '# Stored Cover\n\nBody.\n' });
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      ),
      (char) => char.charCodeAt(0),
    );
    const coverForm = new FormData();
    coverForm.append('file', new Blob([png as BlobPart]), 'art.png');
    const coverHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);
    coverHeaders.delete('content-type');
    const stored = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/cover`, {
        method: 'PUT',
        headers: coverHeaders,
        body: coverForm,
      }),
    );
    expect(stored.status).toBe(201);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.epub`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(await zip.file('EPUB/images/cover.png')!.async('uint8array')).toEqual(png);
    expect(zip.file('EPUB/images/cover.svg')).toBeNull();
  });

  test('POST /:uid/export.epub emits well-formed XHTML without rewriting content', async () => {
    // Regression guard for the HTML→XHTML step. Bare attributes and
    // unclosed void elements are fatal to an EPUB reader, but so is
    // "fixing" them with a document-wide pattern: prose that reads
    // like an attribute, and attribute values containing `>`, both
    // used to come out corrupted.
    const prose =
      'The legacy endpoint is disabled in production. Multiple readers may be selected at once; the field is readonly until checked.';
    const created = await upload(CLIENT_A, {
      markdown: `# Angles\n\n${prose}\n\n- [ ] open\n- [x] done\n\n![a > b](pic.png "t > u")\n\n![two checked boxes](pic2.png)\n`,
    });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.epub`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const chapter = await zip.file('EPUB/chapter-001.xhtml')!.async('string');

    expect(chapter).toContain(prose);
    // Void elements closed, attribute values untouched either side of
    // the `>` that used to truncate the tag.
    expect(chapter).toContain('<img src="pic.png" alt="a > b" title="t > u" />');
    expect(chapter).toContain('<img src="pic2.png" alt="two checked boxes" />');
    // Task-list booleans do get the XML treatment they need.
    expect(chapter).toContain('<input type="checkbox" disabled="disabled" />');
    expect(chapter).toContain('<input type="checkbox" checked="checked" disabled="disabled" />');

    for (const name of [
      'META-INF/container.xml',
      'EPUB/package.opf',
      'EPUB/toc.ncx',
      'EPUB/nav.xhtml',
      'EPUB/cover.xhtml',
      'EPUB/chapter-001.xhtml',
      'EPUB/images/cover.svg',
    ]) {
      expectWellFormedXml(name, await zip.file(name)!.async('string'));
    }
  });

  test('POST /:uid/export.epub hides heading-anchor chrome and never ships mermaid source as prose', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Diagrams\n\n## One\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
    });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.epub`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));

    // The renderer puts an `#` permalink sigil in every heading; it's
    // viewer chrome, and the book stylesheet has to drop it the same
    // way the print stylesheet does.
    expect(await zip.file('EPUB/styles.css')!.async('string')).toContain('.heading-anchor');

    // Whether or not a mermaid engine is installed on this machine,
    // no diagram may reach the reader as a bare div of source text:
    // it's either a rasterized image or an explicit code listing.
    const chapter = await zip.file('EPUB/chapter-001.xhtml')!.async('string');
    expect(chapter).not.toContain('data-mermaid-index');
    const rasterized = /<img src="images\/[^"]+\.png"/.test(chapter);
    expect(rasterized || chapter.includes('<pre class="mermaid-source">')).toBe(true);
    expectWellFormedXml('EPUB/chapter-001.xhtml', chapter);
  });

  test('POST /:uid/export.epub externalizes attached images and drops unusable ones', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Assets\n\n![logo](logo.png)\n\n![ledger](notes.txt)\n',
    });
    const assetHeaders = withInvite(
      new Headers({ [CLIENT_HEADER]: CLIENT_A.id, [CLIENT_NAME_HEADER]: CLIENT_A.name }),
      created.admin_invite.token,
    );
    const attach = async (refName: string, bytes: Uint8Array, type: string): Promise<number> => {
      const form = new FormData();
      form.append('file', new Blob([bytes as BlobPart], { type }), refName);
      form.append('ref_name', refName);
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}/assets`, {
          method: 'POST',
          headers: assetHeaders,
          body: form,
        }),
      );
      return res.status;
    };
    const png = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      ),
      (char) => char.charCodeAt(0),
    );
    expect(await attach('logo.png', png, 'image/png')).toBe(201);
    // Server derives the mime from the ref_name, so this attachment is
    // text/plain no matter what the markdown does with it.
    expect(await attach('notes.txt', new TextEncoder().encode('not an image'), 'text/plain')).toBe(
      201,
    );

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.epub`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const chapter = await zip.file('EPUB/chapter-001.xhtml')!.async('string');
    const packageXml = await zip.file('EPUB/package.opf')!.async('string');

    // The PNG becomes a real container resource, declared in the manifest.
    const embedded = /src="(images\/[0-9a-f]+\.png)"/.exec(chapter)?.[1];
    expect(embedded).toBeDefined();
    expect(zip.file(`EPUB/${embedded}`)).not.toBeNull();
    expect(packageXml).toContain(`href="${embedded}"`);

    // Nothing usable to point the second one at: `src=""` would re-request
    // the chapter and a `data:` URL isn't a container resource, so the
    // attribute goes away and the alt text stands in.
    expect(chapter).not.toContain('src=""');
    expect(chapter).not.toContain('data:');
    expect(chapter).toContain('alt="ledger"');
    expectWellFormedXml('EPUB/chapter-001.xhtml', chapter);
  });

  test('GET /:uid/export.docx filename derives from the document title when name is unset', async () => {
    // No explicit `name` on upload → server should fall back to the
    // H1 as the filename (not the opaque uid).
    const created = await upload(CLIENT_A, {
      markdown: '---\ntitle: My Great Doc\n---\n\n# A Body Heading\n\nBody.\n',
    });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.docx`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    // Frontmatter title beats the H1 — matches extractDocumentTitle's
    // priority. Non-filename chars get sanitized to `_`.
    expect(res.headers.get('content-disposition')).toMatch(/filename="My_Great_Doc\.docx"/);
  });

  test('GET /:uid/export.docx falls back to uid when no title is derivable', async () => {
    const created = await upload(CLIENT_A, {
      markdown: 'Just a paragraph, no heading, no frontmatter.\n',
    });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.docx`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`filename="${created.uid}.docx"`);
  });

  test('GET /:uid/export.docx falls back to uid when the title sanitizes to empty', async () => {
    // A title made up entirely of characters the filename sanitizer
    // strips (e.g. emoji / punctuation) would previously have yielded
    // `filename=".docx"`. Now we fall back to the uid.
    const created = await upload(CLIENT_A, {
      markdown: '# 🎉✨\n\nBody.\n',
    });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.docx`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    const cd = res.headers.get('content-disposition') ?? '';
    expect(cd).not.toMatch(/filename="\.docx"/);
    expect(cd).toContain(`filename="${created.uid}.docx"`);
  });

  // ---------------------------------------------------------------
  // Review-mode export — closed threads (resolved / accepted /
  // rejected) must not appear in the exported DOCX by default.
  //
  // These tests exercise the full server route — they're the
  // belt-and-braces that proves the in-memory `isThreadClosed`
  // filter in `loadReviewThreadsForExport` (run after the SQL load,
  // before `readProposalContent`) actually keeps closed threads
  // out of `word/document.xml` and `word/comments.xml`.

  /**
   * Unzip an exported DOCX and return the concatenated text of the
   * parts review-mode tests care about (`word/document.xml` for
   * tracked-change runs, `word/comments.xml` for comment bodies).
   * Substring-asserting against the concatenation is enough for
   * "the closed thread's body must not appear anywhere" checks.
   */
  async function readDocxReviewParts(buf: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(buf);
    const document = (await zip.file('word/document.xml')?.async('string')) ?? '';
    const comments = (await zip.file('word/comments.xml')?.async('string')) ?? '';
    return `${document}\n${comments}`;
  }

  async function exportReviewDocx(uid: string, inviteToken: string): Promise<string> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/export.docx?review=both`, {
        headers: withInvite(headersFor(CLIENT_A), inviteToken),
      }),
    );
    expect(res.status).toBe(200);
    return readDocxReviewParts(Buffer.from(await res.arrayBuffer()));
  }

  test('GET /:uid/export.docx?review=both excludes resolved comment threads', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Doc\n\nFirst paragraph.\n\nSecond paragraph.\n',
      name: 'Resolved comment fixture',
    });
    const blocks = [
      ...locateAllBlocks('# Doc\n\nFirst paragraph.\n\nSecond paragraph.\n').entries(),
    ];
    const firstParaId = blocks.find(([, r]) => r.text === 'First paragraph.')![0];
    const secondParaId = blocks.find(([, r]) => r.text === 'Second paragraph.')![0];

    // Two comment threads: one will stay open, one will be resolved.
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);
    const openRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          anchor: { block_id: firstParaId, quote: 'First paragraph.' },
          body: 'OPEN_DISCUSSION',
        }),
      }),
    );
    expect(openRes.status).toBe(201);

    const closedRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          anchor: { block_id: secondParaId, quote: 'Second paragraph.' },
          body: 'CLOSED_DISCUSSION',
        }),
      }),
    );
    expect(closedRes.status).toBe(201);
    const closedThread = (await closedRes.json()) as { thread: { id: string } };
    const resolveRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${closedThread.thread.id}/respond`,
        {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ action: 'resolve' }),
        },
      ),
    );
    expect(resolveRes.status).toBe(200);

    const docText = await exportReviewDocx(created.uid, created.admin_invite.token);
    expect(docText).toContain('OPEN_DISCUSSION');
    expect(docText).not.toContain('CLOSED_DISCUSSION');
  });

  test('GET /:uid/export.docx?review=both excludes accepted edit proposals', async () => {
    const source = '# Doc\n\nThe original line.\n';
    const created = await upload(CLIENT_A, { markdown: source, name: 'Accepted prop fixture' });
    const blocks = [...locateAllBlocks(source).entries()];
    const blockId = blocks.find(([, r]) => r.text === 'The original line.')![0];

    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);
    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'The original line.' },
          body: 'ACCEPTED_RATIONALE',
          proposal: { proposed_text: 'The accepted line.' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()) as { thread: { id: string } };
    const acceptRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/respond`,
        {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ action: 'accept' }),
        },
      ),
    );
    expect(acceptRes.status).toBe(200);

    const docText = await exportReviewDocx(created.uid, created.admin_invite.token);
    // Accepted proposal must NOT contribute review chrome to the
    // export. The live doc already carries the proposed text
    // (acceptance applied the change), so we assert:
    //   - the rationale body is gone,
    //   - the source_snapshot ('The original line.') doesn't sneak
    //     back in via <w:del> — that would mean the closed-thread
    //     filter let the proposal payload through and the renderer
    //     re-emitted the pre-acceptance text as a tracked change.
    expect(docText).not.toContain('ACCEPTED_RATIONALE');
    expect(docText).not.toContain('The original line.');
    expect(docText).not.toMatch(/<w:del\b/);
  });

  test('GET /:uid/export.docx?review=both excludes rejected edit proposals', async () => {
    const source = '# Doc\n\nThe original wording.\n';
    const created = await upload(CLIENT_A, { markdown: source, name: 'Rejected prop fixture' });
    const blocks = [...locateAllBlocks(source).entries()];
    const blockId = blocks.find(([, r]) => r.text === 'The original wording.')![0];

    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);
    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'The original wording.' },
          body: 'REJECTED_RATIONALE',
          proposal: { proposed_text: 'A wording the team chose to skip.' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()) as { thread: { id: string } };
    const rejectRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/respond`,
        {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ action: 'reject' }),
        },
      ),
    );
    expect(rejectRes.status).toBe(200);

    const docText = await exportReviewDocx(created.uid, created.admin_invite.token);
    expect(docText).not.toContain('REJECTED_RATIONALE');
    expect(docText).not.toContain('A wording the team chose to skip.');
  });

  test('GET /:uid/export.docx?review=both keeps open proposals visible alongside resolved threads', async () => {
    // Sanity: with one open proposal AND one resolved comment thread
    // on the same doc, the export carries the open proposal but
    // drops the resolved comment.
    const source = '# Doc\n\nKeep me open.\n\nThis got resolved.\n';
    const created = await upload(CLIENT_A, { markdown: source, name: 'Mixed fixture' });
    const blocks = [...locateAllBlocks(source).entries()];
    const openId = blocks.find(([, r]) => r.text === 'Keep me open.')![0];
    const resolvedId = blocks.find(([, r]) => r.text === 'This got resolved.')![0];

    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);
    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          anchor: { block_id: openId, quote: 'Keep me open.' },
          body: 'OPEN_PROPOSAL_BODY',
          proposal: { proposed_text: 'Tightened wording.' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);

    const closedRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          anchor: { block_id: resolvedId, quote: 'This got resolved.' },
          body: 'OLD_DEBATE',
        }),
      }),
    );
    expect(closedRes.status).toBe(201);
    const closed = (await closedRes.json()) as { thread: { id: string } };
    const resolveRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads/${closed.thread.id}/respond`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ action: 'resolve' }),
      }),
    );
    expect(resolveRes.status).toBe(200);

    const docText = await exportReviewDocx(created.uid, created.admin_invite.token);
    expect(docText).toContain('OPEN_PROPOSAL_BODY');
    // The proposed text is split across runs by the inline word-diff
    // path (Keep↔Tightened, " ", me open↔wording, "."), so assert
    // both new tokens land in <w:ins> rather than expecting the
    // contiguous substring "Tightened wording".
    expect(docText).toMatch(/<w:ins\b[^>]*>[\s\S]*?Tightened/);
    expect(docText).toMatch(/<w:ins\b[^>]*>[\s\S]*?wording/);
    expect(docText).not.toContain('OLD_DEBATE');
  });

  test('GET /:uid/export.docx sets X-Content-Type-Options: nosniff', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Doc\n\nBody.\n',
      name: 'Some doc',
    });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.docx`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  test('GET /:uid/export.docx rejects unknown UID with 404', async () => {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents/does-not-exist/export.docx', {
        headers: headersFor(CLIENT_A),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('GET /:uid/export.docx embeds attached image assets', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Doc\n\n![logo](logo.png)\n',
      name: 'With logo',
    });

    // Upload a tiny 1x1 PNG as `logo.png` on this document.
    const PNG_BYTES = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    );
    const form = new FormData();
    form.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'logo.png');
    form.append('ref_name', 'logo.png');
    const uploadRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/assets`, {
        method: 'POST',
        headers: withInvite(
          new Headers({
            [CLIENT_HEADER]: CLIENT_A.id,
            [CLIENT_NAME_HEADER]: CLIENT_A.name,
          }),
          created.admin_invite.token,
        ),
        body: form,
      }),
    );
    expect(uploadRes.status).toBe(201);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.docx`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    // Unzip and check that at least one media entry landed inside the
    // DOCX — signals the asset resolver successfully fed bytes through.
    const { default: JSZip } = await import('jszip');
    const zip = await JSZip.loadAsync(buf);
    const media = Object.entries(zip.files)
      .filter(([p, e]) => p.startsWith('word/media/') && !e.dir)
      .map(([p]) => p);
    expect(media.length).toBe(1);
  });

  test('accepted-proposals downloads export a temporary merged source and DOCX', async () => {
    const source = '# Doc\n\nAlpha.\n\nBeta.\n';
    const created = await upload(CLIENT_A, { markdown: source, name: 'Proposal Doc' });
    const blocks = [...locateAllBlocks(source).entries()];
    const alpha = blocks.find(([, range]) => range.text === 'Alpha.');
    const beta = blocks.find(([, range]) => range.text === 'Beta.');
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);

    for (const [blockId, text, proposed] of [
      [alpha![0], 'Alpha.', 'Alpha accepted.'],
      [beta![0], 'Beta.', 'Beta accepted.'],
    ] as const) {
      const proposeRes = await app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}/threads`, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({
            anchor: { block_id: blockId, quote: text },
            proposal: { proposed_text: proposed },
          }),
        }),
      );
      expect(proposeRes.status).toBe(201);
    }

    const sourceRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.accepted-source`, {
        headers: adminHeaders,
      }),
    );
    expect(sourceRes.status).toBe(200);
    expect(sourceRes.headers.get('x-marginalia-proposals-applied')).toBe('2');
    expect(sourceRes.headers.get('x-marginalia-proposals-skipped')).toBe('0');
    expect(sourceRes.headers.get('content-disposition')).toContain(
      'Proposal_Doc-proposals-accepted.md',
    );
    const mergedSource = await sourceRes.text();
    expect(mergedSource).toContain('Alpha accepted.');
    expect(mergedSource).toContain('Beta accepted.');

    const docxRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.accepted.docx`, {
        headers: adminHeaders,
      }),
    );
    expect(docxRes.status).toBe(200);
    expect(docxRes.headers.get('x-marginalia-proposals-applied')).toBe('2');
    expect(docxRes.headers.get('x-marginalia-proposals-skipped')).toBe('0');
    expect(docxRes.headers.get('content-disposition')).toContain(
      'Proposal_Doc-proposals-accepted.docx',
    );
    const zip = await JSZip.loadAsync(Buffer.from(await docxRes.arrayBuffer()));
    const documentXml = await zip.file('word/document.xml')!.async('string');
    expect(documentXml).toContain('Alpha accepted.');
    expect(documentXml).toContain('Beta accepted.');

    const chaptersRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.accepted.chapters.zip`, {
        headers: adminHeaders,
      }),
    );
    expect(chaptersRes.status).toBe(200);
    expect(chaptersRes.headers.get('x-marginalia-proposals-applied')).toBe('2');
    const chaptersZip = await JSZip.loadAsync(Buffer.from(await chaptersRes.arrayBuffer()));
    const chapterSource = await chaptersZip.file('Proposal_Doc-chapter-001.md')!.async('string');
    expect(chapterSource).toContain('Alpha accepted.');
    expect(chapterSource).toContain('Beta accepted.');

    const epubRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.accepted.epub`, {
        method: 'POST',
        headers: adminHeaders,
      }),
    );
    expect(epubRes.status).toBe(200);
    expect(epubRes.headers.get('x-marginalia-proposals-applied')).toBe('2');
    expect(epubRes.headers.get('content-disposition')).toContain(
      'Proposal_Doc-proposals-accepted.epub',
    );
    const epubZip = await JSZip.loadAsync(Buffer.from(await epubRes.arrayBuffer()));
    const epubChapter = await epubZip.file('EPUB/chapter-001.xhtml')!.async('string');
    expect(epubChapter).toContain('Alpha accepted.');
    expect(epubChapter).toContain('Beta accepted.');

    const afterRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: adminHeaders }),
    );
    const after = (await afterRes.json()) as { source: string };
    expect(after.source).toBe(source);
  });

  test('accepted-proposals source download returns a partial file for conflicting proposals', async () => {
    const source = '# Doc\n\nAlpha.\n';
    const created = await upload(CLIENT_A, { markdown: source });
    const block = [...locateAllBlocks(source).entries()].find(
      ([, range]) => range.text === 'Alpha.',
    );
    expect(block).toBeDefined();
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);

    for (const proposed of ['First accepted.', 'Second accepted.']) {
      const proposeRes = await app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}/threads`, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({
            anchor: { block_id: block![0], quote: 'Alpha.' },
            proposal: { proposed_text: proposed },
          }),
        }),
      );
      expect(proposeRes.status).toBe(201);
    }

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.accepted-source`, {
        headers: adminHeaders,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-marginalia-proposals-applied')).toBe('1');
    expect(res.headers.get('x-marginalia-proposals-skipped')).toBe('1');
    expect(res.headers.get('content-disposition')).toContain('proposals-partial.md');
    const partial = await res.text();
    expect(partial).toContain('First accepted.');
    expect(partial).not.toContain('Second accepted.');
  });

  test('an imported bundle lands invite_only, whatever the source doc was', async () => {
    // Round-tripping an open document through export/import must not be a
    // way past the default — the import is a new document like any other.
    const source = await upload(CLIENT_A, { markdown: '# Open', invite_only: false });
    const exportRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${source.uid}/export`, {
        headers: withInvite(headersFor(CLIENT_A), source.admin_invite.token),
      }),
    );
    expect(exportRes.status).toBe(200);

    const importRes = await app.hono.fetch(
      new Request('http://test/api/documents/import', {
        method: 'POST',
        headers: headersFor(CLIENT_C),
        body: JSON.stringify(await exportRes.json()),
      }),
    );
    expect(importRes.status).toBe(201);
    const imported = (await importRes.json()) as {
      uid: string;
      invite_only: boolean;
      admin_invite: { token: string };
    };
    expect(imported.invite_only).toBe(true);

    const stranger = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(stranger.status).toBe(401);
    expect((await stranger.json()) as { error: string }).toEqual({ error: 'invite-required' });

    // ...and the source document is untouched by its own export.
    const original = await app.hono.fetch(
      new Request(`http://test/api/documents/${source.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(original.status).toBe(200);
  });

  test('import accepts legacy v1 bundles without representation', async () => {
    const importRes = await app.hono.fetch(
      new Request('http://test/api/documents/import', {
        method: 'POST',
        headers: headersFor(CLIENT_C),
        body: JSON.stringify({
          version: 1,
          kind: 'marginalia.document-bundle',
          exported_at: Date.now(),
          document: {
            name: 'Legacy',
            source: '# Legacy\n\nStill works.\n',
            editable_by_anyone: true,
            default_theme: 'technical',
          },
          comments: [],
        }),
      }),
    );
    expect(importRes.status).toBe(201);

    const imported = (await importRes.json()) as {
      uid: string;
      name: string | null;
      admin_invite: { token: string };
    };
    expect(imported.name).toBe('Legacy');

    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}`, {
        headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token),
      }),
    );
    expect(getRes.status).toBe(200);
    const doc = (await getRes.json()) as {
      source: string;
      default_theme: string;
    };
    expect(doc.source).toContain('Still works.');
    // Legacy bundles still carry `editable_by_anyone`; ACCESS_CONTROL Step 2
    // intentionally drops it from the imported doc — the importer reads the
    // field but no longer applies it.
    expect(doc.default_theme).toBe('technical');
  });

  test('import ignores malformed proposal relationships in bundles', async () => {
    const importRes = await app.hono.fetch(
      new Request('http://test/api/documents/import', {
        method: 'POST',
        headers: headersFor(CLIENT_C),
        body: JSON.stringify({
          version: 4,
          kind: 'marginalia.document-bundle',
          exported_at: Date.now(),
          document: {
            name: 'Malformed bundle',
            source: '# Imported\n',
            format: 'markdown',
            default_theme: 'default',
          },
          comments: [
            {
              id: 'root',
              parent_id: null,
              parent_proposal_id: null,
              author_client_id: CLIENT_A.id,
              author_display_name: CLIENT_A.name,
              body: 'root comment',
              link_status: 'linked',
              created_at: 1,
              updated_at: 1,
            },
            {
              id: 'reply-with-proposal',
              parent_id: 'root',
              parent_proposal_id: null,
              author_client_id: CLIENT_B.id,
              author_display_name: CLIENT_B.name,
              body: 'reply should not become a proposal',
              link_status: 'linked',
              created_at: 2,
              updated_at: 2,
              edit_proposal: {
                anchor_kind: 'heading',
                source_snapshot: '# Imported',
                proposed_text: '# Changed',
                status: 'open',
                accepted_oid: null,
              },
            },
            {
              id: 'dual-parent',
              parent_id: 'root',
              parent_proposal_id: 'root',
              author_client_id: CLIENT_A.id,
              author_display_name: CLIENT_A.name,
              body: 'invalid dual parent',
              link_status: 'linked',
              created_at: 3,
              updated_at: 3,
            },
          ],
        }),
      }),
    );
    expect(importRes.status).toBe(201);
    const imported = (await importRes.json()) as {
      uid: string;
      admin_invite: { token: string };
      imported_comments: number;
      imported_edit_proposals: number;
    };
    expect(imported.imported_comments).toBe(2);
    expect(imported.imported_edit_proposals).toBe(0);

    const threadsRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}/threads`, {
        headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token),
      }),
    );
    expect(threadsRes.status).toBe(200);
    const importedThreads = (await threadsRes.json()) as {
      threads: Array<{
        proposal: unknown;
        comments: [{ body: string }, ...Array<{ body: string }>];
      }>;
    };
    expect(importedThreads.threads).toHaveLength(1);
    expect(importedThreads.threads[0]!.proposal).toBeNull();
    expect(importedThreads.threads[0]!.comments.map((comment) => comment.body)).toEqual([
      'root comment',
      'reply should not become a proposal',
    ]);
  });

  // --- ACCESS_CONTROL Step 3: invite kinds + admin rotation ----------

  test('POST /invites: named-kind requires display_name; generic-kind forbids granting admin', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });
    const adminHeaders = withInvite(headersFor(CLIENT_A), created.admin_invite.token);

    // named without display_name → 400
    const r1 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'named', role: 'collaborator' }),
      }),
    );
    expect(r1.status).toBe(400);
    expect((await r1.json()).error).toBe('display_name-required');

    // kind='admin' from this endpoint → 400 (admin invites are not creatable)
    const r2 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'admin', role: 'admin', display_name: 'Sneaky' }),
      }),
    );
    expect(r2.status).toBe(400);
    expect((await r2.json()).error).toBe('admin-invite-not-creatable');

    // role='admin' with a non-admin kind → 400 (defense in depth)
    const r3 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'named', role: 'admin', display_name: 'Sneaky' }),
      }),
    );
    expect(r3.status).toBe(400);
    expect((await r3.json()).error).toBe('admin-role-not-grantable');

    // invalid kind → 400
    const r4 = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'bogus', role: 'reader' }),
      }),
    );
    expect(r4.status).toBe(400);

    // Valid named invite → 201, wire shape carries kind + display_name.
    const ok = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ kind: 'named', role: 'collaborator', display_name: 'Alice' }),
      }),
    );
    expect(ok.status).toBe(201);
    const okBody = (await ok.json()) as { invite: { kind: string; display_name: string | null } };
    expect(okBody.invite.kind).toBe('named');
    expect(okBody.invite.display_name).toBe('Alice');

    // Valid generic invite → 201, display_name is null regardless of what
    // the caller sent (we silently drop it).
    const gen = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({
          kind: 'generic',
          role: 'collaborator',
          display_name: 'ignored',
        }),
      }),
    );
    expect(gen.status).toBe(201);
    const genBody = (await gen.json()) as { invite: { kind: string; display_name: string | null } };
    expect(genBody.invite.kind).toBe('generic');
    expect(genBody.invite.display_name).toBeNull();
  });

  test('generic invite: visitor brings their own name; write endpoints require it', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi\n\nA para.\n' });
    const mk = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ kind: 'generic', role: 'collaborator' }),
      }),
    );
    const { invite } = (await mk.json()) as { invite: { token: string } };

    // Fetch the first block id so we can anchor a comment.
    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_B), invite.token),
      }),
    );
    expect(getRes.status).toBe(200);
    const docBody = (await getRes.json()) as {
      rendered: { blocks: Array<{ id: string }> };
      display_name: string | null;
    };
    // Generic invite forces no name → display_name is null.
    expect(docBody.display_name).toBeNull();
    const blockId = docBody.rendered.blocks[0]!.id;

    // POST /threads WITHOUT a client-name header → 400 identity-required.
    const noName = new Headers({
      'content-type': 'application/json',
      [CLIENT_HEADER]: CLIENT_B.id,
      [INVITE_HEADER]: invite.token,
    });
    const noNameRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: noName,
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Hi' }, body: 'x' }),
      }),
    );
    expect(noNameRes.status).toBe(400);
    expect((await noNameRes.json()).error).toBe('identity-required');

    // POST /threads WITH a client-name header → 201, authored as that name.
    const withName = withInvite(headersFor(CLIENT_B), invite.token);
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withName,
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Hi' }, body: 'x' }),
      }),
    );
    expect(res.status).toBe(201);
    const { thread } = (await res.json()) as {
      thread: { comments: [{ author: { display_name: string } }] };
    };
    expect(thread.comments[0].author.display_name).toBe(CLIENT_B.name);
  });

  test('admin rotation: old token stops working, new token grants admin', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });
    const oldToken = created.admin_invite.token;

    const rot = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites/admin/rotate`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), oldToken),
      }),
    );
    expect(rot.status).toBe(200);
    const { admin_invite } = (await rot.json()) as {
      admin_invite: { token: string; url: string; display_name: string };
    };
    expect(admin_invite.token).not.toBe(oldToken);
    expect(admin_invite.display_name).toBe(CLIENT_A.name);

    // Old token no longer exists → authorize falls through to role='reader'.
    // An admin-only endpoint (settings PATCH) therefore rejects with 403.
    const deniedOld = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), oldToken),
        body: JSON.stringify({ default_theme: 'book' }),
      }),
    );
    expect(deniedOld.status).toBe(403);

    // New token works.
    const okNew = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), admin_invite.token),
        body: JSON.stringify({ default_theme: 'book' }),
      }),
    );
    expect(okNew.status).toBe(200);

    // Non-admin cannot rotate.
    const denied = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites/admin/rotate`, {
        method: 'POST',
        headers: headersFor(CLIENT_B),
      }),
    );
    expect(denied.status).toBe(403);
  });

  test('password recovery follows admin invite rotation', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Secret',
      password_protected: true,
    });
    const cookie = await authenticateForDoc(created.uid, created.password!, CLIENT_A);

    const rot = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites/admin/rotate`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A, { cookie }), created.admin_invite.token),
      }),
    );
    expect(rot.status).toBe(200);
    const { admin_invite } = (await rot.json()) as {
      admin_invite: { token: string };
    };

    const recovered = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/password/recover`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), admin_invite.token),
      }),
    );
    expect(recovered.status).toBe(200);
    expect((await recovered.json()) as { password: string }).toEqual({
      password: created.password!,
    });
  });

  test("admin rotation wipes EVERY kind='admin' row — covers legacy multi-admin DBs", async () => {
    // Pre-Step-3 deployments could mint multiple role='admin' invites
    // through the generic create endpoint; migrateInvitesKind then
    // backfills them all to kind='admin'. Simulate that state by
    // inserting a second admin row directly and assert rotation nukes
    // both, not just one.
    const created = await upload(CLIENT_A, { markdown: '# Hi' });
    const smuggledToken = 'smuggled-legacy-admin-token';
    app.db
      .prepare(
        `INSERT INTO invites (token, doc_uid, display_name, role, kind, note, created_at, created_by_name)
         VALUES (?, ?, ?, 'admin', 'admin', NULL, ?, ?)`,
      )
      .run(smuggledToken, created.uid, 'Alice', Date.now(), 'Alice');

    // Both admin rows should work pre-rotation.
    const preA = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(preA.status).toBe(200);
    const preB = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), smuggledToken),
      }),
    );
    expect(preB.status).toBe(200);

    // Rotate via the original admin token.
    const rot = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites/admin/rotate`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(rot.status).toBe(200);
    const { admin_invite } = (await rot.json()) as {
      admin_invite: { token: string };
    };

    // BOTH old admin rows are gone — only the fresh one remains.
    const rows = app.db
      .prepare(`SELECT token FROM invites WHERE doc_uid = ? AND kind = 'admin'`)
      .all(created.uid) as Array<{ token: string }>;
    expect(rows.map((r) => r.token)).toEqual([admin_invite.token]);

    // The smuggled legacy token no longer grants admin.
    const settingsWithSmuggled = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(headersFor(CLIENT_A), smuggledToken),
        body: JSON.stringify({ default_theme: 'book' }),
      }),
    );
    expect(settingsWithSmuggled.status).toBe(403);
  });

  test('password rotation invalidates old cookies but re-authenticates the initiating admin', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Secret',
      password_protected: true,
    });
    expect(created.password).toBeString();
    const aliceCookie = await authenticateForDoc(created.uid, created.password!, CLIENT_A);

    // First request with the good cookie: 200.
    const before = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(
          headersFor(CLIENT_A, { cookie: aliceCookie }),
          created.admin_invite.token,
        ),
      }),
    );
    expect(before.status).toBe(200);

    // Admin rotates the password via PATCH settings. This is what Step 5
    // is designed to survive mid-session: the server wipes ALL sessions
    // for this doc, so Alice's still-loaded browser will 401 on its next
    // call and the client's auth-gate must re-prompt.
    const rot = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/settings`, {
        method: 'PATCH',
        headers: withInvite(
          headersFor(CLIENT_A, { cookie: aliceCookie }),
          created.admin_invite.token,
        ),
        body: JSON.stringify({ password: 'rotate' }),
      }),
    );
    expect(rot.status).toBe(200);
    const freshCookie = (rot.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(freshCookie).toContain(SESSION_COOKIE);

    // The old cookie is dead, so stale tabs still hit the password gate.
    const after = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(
          headersFor(CLIENT_A, { cookie: aliceCookie }),
          created.admin_invite.token,
        ),
      }),
    );
    expect(after.status).toBe(401);
    expect((await after.json()).error).toBe('password-required');

    // The browser that initiated rotation receives a fresh cookie and can
    // keep working without manually re-entering the new password.
    const continued = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(
          headersFor(CLIENT_A, { cookie: freshCookie }),
          created.admin_invite.token,
        ),
      }),
    );
    expect(continued.status).toBe(200);
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

  test('uploads and round-trips an AsciiDoc document', async () => {
    const src = `= Adoc Title\n:author: Paul\n\nAn asciidoc paragraph.\n\n== Section\n\nMore text.\n`;
    const created = await upload(CLIENT_A, { source: src, format: 'asciidoc' });

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      source: string;
      rendered: {
        html: string;
        frontmatter: Record<string, unknown>;
        blocks: Array<{ id: string }>;
      };
    };
    expect(body.format).toBe('asciidoc');
    expect(body.source).toBe(src);
    expect(body.rendered.html).toContain('<h2');
    expect(body.rendered.html).toContain('Section');
    expect(body.rendered.frontmatter.title).toBe('Adoc Title');
    expect(body.rendered.blocks.length).toBeGreaterThan(0);
  });

  test('legacy upload with `markdown` field still lands as a markdown document', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    const body = (await res.json()) as { format: string; source: string };
    expect(body.format).toBe('markdown');
    expect(body.source).toBe('# Hi');
  });

  test('PUT with `source` updates an AsciiDoc doc, reanchoring comments', async () => {
    const created = await upload(CLIENT_A, {
      source: '= T\n\nFirst para.\n\nSecond para.\n',
      format: 'asciidoc',
    });
    const put = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ source: '= T\n\nFirst para.\n\nSecond para changed.\n' }),
      }),
    );
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { oid: string };
    expect(typeof putBody.oid).toBe('string');

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    const body = (await res.json()) as { source: string; format: string };
    expect(body.source).toContain('Second para changed');
    expect(body.format).toBe('asciidoc');
  });

  test('export + import of an AsciiDoc bundle preserves format', async () => {
    const created = await upload(CLIENT_A, {
      source: '= Bundle Test\n\nHello there.\n',
      format: 'asciidoc',
    });
    const exportRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    const bundle = (await exportRes.json()) as {
      version: number;
      document: { format?: string; source: string };
    };
    expect(bundle.version).toBe(5);
    expect(bundle.document.format).toBe('asciidoc');

    const importRes = await app.hono.fetch(
      new Request('http://test/api/documents/import', {
        method: 'POST',
        headers: headersFor(CLIENT_C),
        body: JSON.stringify(bundle),
      }),
    );
    expect(importRes.status).toBe(201);
    const imported = (await importRes.json()) as CreateResponse;
    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}`, {
        headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token),
      }),
    );
    const got = (await getRes.json()) as { format: string; source: string };
    expect(got.format).toBe('asciidoc');
    expect(got.source).toBe('= Bundle Test\n\nHello there.\n');
  });
});
