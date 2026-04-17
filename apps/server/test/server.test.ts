import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, SESSION_COOKIE } from '../src/auth.js';

const CLIENT_A = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const CLIENT_B = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Bob' };

function headersFor(client: { id: string; name: string }, extra: Record<string, string> = {}): Headers {
  return new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: client.id,
    [CLIENT_NAME_HEADER]: client.name,
    ...extra,
  });
}

describe('documents API', () => {
  let dir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-srv-'));
    const config = loadConfig({ dataDir: dir, port: 0 });
    app = await createApp(config);
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function upload(
    client: typeof CLIENT_A,
    body: Record<string, unknown> = { markdown: '# Hi' },
  ): Promise<Response> {
    return app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headersFor(client),
        body: JSON.stringify(body),
      }),
    );
  }

  test('upload → get → edit → history', async () => {
    const createRes = await upload(CLIENT_A, { markdown: '# Original\n\nBody.' });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { uid: string; admin_recovery_token: string };
    expect(created.uid).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created.admin_recovery_token).toBeString();

    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_A) }),
    );
    expect(getRes.status).toBe(200);
    const doc = (await getRes.json()) as {
      source: string;
      rendered: { html: string; anchors: unknown[] };
      role: string;
    };
    expect(doc.source).toContain('Original');
    expect(doc.rendered.html).toContain('<h1');
    expect(doc.role).toBe('admin');

    const putRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: headersFor(CLIENT_A),
        body: JSON.stringify({ markdown: '# Updated\n\nNew body.' }),
      }),
    );
    expect(putRes.status).toBe(200);

    const historyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history`, {
        headers: headersFor(CLIENT_A),
      }),
    );
    expect(historyRes.status).toBe(200);
    const hist = (await historyRes.json()) as { history: Array<{ message: string }> };
    expect(hist.history.length).toBe(2);
    expect(hist.history[0]!.message).toMatch(/^update:/);
    expect(hist.history[1]!.message).toMatch(/^upload:/);
  });

  test('non-admin cannot edit a non-editable doc', async () => {
    const created = (await (await upload(CLIENT_A)).json()) as { uid: string };

    const putRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: headersFor(CLIENT_B),
        body: JSON.stringify({ markdown: '# Hacked' }),
      }),
    );
    expect(putRes.status).toBe(403);

    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    const doc = (await getRes.json()) as { role: string };
    expect(doc.role).toBe('reader');
  });

  test('non-admin can edit when editable_by_anyone=true', async () => {
    const created = (await (
      await upload(CLIENT_A, { markdown: '# X', editable_by_anyone: true })
    ).json()) as { uid: string };

    const putRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: headersFor(CLIENT_B),
        body: JSON.stringify({ markdown: '# Edited by B' }),
      }),
    );
    expect(putRes.status).toBe(200);
  });

  test('password-protected docs require auth to read', async () => {
    const created = (await (
      await upload(CLIENT_A, { markdown: '# Secret', password_protected: true })
    ).json()) as { uid: string; password: string };
    expect(created.password).toBeString();

    const nope = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(nope.status).toBe(401);

    const authRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/auth`, {
        method: 'POST',
        headers: headersFor(CLIENT_B),
        body: JSON.stringify({ password: created.password }),
      }),
    );
    expect(authRes.status).toBe(204);
    const setCookie = authRes.headers.get('set-cookie');
    expect(setCookie).toContain(SESSION_COOKIE);

    const token = setCookie!.split(';')[0]!.split('=')[1]!;

    const afterAuth = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        headers: headersFor(CLIENT_B, { cookie: `${SESSION_COOKIE}=${token}` }),
      }),
    );
    expect(afterAuth.status).toBe(200);
  });

  test('wrong password is rejected', async () => {
    const created = (await (
      await upload(CLIENT_A, { markdown: '# Secret', password_protected: true })
    ).json()) as { uid: string };

    const authRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/auth`, {
        method: 'POST',
        headers: headersFor(CLIENT_B),
        body: JSON.stringify({ password: 'not-the-password' }),
      }),
    );
    expect(authRes.status).toBe(401);
  });

  test('admin recovery rebinds admin to the caller', async () => {
    const created = (await (await upload(CLIENT_A)).json()) as {
      uid: string;
      admin_recovery_token: string;
    };

    // Before recovery, B is a reader
    let getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(((await getRes.json()) as { role: string }).role).toBe('reader');

    // Recover
    const recRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/admin-recovery`, {
        method: 'POST',
        headers: headersFor(CLIENT_B),
        body: JSON.stringify({ recovery_token: created.admin_recovery_token }),
      }),
    );
    expect(recRes.status).toBe(200);

    // Now B is admin
    getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, { headers: headersFor(CLIENT_B) }),
    );
    expect(((await getRes.json()) as { role: string }).role).toBe('admin');
  });

  test('missing identity header is a 400', async () => {
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
});
