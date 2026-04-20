import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const ALICE = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const BOB = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Bob' };

function headers(c: { id: string; name: string }, extra: Record<string, string> = {}) {
  return new Headers({
    [CLIENT_HEADER]: c.id,
    [CLIENT_NAME_HEADER]: c.name,
    ...extra,
  });
}

function multipartHeaders(c: { id: string; name: string }, invite?: string) {
  const h = new Headers({ [CLIENT_HEADER]: c.id, [CLIENT_NAME_HEADER]: c.name });
  if (invite) h.set(INVITE_HEADER, invite);
  return h;
}

describe('assets API', () => {
  let dir: string;
  let webDir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-srv-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html>');
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir }));
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  async function upload() {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headers(ALICE, { 'content-type': 'application/json' }),
        body: JSON.stringify({ source: '# Hi\n\n![](cat.png)\n' }),
      }),
    );
    return (await res.json()) as {
      uid: string;
      admin_invite: { token: string };
    };
  }

  async function putAsset(
    uid: string,
    token: string,
    refName: string,
    bytes: Uint8Array,
    mime = 'image/png',
    client = ALICE,
  ): Promise<Response> {
    const form = new FormData();
    form.append('file', new Blob([bytes as BlobPart], { type: mime }), refName);
    form.append('ref_name', refName);
    return app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/assets`, {
        method: 'POST',
        headers: multipartHeaders(client, token),
        body: form,
      }),
    );
  }

  test('admin can upload an asset, fetch it, list it, and delete it', async () => {
    const doc = await upload();
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const up = await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', bytes);
    expect(up.status).toBe(201);
    const body = (await up.json()) as { asset: { ref_name: string; size: number; mime: string } };
    expect(body.asset.ref_name).toBe('cat.png');
    expect(body.asset.size).toBe(bytes.length);
    expect(body.asset.mime).toBe('image/png');

    const get = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toBe('image/png');
    const out = new Uint8Array(await get.arrayBuffer());
    expect(out.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) expect(out[i]).toBe(bytes[i]!);

    const list = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { assets: Array<{ ref_name: string }> };
    expect(listed.assets.map((a) => a.ref_name)).toEqual(['cat.png']);

    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'DELETE',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(del.status).toBe(204);

    const missing = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(missing.status).toBe(404);
  });

  test('upload requires editor role — plain reader is forbidden', async () => {
    const doc = await upload();
    const bytes = new Uint8Array([1, 2, 3]);
    // Bob without an invite is a reader.
    const res = await putAsset(doc.uid, '', 'cat.png', bytes, 'image/png', BOB);
    expect(res.status).toBe(403);
  });

  test('GET without invite is forbidden when doc is password-protected', async () => {
    const created = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headers(ALICE, { 'content-type': 'application/json' }),
        body: JSON.stringify({ source: '# secret', password_protected: true }),
      }),
    );
    const info = (await created.json()) as { uid: string; admin_invite: { token: string } };
    const bytes = new Uint8Array([1, 2]);
    await putAsset(info.uid, info.admin_invite.token, 'pic.png', bytes);

    // No session: anonymous GET should be rejected before hitting the blob.
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${info.uid}/assets/pic.png`, {
        method: 'GET',
        headers: headers(BOB),
      }),
    );
    expect(res.status).toBe(401);
  });

  test('uploading twice with the same ref_name replaces the attachment', async () => {
    const doc = await upload();
    const v1 = new Uint8Array([1, 2]);
    const v2 = new Uint8Array([3, 4, 5, 6]);
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', v1);
    const r2 = await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', v2);
    expect(r2.status).toBe(201);

    const get = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    const out = new Uint8Array(await get.arrayBuffer());
    expect(out.length).toBe(v2.length);
  });

  test('GET /api/documents/:uid returns attached_assets and rewrites <img src>', async () => {
    const doc = await upload();
    const bytes = new Uint8Array([9, 9, 9]);
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', bytes);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      rendered: { html: string };
      attached_assets: Array<{ ref_name: string }>;
    };
    expect(payload.attached_assets.map((a) => a.ref_name)).toEqual(['cat.png']);
    expect(payload.rendered.html).toContain(`/api/documents/${doc.uid}/assets/cat.png`);
    expect(payload.rendered.html).not.toContain('data-missing-asset="cat.png"');
  });

  test('GET /api/documents/:uid tags unattached refs with data-missing-asset', async () => {
    const doc = await upload();
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}`, {
        method: 'GET',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    const payload = (await res.json()) as { rendered: { html: string } };
    expect(payload.rendered.html).toContain('data-missing-asset="cat.png"');
  });

  test('delete cleans up the blob when no other document references it', async () => {
    const doc = await upload();
    const bytes = new Uint8Array([42, 42, 42, 42]);
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', bytes);
    expect(
      (app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c,
    ).toBe(1);

    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets/cat.png`, {
        method: 'DELETE',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(del.status).toBe(204);
    expect(
      (app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c,
    ).toBe(0);
  });

  test('replace upload GCs the previous blob if nothing else points to it', async () => {
    const doc = await upload();
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([1]));
    const beforeIds = new Set(
      (app.db.prepare('SELECT id FROM assets').all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    );
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([2, 2]));
    const afterIds = new Set(
      (app.db.prepare('SELECT id FROM assets').all() as Array<{ id: string }>).map(
        (r) => r.id,
      ),
    );
    // Exactly one row; the old id was swept.
    expect(afterIds.size).toBe(1);
    expect([...afterIds][0]).not.toBe([...beforeIds][0]);
  });

  test('deleting a document cascades to its assets', async () => {
    const doc = await upload();
    await putAsset(doc.uid, doc.admin_invite.token, 'cat.png', new Uint8Array([9, 9]));
    const del = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}`, {
        method: 'DELETE',
        headers: headers(ALICE, { [INVITE_HEADER]: doc.admin_invite.token }),
      }),
    );
    expect(del.status).toBe(204);
    expect(
      (app.db.prepare('SELECT COUNT(*) as c FROM document_assets').get() as { c: number }).c,
    ).toBe(0);
    expect(
      (app.db.prepare('SELECT COUNT(*) as c FROM assets').get() as { c: number }).c,
    ).toBe(0);
  });

  test('refuses path traversal in ref_name', async () => {
    const doc = await upload();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'x.png');
    form.append('ref_name', '../escape.png');
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${doc.uid}/assets`, {
        method: 'POST',
        headers: multipartHeaders(ALICE, doc.admin_invite.token),
        body: form,
      }),
    );
    expect(res.status).toBe(400);
  });
});
