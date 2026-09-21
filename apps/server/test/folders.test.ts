import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { loadConfig } from '../src/config.js';
import { KEYRING_HEADER } from '../src/routes/keyrings.js';

const ALICE = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const BOB = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Bob' };

type Client = typeof ALICE;

function headersFor(client: Client, extra: Record<string, string> = {}): Headers {
  return new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: client.id,
    [CLIENT_NAME_HEADER]: client.name,
    ...extra,
  });
}

function asInvite(client: Client, token: string): Headers {
  return headersFor(client, { [INVITE_HEADER]: token });
}

interface Created {
  uid: string;
  admin_invite: { token: string };
  password?: string;
}

interface FolderWire {
  main_uid: string;
  documents: Array<{ uid: string; name: string | null; title: string | null; main: boolean }>;
}

describe('document folders', () => {
  let dir: string;
  let webDir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-folders-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-folders-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir }));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  async function call(path: string, init: RequestInit = {}): Promise<Response> {
    return app.hono.fetch(new Request(`http://test${path}`, init));
  }

  async function createStory(body: Record<string, unknown> = {}): Promise<Created> {
    const res = await call('/api/documents', {
      method: 'POST',
      headers: headersFor(ALICE),
      body: JSON.stringify({ source: '# The Story\n\nOnce upon a time.\n', ...body }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as Created;
  }

  function addToFolder(
    folder: string,
    headers: Headers,
    body: Record<string, unknown> = {},
  ): Promise<Response> {
    return call('/api/documents', {
      method: 'POST',
      headers,
      body: JSON.stringify({ folder, name: 'OUTLINE', source: '# Outline\n\nAct one.\n', ...body }),
    });
  }

  async function addOutline(story: Created, name = 'OUTLINE', cookie?: string): Promise<string> {
    const headers = asInvite(ALICE, story.admin_invite.token);
    if (cookie) headers.set('cookie', cookie);
    const res = await addToFolder(story.uid, headers, { name });
    expect(res.status).toBe(201);
    return ((await res.json()) as { uid: string }).uid;
  }

  /** A password session for the folder, minted through `uid`. */
  async function passwordSession(uid: string, password: string | undefined): Promise<string> {
    const res = await call(`/api/documents/${uid}/auth`, {
      method: 'POST',
      headers: headersFor(ALICE),
      body: JSON.stringify({ password }),
    });
    expect(res.status).toBe(204);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=`));
    return cookie;
  }

  async function invite(story: Created, role: string, at = story.uid): Promise<string> {
    const res = await call(`/api/documents/${at}/invites`, {
      method: 'POST',
      headers: asInvite(ALICE, story.admin_invite.token),
      body: JSON.stringify({ kind: 'named', role, display_name: 'Bob' }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { invite: { token: string } }).invite.token;
  }

  async function read(uid: string, headers: Headers): Promise<Response> {
    return call(`/api/documents/${uid}`, { headers });
  }

  test("a folder document opens with the main document's links and nothing else", async () => {
    const story = await createStory();
    const outline = await addOutline(story);
    const bobToken = await invite(story, 'collaborator');
    const stranger = await createStory();

    const asAdmin = await read(outline, asInvite(ALICE, story.admin_invite.token));
    expect(asAdmin.status).toBe(200);
    expect(((await asAdmin.json()) as { role: string }).role).toBe('admin');

    const asBob = await read(outline, asInvite(BOB, bobToken));
    expect(asBob.status).toBe(200);
    expect(((await asBob.json()) as { role: string }).role).toBe('collaborator');

    // Invite-only by default, and a token from another document is nobody.
    expect((await read(outline, headersFor(BOB))).status).toBe(401);
    expect((await read(outline, asInvite(BOB, stranger.admin_invite.token))).status).toBe(401);
  });

  test('the response carries no link of its own and creates no invites', async () => {
    const story = await createStory();
    const res = await addToFolder(story.uid, asInvite(ALICE, story.admin_invite.token));
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.folder_uid).toBe(story.uid);
    expect(body.admin_invite).toBeUndefined();
    expect(body.url).toBe(`/d/${body.uid}`);
    expect(body.invite_only).toBe(true);

    // Listing through the folder document shows the main document's list.
    const list = await call(`/api/documents/${body.uid}/invites`, {
      headers: asInvite(ALICE, story.admin_invite.token),
    });
    const { invites } = (await list.json()) as { invites: Array<{ kind: string }> };
    expect(invites.map((i) => i.kind)).toEqual(['admin']);
  });

  test('invites made later, role changes and revocations reach the whole folder', async () => {
    const story = await createStory();
    const outline = await addOutline(story);
    // Created through the folder document: it lands on the main document.
    const bobToken = await invite(story, 'reader', outline);
    expect((await read(story.uid, asInvite(BOB, bobToken))).status).toBe(200);

    const patch = await call(`/api/documents/${story.uid}/invites/${bobToken}`, {
      method: 'PATCH',
      headers: asInvite(ALICE, story.admin_invite.token),
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(patch.status).toBe(200);
    const asEditor = await read(outline, asInvite(BOB, bobToken));
    expect(((await asEditor.json()) as { role: string }).role).toBe('editor');

    const del = await call(`/api/documents/${outline}/invites/${bobToken}`, {
      method: 'DELETE',
      headers: asInvite(ALICE, story.admin_invite.token),
    });
    expect(del.status).toBe(204);
    expect((await read(outline, asInvite(BOB, bobToken))).status).toBe(401);
    expect((await read(story.uid, asInvite(BOB, bobToken))).status).toBe(401);
  });

  test('rotating the admin link through a folder document rotates the folder', async () => {
    const story = await createStory();
    const outline = await addOutline(story);
    const res = await call(`/api/documents/${outline}/invites/admin/rotate`, {
      method: 'POST',
      headers: asInvite(ALICE, story.admin_invite.token),
    });
    expect(res.status).toBe(200);
    const fresh = ((await res.json()) as { admin_invite: { token: string; url: string } })
      .admin_invite;
    expect(fresh.url).toBe(`/d/${story.uid}/${fresh.token}`);
    expect((await read(outline, asInvite(ALICE, story.admin_invite.token))).status).toBe(401);
    expect((await read(outline, asInvite(ALICE, fresh.token))).status).toBe(200);
  });

  test('a claimed invite session opens every document in the folder', async () => {
    const story = await createStory();
    const outline = await addOutline(story);
    const bobToken = await invite(story, 'collaborator');

    const claim = await call(`/api/documents/${outline}/invites/${bobToken}/claim`, {
      method: 'POST',
      headers: headersFor(BOB),
    });
    expect(claim.status).toBe(201);
    const cookie = (claim.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(cookie).toMatch(new RegExp(`^${INVITE_SESSION_COOKIE}=`));

    expect((await read(story.uid, headersFor(BOB, { cookie }))).status).toBe(200);
    const outlineRes = await read(outline, headersFor(BOB, { cookie }));
    expect(outlineRes.status).toBe(200);

    // A write that goes through the threads router, not the documents one.
    const { rendered } = (await outlineRes.json()) as {
      rendered: { blocks: Array<{ id: string }> };
    };
    const block = rendered.blocks.find((b) => b.id)?.id;
    const comment = await call(`/api/documents/${outline}/threads`, {
      method: 'POST',
      headers: headersFor(BOB, { cookie }),
      body: JSON.stringify({ anchor: { block_id: block, quote: 'Outline' }, body: 'hello' }),
    });
    expect(comment.status).toBe(201);
  });

  test("the main document's password gates the folder, and one session covers it", async () => {
    const story = await createStory({ password_protected: true });
    const admin = asInvite(ALICE, story.admin_invite.token);
    expect((await addToFolder(story.uid, admin)).status).toBe(401);

    const outline = await addOutline(
      story,
      'OUTLINE',
      await passwordSession(story.uid, story.password),
    );
    expect((await read(outline, admin)).status).toBe(401);

    // Signing in through the folder document signs in to the folder.
    const cookie = await passwordSession(outline, story.password);
    const withSession = asInvite(ALICE, story.admin_invite.token);
    withSession.set('cookie', cookie);
    const outlineRes = await read(outline, withSession);
    expect(outlineRes.status).toBe(200);
    expect(((await outlineRes.json()) as { password_protected: boolean }).password_protected).toBe(
      true,
    );
    expect((await read(story.uid, withSession)).status).toBe(200);
  });

  test('only admins and editors add documents, and a name is required', async () => {
    const story = await createStory();
    const collaborator = await invite(story, 'collaborator');
    expect((await addToFolder(story.uid, asInvite(BOB, collaborator))).status).toBe(403);
    expect((await addToFolder(story.uid, headersFor(BOB))).status).toBe(401);
    expect((await addToFolder('no-such-document', headersFor(BOB))).status).toBe(404);

    const admin = asInvite(ALICE, story.admin_invite.token);
    expect((await addToFolder(story.uid, admin, { name: '  ' })).status).toBe(400);

    const editorStory = await createStory();
    const editor = await call(`/api/documents/${editorStory.uid}/invites`, {
      method: 'POST',
      headers: asInvite(ALICE, editorStory.admin_invite.token),
      body: JSON.stringify({ kind: 'named', role: 'editor', display_name: 'Bob' }),
    });
    const editorToken = ((await editor.json()) as { invite: { token: string } }).invite.token;
    expect((await addToFolder(editorStory.uid, asInvite(BOB, editorToken))).status).toBe(201);
  });

  test('adding through a folder document joins the same folder, one level deep', async () => {
    const story = await createStory();
    const outline = await addOutline(story);
    const res = await addToFolder(outline, asInvite(ALICE, story.admin_invite.token), {
      name: 'BACKGROUND',
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { folder_uid: string }).folder_uid).toBe(story.uid);
  });

  test('every document in the folder lists the folder, main document first', async () => {
    const story = await createStory();
    const lone = await createStory();
    const admin = asInvite(ALICE, story.admin_invite.token);
    const standalone = await read(lone.uid, asInvite(ALICE, lone.admin_invite.token));
    expect(((await standalone.json()) as { folder: unknown }).folder).toBeNull();

    const outline = await addOutline(story);
    const background = await addOutline(story, 'BACKGROUND');

    for (const uid of [story.uid, outline, background]) {
      const { folder } = (await (await read(uid, admin)).json()) as { folder: FolderWire };
      expect(folder.main_uid).toBe(story.uid);
      expect(folder.documents.map((d) => [d.uid, d.title, d.main])).toEqual([
        // The main document has no name, so its heading is its title.
        [story.uid, 'The Story', true],
        [outline, 'OUTLINE', false],
        [background, 'BACKGROUND', false],
      ]);
    }
  });

  test("a folder document's settings leave access to the main document", async () => {
    const story = await createStory();
    const outline = await addOutline(story);
    const admin = asInvite(ALICE, story.admin_invite.token);

    for (const patch of [{ invite_only: false }, { password: 'rotate' }, { password: null }]) {
      const res = await call(`/api/documents/${outline}/settings`, {
        method: 'PATCH',
        headers: admin,
        body: JSON.stringify(patch),
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe('access-managed-by-folder');
    }

    const rename = await call(`/api/documents/${outline}/settings`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ name: 'PLAN' }),
    });
    expect(rename.status).toBe(200);

    // Opening the main document up opens the folder.
    const open = await call(`/api/documents/${story.uid}/settings`, {
      method: 'PATCH',
      headers: admin,
      body: JSON.stringify({ invite_only: false }),
    });
    expect(open.status).toBe(200);
    const anonymous = await read(outline, headersFor(BOB));
    expect(anonymous.status).toBe(200);
    expect(((await anonymous.json()) as { invite_only: boolean }).invite_only).toBe(false);
  });

  test('a main document is only deleted together with its folder, and only when asked', async () => {
    const story = await createStory();
    const outline = await addOutline(story);
    const admin = asInvite(ALICE, story.admin_invite.token);

    const refused = await call(`/api/documents/${story.uid}`, { method: 'DELETE', headers: admin });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'folder-not-empty', documents: [outline] });
    expect((await read(outline, admin)).status).toBe(200);

    const deleted = await call(`/api/documents/${story.uid}?with_members=1`, {
      method: 'DELETE',
      headers: admin,
    });
    expect(deleted.status).toBe(204);
    expect((await read(story.uid, admin)).status).toBe(404);
    expect((await read(outline, admin)).status).toBe(404);
  });

  test('adding while the folder is being deleted never strands a document', async () => {
    const story = await createStory();
    await addOutline(story);
    const admin = asInvite(ALICE, story.admin_invite.token);

    const results = await Promise.all([
      addToFolder(story.uid, admin, { name: 'LATE' }),
      call(`/api/documents/${story.uid}?with_members=1`, { method: 'DELETE', headers: admin }),
      addToFolder(story.uid, admin, { name: 'LATER' }),
    ]);
    expect(results[1]?.status).toBe(204);

    const stranded = app.db
      .prepare(
        `SELECT d.uid FROM documents d
          WHERE d.folder_uid IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM documents m WHERE m.uid = d.folder_uid)`,
      )
      .all();
    expect(stranded).toEqual([]);
  });

  test('deleting a folder document leaves the rest of the folder alone', async () => {
    const story = await createStory();
    const outline = await addOutline(story);
    const background = await addOutline(story, 'BACKGROUND');
    const admin = asInvite(ALICE, story.admin_invite.token);

    expect(
      (await call(`/api/documents/${outline}`, { method: 'DELETE', headers: admin })).status,
    ).toBe(204);
    const { folder } = (await (await read(story.uid, admin)).json()) as { folder: FolderWire };
    expect(folder.documents.map((d) => d.uid)).toEqual([story.uid, background]);
    expect((await read(background, admin)).status).toBe(200);
  });

  test("copying a folder document with access takes the main document's roster", async () => {
    const story = await createStory();
    const outline = await addOutline(story);
    await invite(story, 'collaborator');

    const res = await call(`/api/documents/${outline}/copy`, {
      method: 'POST',
      headers: asInvite(ALICE, story.admin_invite.token),
      body: JSON.stringify({ include_access: true }),
    });
    expect(res.status).toBe(201);
    const copy = (await res.json()) as Created & { invite_only: boolean };
    expect(copy.invite_only).toBe(true);

    const copyAdmin = asInvite(ALICE, copy.admin_invite.token);
    const { invites } = (await (
      await call(`/api/documents/${copy.uid}/invites`, { headers: copyAdmin })
    ).json()) as { invites: Array<{ display_name: string | null; role: string }> };
    // The copy's own admin invite is minted after the roster.
    expect(invites.map((i) => [i.display_name, i.role])).toEqual([
      ['Bob', 'collaborator'],
      ['Alice', 'admin'],
    ]);
    const { folder } = (await (await read(copy.uid, copyAdmin)).json()) as { folder: unknown };
    expect(folder).toBeNull();
  });

  test('@mention candidates on a folder document include the folder invites', async () => {
    const story = await createStory();
    const outline = await addOutline(story);
    // Invited after the folder document exists and never visited it, so
    // only the main document's invite list can name Bob.
    await invite(story, 'collaborator');
    const res = await call(`/api/documents/${outline}/threads`, {
      headers: asInvite(ALICE, story.admin_invite.token),
    });
    expect(res.status).toBe(200);
    const { mention_candidates } = (await res.json()) as { mention_candidates: string[] };
    expect(mention_candidates).toContain('Bob');
  });

  test("a keyring takes a folder document with the main document's token", async () => {
    const story = await createStory({ password_protected: true });
    const outline = await addOutline(
      story,
      'OUTLINE',
      await passwordSession(story.uid, story.password),
    );
    const ring = await call('/api/keyrings', {
      method: 'POST',
      headers: headersFor(ALICE),
      body: JSON.stringify({ docs: [] }),
    });
    const { token } = (await ring.json()) as { token: string };
    const ringHeaders = headersFor(ALICE, { [KEYRING_HEADER]: token });

    const put = (inviteToken: string) =>
      call(`/api/keyrings/self/docs/${outline}`, {
        method: 'PUT',
        headers: ringHeaders,
        body: JSON.stringify({ invite_token: inviteToken, title: 'OUTLINE' }),
      });
    const stranger = await createStory();
    expect((await put(stranger.admin_invite.token)).status).toBe(404);
    expect((await put(story.admin_invite.token)).status).toBe(200);

    const pull = await call('/api/keyrings/self', { headers: ringHeaders });
    const { docs } = (await pull.json()) as {
      docs: Array<{
        doc_uid: string;
        role: string | null;
        password_protected: boolean;
        folder_uid: string | null;
      }>;
    };
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({
      doc_uid: outline,
      role: 'admin',
      password_protected: true,
      folder_uid: story.uid,
    });
  });
});
