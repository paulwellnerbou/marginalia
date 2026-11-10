import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const ALICE = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

function headers(invite?: string): Headers {
  const h = new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: ALICE.id,
    [CLIENT_NAME_HEADER]: ALICE.name,
  });
  if (invite) h.set(INVITE_HEADER, invite);
  return h;
}

describe('asset upload URLs', () => {
  let dir: string;
  let webDir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-upload-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-upload-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir, maxAssetBytes: 1024 }));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  function call(path: string, init: RequestInit = {}) {
    return app.hono.fetch(new Request(`http://test${path}`, init));
  }

  async function createDoc(): Promise<{ uid: string; admin: string }> {
    const res = await call('/api/documents', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ source: '# Shots\n\n![](shots/one.png)\n' }),
    });
    const body = (await res.json()) as { uid: string; admin_invite: { token: string } };
    return { uid: body.uid, admin: body.admin_invite.token };
  }

  async function mint(uid: string, invite: string, names: unknown) {
    return call(`/api/documents/${uid}/assets/uploads`, {
      method: 'POST',
      headers: headers(invite),
      body: JSON.stringify({ names }),
    });
  }

  function send(url: string, bytes: Uint8Array = PIXEL) {
    const form = new FormData();
    form.set('file', new Blob([Uint8Array.from(bytes)]), 'any-local-name.png');
    // No invite and no identity: the URL is the whole capability.
    return call(url, { method: 'POST', body: form });
  }

  test('a URL uploads one file under its name, once, with no other credential', async () => {
    const { uid, admin } = await createDoc();
    const minted = await mint(uid, admin, ['shots/one.png']);
    expect(minted.status).toBe(201);
    const { uploads } = (await minted.json()) as {
      uploads: Array<{ ref_name: string; url: string; expires_at: number }>;
    };
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.ref_name).toBe('shots/one.png');
    const url = uploads[0]?.url as string;

    const first = await send(url);
    expect(first.status).toBe(201);
    expect(((await first.json()) as { asset: { ref_name: string } }).asset.ref_name).toBe(
      'shots/one.png',
    );
    expect((await send(url)).status).toBe(404);

    const fetched = await call(`/api/documents/${uid}/assets/shots/one.png`, {
      headers: headers(admin),
    });
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer()).equals(PIXEL)).toBe(true);
  });

  test('minting needs editor or admin, like uploading itself', async () => {
    const { uid, admin } = await createDoc();
    const invite = await call(`/api/documents/${uid}/invites`, {
      method: 'POST',
      headers: headers(admin),
      body: JSON.stringify({ kind: 'named', display_name: 'Bot', role: 'collaborator' }),
    });
    const collaborator = ((await invite.json()) as { invite: { token: string } }).invite.token;
    expect((await mint(uid, collaborator, ['a.png'])).status).toBe(403);
  });

  test('names are checked as an upload checks them, and a batch is capped', async () => {
    const { uid, admin } = await createDoc();
    expect((await mint(uid, admin, ['../x.png'])).status).toBe(400);
    expect((await mint(uid, admin, [])).status).toBe(400);
    const many = Array.from({ length: 51 }, (_, i) => `${i}.png`);
    expect((await mint(uid, admin, many)).status).toBe(400);
  });

  test('a file too large is refused without spending the URL', async () => {
    const { uid, admin } = await createDoc();
    const { uploads } = (await (await mint(uid, admin, ['a.png'])).json()) as {
      uploads: Array<{ url: string }>;
    };
    const url = uploads[0]?.url as string;
    expect((await send(url, new Uint8Array(2048))).status).toBe(413);
    expect((await send(url)).status).toBe(201);
  });

  test('an expired URL uploads nothing', async () => {
    const { uid, admin } = await createDoc();
    const { uploads } = (await (await mint(uid, admin, ['a.png'])).json()) as {
      uploads: Array<{ url: string }>;
    };
    app.db.prepare('UPDATE asset_upload_tickets SET expires_at = 0').run();
    expect((await send(uploads[0]?.url as string)).status).toBe(404);
  });

  test('deleting the document takes its unused URLs with it', async () => {
    const { uid, admin } = await createDoc();
    await mint(uid, admin, ['a.png', 'b.png']);
    const deleted = await call(`/api/documents/${uid}`, {
      method: 'DELETE',
      headers: headers(admin),
    });
    expect(deleted.status).toBeLessThan(300);
    const { n } = app.db.prepare('SELECT count(*) AS n FROM asset_upload_tickets').get() as {
      n: number;
    };
    expect(n).toBe(0);
  });
});
