import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateAllBlocks } from '@marginalia/renderer';
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
        body: JSON.stringify(body),
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
        } | null;
      }>;
    };
    const accepted = history.find((entry) => entry.action === 'accept-proposal');
    expect(accepted?.proposal).toEqual({
      id: proposal.thread.id,
      author: { client_id: CLIENT_B.id, display_name: 'Robert' },
      summary: 'First replacement',
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
    const expectedAcceptedBlockId = [...locateAllBlocks(acceptedSource).entries()].find(
      ([, range]) => range.kind === 'heading' && range.text.includes('30%'),
    )?.[0];
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
    expect(accepted.thread.anchor?.quote).toBe(block.text);

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
    const previousOid = historyBefore.history[1]?.oid;
    expect(latestOid).toBeString();
    expect(previousOid).toBeString();

    const revertRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${latestOid}/revert`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(revertRes.status).toBe(200);
    const reverted = (await revertRes.json()) as {
      oid: string;
      reopened_proposal_id: string | null;
    };
    expect(reverted.oid).toBeString();
    expect(reverted.reopened_proposal_id).toBeNull();

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
      oid: reverted.oid,
      action: 'restore',
      restored_from_oid: previousOid,
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
        `SELECT status, accepted_oid, decided_at, decided_by_name
         FROM comments_edit_proposals
        WHERE comment_id = ?`,
      )
      .get(proposal.thread.id) as {
      status: string;
      accepted_oid: string | null;
      decided_at: number | null;
      decided_by_name: string | null;
    };
    expect(proposalRow).toEqual({
      status: 'open',
      accepted_oid: null,
      decided_at: null,
      decided_by_name: null,
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
        proposal: { id: string } | null;
      }>;
    };
    expect(historyAfter.history[0]).toMatchObject({
      oid: reverted.oid,
      action: 'restore',
      restored_from_oid: previousOid,
    });
    expect(
      historyAfter.history.find((entry) => entry.oid === latestAccepted?.oid)?.proposal?.id,
    ).toBe(proposal.thread.id);
  });

  test('accepted proposal diff reconstructs the original table-cell source for legacy rows', async () => {
    const source = [
      '| Label | Link |',
      '| --- | --- |',
      '| Availability | [5.3](#53-hosting--betrieb) |',
    ].join('\n');
    const created = await upload(CLIENT_A, { markdown: source });
    const blockId = [...locateAllBlocks(source).entries()].find(
      ([, range]) => range.kind === 'tableCell' && range.text === '5.3',
    )?.[0];
    expect(blockId).toBeString();

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: '5.3' },
          proposal: {
            anchor_kind: 'tableCell',
            proposed_text: '[5.3](#53-hosting-betrieb)',
          },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()) as {
      thread: { id: string; proposal: { source_snapshot: string | null } };
    };
    expect(proposal.thread.proposal.source_snapshot).toBe('[5.3](#53-hosting--betrieb)');

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

    // Simulate an older accepted row that predates source_snapshot /
    // accepted_oid persistence. The diff endpoint should still recover
    // the true source from git history.
    app.db
      .prepare(
        `UPDATE comments_edit_proposals
          SET source_snapshot = NULL, accepted_oid = NULL
        WHERE comment_id = ?`,
      )
      .run(proposal.thread.id);

    const diffRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${created.uid}/threads/${proposal.thread.id}/diff`,
        {
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        },
      ),
    );
    expect(diffRes.status).toBe(200);
    expect(await diffRes.json()).toEqual({
      before: '[5.3](#53-hosting--betrieb)',
      after: '[5.3](#53-hosting-betrieb)',
    });
  });

  test('health endpoint', async () => {
    const res = await app.hono.fetch(new Request('http://test/health'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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
    await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/threads`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Hi' }, body: 'a' }),
      }),
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
    expect(countBefore('invites')).toBeGreaterThan(0);

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
      'doc_users',
      'invites',
      'sessions',
    ]) {
      expect(countBefore(table)).toBe(0);
    }
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

  test('export + import roundtrip preserves source, name, theme, comments', async () => {
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
    await app.hono.fetch(
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
        body: string;
        anchor_heading_path: string[] | null;
        anchor_section_index: number | null;
        anchor_section_index_path: number[] | null;
      }>;
    };
    expect(bundle.kind).toBe('marginalia.document-bundle');
    expect(bundle.version).toBe(3);
    expect(bundle.document.name).toBe('Original Name');
    expect(bundle.document.source).toContain('Original.');
    expect(bundle.document.default_theme).toBe('book');
    expect(bundle.representation.blocks[0]!.text).toBe('Hi');
    expect(bundle.representation.anchors[0]!.id).toBe('hi');
    expect(bundle.comments).toHaveLength(1);
    expect(bundle.comments[0]!.anchor_heading_path).toEqual(firstBlock.headingPath);
    expect(bundle.comments[0]!.anchor_section_index).toBe(firstBlock.sectionIndex);
    expect(bundle.comments[0]!.anchor_section_index_path).toEqual(firstBlock.sectionIndexPath);

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
    };
    expect(imported.imported_comments).toBe(1);

    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}`, {
        headers: withInvite(headersFor(CLIENT_C), imported.admin_invite.token),
      }),
    );
    const dupe = (await getRes.json()) as { source: string; name: string | null };
    expect(dupe.source).toContain('Original.');
    expect(dupe.name).toBe('Original Name');
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
      thread: { root: { author: { display_name: string } } };
    };
    expect(thread.root.author.display_name).toBe(CLIENT_B.name);
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
    expect(bundle.version).toBe(3);
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
