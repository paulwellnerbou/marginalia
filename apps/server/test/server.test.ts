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

  async function authenticateForDoc(
    uid: string,
    password: string,
    client: { id: string; name: string },
  ): Promise<string> {
    const authRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/auth`, {
        method: 'POST',
        headers: headersFor(client),
        body: JSON.stringify({ password }),
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

    // With session + invite, the invite controls the effective role/name.
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
    expect(doc.display_name).toBe('Alice');
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

  test('DELETE /api/documents/:uid (admin only) removes doc, invites, comments, sessions', async () => {
    const created = await upload(CLIENT_A, { markdown: '# Hi' });

    // Create a comment and a secondary invite so we can assert both are gone.
    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    const doc = (await docRes.json()) as { rendered: { blocks: Array<{ id: string }> } };
    const blockId = doc.rendered.blocks[0]!.id;
    await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/comments`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Hi' }, body: 'a' }),
      }),
    );

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

    // Create a commentor invite and delete it → 204.
    const mkRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/invites`, {
        method: 'POST',
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        body: JSON.stringify({ display_name: 'Oli', role: 'commentor' }),
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

  test('role gating: reader cannot comment, commentor can, editor can edit', async () => {
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
    const commentorToken = await mkInvite('commentor');
    const editorToken = await mkInvite('editor');

    async function postComment(token: string) {
      return app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}/comments`, {
          method: 'POST',
          headers: withInvite(headersFor(CLIENT_B), token),
          body: JSON.stringify({ anchor: { block_id: block, quote: 'Hi' }, body: 'x' }),
        }),
      );
    }

    expect((await postComment(readerToken)).status).toBe(403);
    expect((await postComment(commentorToken)).status).toBe(201);

    async function editAs(token: string) {
      return app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}`, {
          method: 'PUT',
          headers: withInvite(headersFor(CLIENT_B), token),
          body: JSON.stringify({ markdown: '# Edited' }),
        }),
      );
    }
    expect((await editAs(commentorToken)).status).toBe(403);
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
      new Request(`http://test/api/documents/${created.uid}/comments`, {
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
    expect(bundle.version).toBe(2);
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
      editable_by_anyone: boolean;
      default_theme: string;
    };
    expect(doc.source).toContain('Still works.');
    expect(doc.editable_by_anyone).toBe(true);
    expect(doc.default_theme).toBe('technical');
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
