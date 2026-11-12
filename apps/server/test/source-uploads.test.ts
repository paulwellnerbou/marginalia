import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { AGENT_KEY_HEADER } from '../src/routes/agent-keys.js';
import { KEYRING_HEADER } from '../src/routes/keyrings.js';

const ALICE = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const SOURCE = '# Report\n\nFirst finding.\n';

function headers(invite?: string): Headers {
  const h = new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: ALICE.id,
    [CLIENT_NAME_HEADER]: ALICE.name,
  });
  if (invite) h.set(INVITE_HEADER, invite);
  return h;
}

describe('source upload URLs', () => {
  let dir: string;
  let webDir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-src-upload-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-src-upload-web-'));
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
      body: JSON.stringify({ source: SOURCE }),
    });
    const body = (await res.json()) as { uid: string; admin_invite: { token: string } };
    return { uid: body.uid, admin: body.admin_invite.token };
  }

  async function invite(uid: string, admin: string, role: string): Promise<string> {
    const res = await call(`/api/documents/${uid}/invites`, {
      method: 'POST',
      headers: headers(admin),
      body: JSON.stringify({ kind: 'named', display_name: 'Bot', role }),
    });
    return ((await res.json()) as { invite: { token: string } }).invite.token;
  }

  function mint(uid: string, token: string, agentKey?: string) {
    const h = headers(token);
    if (agentKey) h.set(AGENT_KEY_HEADER, agentKey);
    return call(`/api/documents/${uid}/source-uploads`, { method: 'POST', headers: h, body: '{}' });
  }

  async function urlFor(uid: string, token: string, agentKey?: string): Promise<string> {
    const res = await mint(uid, token, agentKey);
    expect(res.status).toBe(201);
    return ((await res.json()) as { url: string }).url;
  }

  // No invite and no identity: the URL is the whole capability.
  const send = (url: string, body: string) => call(url, { method: 'POST', body });

  async function sourceOf(uid: string, admin: string): Promise<string> {
    const res = await call(`/api/documents/${uid}`, { headers: headers(admin) });
    return ((await res.json()) as { source: string }).source;
  }

  test('minting needs editor', async () => {
    const { uid, admin } = await createDoc();
    expect((await mint(uid, await invite(uid, admin, 'collaborator'))).status).toBe(403);
    expect((await mint(uid, await invite(uid, admin, 'editor'))).status).toBe(201);
  });

  test('an unknown token is refused both ways', async () => {
    expect((await call('/api/source-uploads/nope')).status).toBe(404);
    expect((await send('/api/source-uploads/nope', SOURCE)).status).toBe(404);
  });

  test('the upload re-anchors comments like a direct save', async () => {
    const { uid, admin } = await createDoc();
    const blocks = async () => {
      const res = await call(`/api/documents/${uid}`, { headers: headers(admin) });
      return ((await res.json()) as { rendered: { blocks: Array<{ id: string; text: string }> } })
        .rendered.blocks;
    };
    const before = (await blocks()).find((b) => b.text === 'First finding.');
    const created = await call(`/api/documents/${uid}/threads`, {
      method: 'POST',
      headers: headers(admin),
      body: JSON.stringify({ anchor: { block_id: before?.id, quote: 'finding' }, body: 'Source?' }),
    });
    expect(created.status).toBe(201);

    const url = await urlFor(uid, admin);
    expect((await send(url, '# Report\n\nFirst finding, revised.\n')).status).toBe(201);
    const after = (await blocks()).find((b) => b.text === 'First finding, revised.');
    expect(after?.id).not.toBe(before?.id);
    const listed = await call(`/api/documents/${uid}/threads`, { headers: headers(admin) });
    const [thread] = ((await listed.json()) as { threads: Array<{ anchor: { block_id: string } }> })
      .threads;
    expect(thread?.anchor.block_id).toBe(after?.id as string);
  });

  test('a file over the size limit is refused and leaves the URL usable', async () => {
    const { uid, admin } = await createDoc();
    const url = await urlFor(uid, admin);
    expect((await send(url, `# Big\n\n${'x'.repeat(2048)}\n`)).status).toBe(413);
    expect((await send(url, '# Small\n')).status).toBe(201);
    expect(await sourceOf(uid, admin)).toBe('# Small\n');
  });

  test('deleting the invite that minted a URL revokes it', async () => {
    const { uid, admin } = await createDoc();
    const editor = await invite(uid, admin, 'editor');
    const url = await urlFor(uid, editor);
    await call(`/api/documents/${uid}/invites/${editor}`, {
      method: 'DELETE',
      headers: headers(admin),
    });
    expect((await call(url)).status).toBe(404);
    expect((await send(url, '# Gone\n')).status).toBe(404);
    expect(await sourceOf(uid, admin)).toBe(SOURCE);
  });

  test('revoking the agent key behind a mint revokes its URL, even under an admin link', async () => {
    const { uid, admin } = await createDoc();
    const ring = await call('/api/keyrings', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ docs: [{ doc_uid: uid, invite_token: admin }] }),
    });
    const ringHeaders = headers();
    ringHeaders.set(KEYRING_HEADER, ((await ring.json()) as { token: string }).token);
    const minted = await call('/api/keyrings/self/agents', {
      method: 'POST',
      headers: ringHeaders,
      body: JSON.stringify({ display_name: 'Claude' }),
    });
    const { key, agent } = (await minted.json()) as { key: string; agent: { id: string } };

    const url = await urlFor(uid, admin, key);
    await call(`/api/keyrings/self/agents/${agent.id}`, { method: 'DELETE', headers: ringHeaders });
    expect((await send(url, '# Gone\n')).status).toBe(404);
  });

  test('a document has at most 20 unused URLs at once', async () => {
    const { uid, admin } = await createDoc();
    for (let i = 0; i < 20; i++) expect((await mint(uid, admin)).status).toBe(201);
    expect((await mint(uid, admin)).status).toBe(429);
  });

  test('an identical upload saves no revision and uses the URL up', async () => {
    const { uid, admin } = await createDoc();
    const url = await urlFor(uid, admin);
    const res = await send(url, SOURCE);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { unchanged?: boolean }).unchanged).toBe(true);
    expect((await send(url, '# Again\n')).status).toBe(404);
  });
});
