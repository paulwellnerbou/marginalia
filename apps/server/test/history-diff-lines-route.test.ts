import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

/** Spike: `GET /history/:oid/diff?shape=lines` over the wire. */
describe('history diff, lines shape', () => {
  let dir: string;
  let webDir: string;
  let app: App;
  const headers = new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: 'aaaaaaaaaaaaaaaaaaaa',
    [CLIENT_NAME_HEADER]: 'Alice',
  });
  /** Editing needs the admin invite the create response hands back. */
  const asAdmin = (token: string): Headers => {
    const h = new Headers(headers);
    h.set(INVITE_HEADER, token);
    return h;
  };

  interface Created {
    uid: string;
    admin_invite: { token: string };
  }

  async function upload(markdown: string): Promise<Created> {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers,
        body: JSON.stringify({ markdown }),
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as Created;
  }

  async function latestOid(uid: string, h: Headers): Promise<string> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/history`, { headers: h }),
    );
    const body = (await res.json()) as { history: Array<{ oid: string }> };
    return body.history[0]!.oid;
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-diffroute-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir }));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  test('serves render-ready lines instead of both revisions', async () => {
    const created = await upload('# Title\n\nThe quick brown fox.\n\nTail.\n');
    const admin = asAdmin(created.admin_invite.token);

    const put = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ markdown: '# Title\n\nThe quick red fox jumps.\n\nTail.\n' }),
      }),
    );
    expect(put.status).toBe(200);
    const oid = await latestOid(created.uid, admin);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${oid}/diff?shape=lines`, {
        headers: admin,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      lines: Array<{
        op: string;
        text?: string;
        segments?: Array<{ changed: boolean; text: string }>;
      }>;
    };

    expect(body.lines.some((l) => l.op === 'equal' && l.text === '# Title')).toBe(true);
    const added = body.lines.find((l) => l.op === 'add');
    expect(added?.text).toContain('red fox');
    expect(added?.segments?.some((s) => s.changed)).toBe(true);
    // The point of the shape: no full second copy of the document.
    expect(body).not.toHaveProperty('before');
    expect(body).not.toHaveProperty('after');
  });

  test('trims only for a whole non-negative context, never a partial parse', async () => {
    const tail = Array.from({ length: 40 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    const created = await upload(`# Title\n\nThe quick brown fox.\n\n${tail}\n`);
    const admin = asAdmin(created.admin_invite.token);
    await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}`, {
        method: 'PUT',
        headers: admin,
        body: JSON.stringify({ markdown: `# Title\n\nThe quick red fox.\n\n${tail}\n` }),
      }),
    );
    const oid = await latestOid(created.uid, admin);

    const lineCount = async (query: string): Promise<number> => {
      const res = await app.hono.fetch(
        new Request(
          `http://test/api/documents/${created.uid}/history/${oid}/diff?shape=lines${query}`,
          { headers: admin },
        ),
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { lines: unknown[] }).lines.length;
    };

    const untrimmed = await lineCount('');
    expect(await lineCount('&context=2')).toBeLessThan(untrimmed);
    // `3abc` parses to 3 under parseInt; trimming on it would silently drop
    // lines the caller never asked to lose.
    for (const bad of ['&context=3abc', '&context=abc', '&context=-1', '&context=']) {
      expect(await lineCount(bad)).toBe(untrimmed);
    }
  });

  test('default shape is unchanged for existing clients', async () => {
    const created = await upload('# A\n');
    const oid = await latestOid(created.uid, headers);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/history/${oid}/diff`, { headers }),
    );
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('before');
    expect(body).toHaveProperty('after');
  });
});
