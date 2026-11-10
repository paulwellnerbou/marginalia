import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { AGENT_INVITE_NOTE, AGENT_KEY_HEADER } from '../src/routes/agent-keys.js';
import { KEYRING_HEADER } from '../src/routes/keyrings.js';

const OWNER = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Paul' };
const AGENT = { id: 'mcp-agent-client-0000', name: 'Claude' };

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

interface CreateResponse {
  uid: string;
  admin_invite: { token: string };
}

describe('keyring agent keys', () => {
  let dir: string;
  let webDir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-agent-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-agent-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir }));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  function call(path: string, init: { method?: string; headers: Headers; body?: unknown }) {
    return app.hono.fetch(
      new Request(`http://test${path}`, {
        method: init.method ?? 'GET',
        headers: init.headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
    );
  }

  async function upload(
    client: typeof OWNER = OWNER,
    body: Record<string, unknown> = {},
  ): Promise<CreateResponse> {
    const res = await call('/api/documents', {
      method: 'POST',
      headers: headersFor(client),
      body: { markdown: '# Hi\n\nText.\n', ...body },
    });
    expect(res.status).toBe(201);
    return (await res.json()) as CreateResponse;
  }

  async function ringWith(...docs: CreateResponse[]): Promise<string> {
    const res = await call('/api/keyrings', {
      method: 'POST',
      headers: headersFor(OWNER),
      body: { docs: docs.map((d) => ({ doc_uid: d.uid, invite_token: d.admin_invite.token })) },
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { token: string }).token;
  }

  const ring = (token: string) => headersFor(OWNER, { [KEYRING_HEADER]: token });
  const agent = (key: string) => headersFor(AGENT, { [AGENT_KEY_HEADER]: key });

  async function mintKey(
    ringToken: string,
    body: Record<string, unknown> = { display_name: 'Claude' },
  ): Promise<{ key: string; agent: { id: string; role: string; display_name: string } }> {
    const res = await call('/api/keyrings/self/agents', {
      method: 'POST',
      headers: ring(ringToken),
      body,
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      key: string;
      agent: { id: string; role: string; display_name: string };
    };
  }

  async function access(key: string, uid: string): Promise<Response> {
    return call(`/api/agent/documents/${uid}/access`, { method: 'POST', headers: agent(key) });
  }

  async function roleWith(uid: string, token: string): Promise<string> {
    const res = await call(`/api/documents/${uid}`, {
      headers: headersFor(AGENT, { [INVITE_HEADER]: token }),
    });
    if (res.status !== 200) return `http-${res.status}`;
    return ((await res.json()) as { role: string }).role;
  }

  test('the key is shown once and only its hash is stored', async () => {
    const doc = await upload();
    const token = await ringWith(doc);
    const { key, agent: wire } = await mintKey(token);

    expect(key.startsWith('mak_')).toBe(true);
    expect(wire.role).toBe('collaborator');
    const stored = app.db.prepare('SELECT key_hash FROM keyring_agents').get() as {
      key_hash: string;
    };
    expect(stored.key_hash).not.toBe(key);

    const list = await call('/api/keyrings/self/agents', { headers: ring(token) });
    const body = JSON.stringify(await list.json());
    expect(body).not.toContain(key);
    expect(body).toContain('"display_name":"Claude"');
  });

  test('the key itself opens no document', async () => {
    const doc = await upload();
    const { key } = await mintKey(await ringWith(doc));
    const res = await call(`/api/documents/${doc.uid}`, { headers: agent(key) });
    // Documents are invite-only by default: a key in place of an invite is nothing.
    expect(res.status).toBe(401);
  });

  test('access mints a named invite at the key’s role and reuses it', async () => {
    const doc = await upload();
    const { key } = await mintKey(await ringWith(doc), { display_name: 'Claude', role: 'editor' });

    const first = await access(key, doc.uid);
    expect(first.status).toBe(200);
    const granted = (await first.json()) as { invite_token: string; role: string };
    expect(granted.role).toBe('editor');
    expect(await roleWith(doc.uid, granted.invite_token)).toBe('editor');

    const invite = app.db
      .prepare('SELECT kind, display_name, note, created_by_name FROM invites WHERE token = ?')
      .get(granted.invite_token) as Record<string, string>;
    expect(invite).toEqual({
      kind: 'named',
      display_name: 'Claude',
      note: AGENT_INVITE_NOTE,
      created_by_name: 'Paul',
    });

    const again = (await (await access(key, doc.uid)).json()) as { invite_token: string };
    expect(again.invite_token).toBe(granted.invite_token);
  });

  test('a document outside the ring, or held without an admin link, is refused', async () => {
    const mine = await upload();
    const theirs = await upload({ id: 'cccccccccccccccccccc', name: 'Ann' });
    // Ann gives Paul a collaborator link; it sits in his ring but is not his to delegate.
    const shared = await call(`/api/documents/${theirs.uid}/invites`, {
      method: 'POST',
      headers: headersFor(
        { id: 'cccccccccccccccccccc', name: 'Ann' },
        { [INVITE_HEADER]: theirs.admin_invite.token },
      ),
      body: { kind: 'named', display_name: 'Paul', role: 'collaborator' },
    });
    const sharedToken = ((await shared.json()) as { invite: { token: string } }).invite.token;
    const token = await ringWith(mine);
    await call(`/api/keyrings/self/docs/${theirs.uid}`, {
      method: 'PUT',
      headers: ring(token),
      body: { invite_token: sharedToken },
    });
    const outside = await upload();
    const { key } = await mintKey(token);

    expect((await access(key, outside.uid)).status).toBe(404);
    const notMine = await access(key, theirs.uid);
    expect(notMine.status).toBe(403);
    expect(((await notMine.json()) as { error: string }).error).toBe('not-delegable');

    const listed = (await (await call('/api/agent/documents', { headers: agent(key) })).json()) as {
      docs: Array<{ doc_uid: string; role: string | null }>;
    };
    expect(JSON.stringify(listed)).not.toContain(sharedToken);
    expect(Object.fromEntries(listed.docs.map((d) => [d.doc_uid, d.role]))).toEqual({
      [mine.uid]: 'collaborator',
      [theirs.uid]: null,
    });
  });

  test('revoking the key deletes every invite it was given', async () => {
    const a = await upload();
    const b = await upload();
    const token = await ringWith(a, b);
    const { key, agent: wire } = await mintKey(token);
    const tokenA = ((await (await access(key, a.uid)).json()) as { invite_token: string })
      .invite_token;
    const tokenB = ((await (await access(key, b.uid)).json()) as { invite_token: string })
      .invite_token;

    const del = await call(`/api/keyrings/self/agents/${wire.id}`, {
      method: 'DELETE',
      headers: ring(token),
    });
    expect(del.status).toBe(204);
    expect(await roleWith(a.uid, tokenA)).toBe('http-401');
    expect(await roleWith(b.uid, tokenB)).toBe('http-401');
    expect((await access(key, a.uid)).status).toBe(401);
  });

  test('forgetting a document from the ring takes the agent’s invite there with it', async () => {
    const a = await upload();
    const b = await upload();
    const token = await ringWith(a, b);
    const { key } = await mintKey(token);
    const tokenA = ((await (await access(key, a.uid)).json()) as { invite_token: string })
      .invite_token;
    const tokenB = ((await (await access(key, b.uid)).json()) as { invite_token: string })
      .invite_token;

    await call(`/api/keyrings/self/docs/${a.uid}`, { method: 'DELETE', headers: ring(token) });
    expect(await roleWith(a.uid, tokenA)).toBe('http-401');
    expect(await roleWith(b.uid, tokenB)).toBe('collaborator');
  });

  test('a ring swept for idleness takes its agents’ invites with it', async () => {
    const doc = await upload();
    const token = await ringWith(doc);
    const { key } = await mintKey(token);
    const granted = ((await (await access(key, doc.uid)).json()) as { invite_token: string })
      .invite_token;

    app.db.prepare('UPDATE keyrings SET updated_at = 0 WHERE token = ?').run(token);
    // The sweep runs when the next ring is created.
    await ringWith();
    expect(await roleWith(doc.uid, granted)).toBe('http-401');
    expect((await access(key, doc.uid)).status).toBe(401);
  });

  test('deleting the ring revokes its agents', async () => {
    const doc = await upload();
    const token = await ringWith(doc);
    const { key } = await mintKey(token);
    const granted = ((await (await access(key, doc.uid)).json()) as { invite_token: string })
      .invite_token;
    expect(await roleWith(doc.uid, granted)).toBe('collaborator');

    await call('/api/keyrings/self', { method: 'DELETE', headers: ring(token) });
    expect(await roleWith(doc.uid, granted)).toBe('http-401');
    expect((await access(key, doc.uid)).status).toBe(401);
  });

  test('rotating the ring revokes its agents, which the old token could have minted', async () => {
    const doc = await upload();
    const token = await ringWith(doc);
    const { key } = await mintKey(token);
    const granted = ((await (await access(key, doc.uid)).json()) as { invite_token: string })
      .invite_token;

    const rotated = await call('/api/keyrings/self/rotate', {
      method: 'POST',
      headers: ring(token),
    });
    const fresh = ((await rotated.json()) as { token: string }).token;
    expect(await roleWith(doc.uid, granted)).toBe('http-401');
    expect((await access(key, doc.uid)).status).toBe(401);
    const left = await call('/api/keyrings/self/agents', { headers: ring(fresh) });
    expect(((await left.json()) as { agents: unknown[] }).agents).toEqual([]);
  });

  test('opening a document through a lesser link keeps the ring’s admin link', async () => {
    const doc = await upload();
    const token = await ringWith(doc);
    const { key } = await mintKey(token);
    const granted = ((await (await access(key, doc.uid)).json()) as { invite_token: string })
      .invite_token;
    const reviewer = await call(`/api/documents/${doc.uid}/invites`, {
      method: 'POST',
      headers: headersFor(OWNER, { [INVITE_HEADER]: doc.admin_invite.token }),
      body: { kind: 'named', display_name: 'Ann', role: 'collaborator' },
    });
    const reviewerToken = ((await reviewer.json()) as { invite: { token: string } }).invite.token;

    const put = await call(`/api/keyrings/self/docs/${doc.uid}`, {
      method: 'PUT',
      headers: ring(token),
      body: { invite_token: reviewerToken },
    });
    expect(put.status).toBe(200);
    const pulled = (await (await call('/api/keyrings/self', { headers: ring(token) })).json()) as {
      docs: Array<{ invite_token: string }>;
    };
    expect(pulled.docs.map((d) => d.invite_token)).toEqual([doc.admin_invite.token]);
    expect(await roleWith(doc.uid, granted)).toBe('collaborator');
  });

  test('a rotated admin link the ring has not caught up with keeps invites but mints none', async () => {
    const doc = await upload();
    const token = await ringWith(doc);
    const holder = await mintKey(token);
    const granted = (
      (await (await access(holder.key, doc.uid)).json()) as {
        invite_token: string;
      }
    ).invite_token;
    const newcomer = await mintKey(token, { display_name: 'Codex' });

    // Rotated on a device that is not syncing: the ring still holds the dead link.
    const rotated = await call(`/api/documents/${doc.uid}/invites/admin/rotate`, {
      method: 'POST',
      headers: headersFor(OWNER, { [INVITE_HEADER]: doc.admin_invite.token }),
    });
    expect(rotated.status).toBe(200);

    const kept = (await (await access(holder.key, doc.uid)).json()) as { invite_token: string };
    expect(kept.invite_token).toBe(granted);
    const refused = await access(newcomer.key, doc.uid);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { error: string }).error).toBe('keyring-link-stale');

    const listed = (await (
      await call('/api/agent/documents', { headers: agent(newcomer.key) })
    ).json()) as { docs: Array<{ role: string | null; link_stale: boolean }> };
    expect(listed.docs).toEqual([expect.objectContaining({ role: null, link_stale: true })]);
  });

  test('one admin link in the ring opens the rest of its folder', async () => {
    const story = await upload();
    const added = await call('/api/documents', {
      method: 'POST',
      headers: headersFor(OWNER, { [INVITE_HEADER]: story.admin_invite.token }),
      body: { folder: story.uid, name: 'OUTLINE', source: '# Outline\n' },
    });
    const outline = (await added.json()) as { uid: string };
    const { key } = await mintKey(await ringWith(story));

    const res = await access(key, outline.uid);
    expect(res.status).toBe(200);
    const granted = (await res.json()) as { invite_token: string; gate_uid: string };
    expect(granted.gate_uid).toBe(story.uid);
    expect(await roleWith(outline.uid, granted.invite_token)).toBe('collaborator');
  });

  test('an agent files the documents it creates into the ring, admin links only', async () => {
    const seed = await upload();
    const token = await ringWith(seed);
    const { key } = await mintKey(token);
    const created = await upload(AGENT);

    const lesser = await call(`/api/documents/${created.uid}/invites`, {
      method: 'POST',
      headers: headersFor(AGENT, { [INVITE_HEADER]: created.admin_invite.token }),
      body: { kind: 'generic', role: 'reader' },
    });
    const readerToken = ((await lesser.json()) as { invite: { token: string } }).invite.token;
    const refused = await call(`/api/agent/documents/${created.uid}`, {
      method: 'PUT',
      headers: agent(key),
      body: { invite_token: readerToken },
    });
    expect(refused.status).toBe(403);

    const filed = await call(`/api/agent/documents/${created.uid}`, {
      method: 'PUT',
      headers: agent(key),
      body: { invite_token: created.admin_invite.token, title: 'Draft' },
    });
    expect(filed.status).toBe(200);
    const pulled = (await (await call('/api/keyrings/self', { headers: ring(token) })).json()) as {
      docs: Array<{ doc_uid: string; title: string; role: string }>;
    };
    expect(pulled.docs.find((d) => d.doc_uid === created.uid)).toMatchObject({
      title: 'Draft',
      role: 'admin',
    });
  });

  test('the owner opening a filed admin link is signed as themself, not the agent', async () => {
    const token = await ringWith(await upload());
    const { key } = await mintKey(token);
    const created = await upload(AGENT);
    await call(`/api/agent/documents/${created.uid}`, {
      method: 'PUT',
      headers: agent(key),
      body: { invite_token: created.admin_invite.token },
    });

    // Another device of the owner's, before it has adopted the ring's name.
    const device = { id: 'dddddddddddddddddddd', name: 'Swift Otter' };
    const opened = await call(`/api/documents/${created.uid}`, {
      headers: headersFor(device, { [INVITE_HEADER]: created.admin_invite.token }),
    });
    expect(((await opened.json()) as { display_name: string }).display_name).toBe(OWNER.name);
  });

  test('an admin link someone handed the agent keeps its owner’s name when filed', async () => {
    const token = await ringWith(await upload());
    const { key } = await mintKey(token);
    const anns = await upload({ id: 'cccccccccccccccccccc', name: 'Ann' });
    const filed = await call(`/api/agent/documents/${anns.uid}`, {
      method: 'PUT',
      headers: agent(key),
      body: { invite_token: anns.admin_invite.token },
    });
    expect(filed.status).toBe(200);
    const row = app.db
      .prepare('SELECT display_name FROM invites WHERE token = ?')
      .get(anns.admin_invite.token) as { display_name: string };
    expect(row.display_name).toBe('Ann');
  });

  test('startup renames admin links agents filed before filing renamed them', async () => {
    const token = await ringWith(await upload());
    await mintKey(token);
    const created = await upload(AGENT);
    // As filed by a server that did not rename on filing.
    app.db
      .prepare(
        `INSERT INTO keyring_docs (keyring_token, doc_uid, invite_token, title, added_at)
         VALUES (?, ?, ?, NULL, 0)`,
      )
      .run(token, created.uid, created.admin_invite.token);

    // The same link in a second ring, whose agents have other names.
    const other = await ringWith();
    app.db
      .prepare(
        `INSERT INTO keyring_docs (keyring_token, doc_uid, invite_token, title, added_at)
         VALUES (?, ?, ?, NULL, 0)`,
      )
      .run(other, created.uid, created.admin_invite.token);
    app.db.prepare('UPDATE keyrings SET display_name = ? WHERE token = ?').run('Ann', other);

    await app.close();
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir }));
    const row = app.db
      .prepare('SELECT display_name FROM invites WHERE token = ?')
      .get(created.admin_invite.token) as { display_name: string };
    expect(row.display_name).toBe(OWNER.name);
  });

  test('names are unique per ring and roles are capped below admin', async () => {
    const token = await ringWith(await upload());
    await mintKey(token);
    const dup = await call('/api/keyrings/self/agents', {
      method: 'POST',
      headers: ring(token),
      body: { display_name: 'claude' },
    });
    expect(dup.status).toBe(409);
    const admin = await call('/api/keyrings/self/agents', {
      method: 'POST',
      headers: ring(token),
      body: { display_name: 'Codex', role: 'admin' },
    });
    expect(admin.status).toBe(400);
  });

  test('an agent invite deleted from the access panel is minted again on next use', async () => {
    const doc = await upload();
    const { key } = await mintKey(await ringWith(doc));
    const first = ((await (await access(key, doc.uid)).json()) as { invite_token: string })
      .invite_token;
    await call(`/api/documents/${doc.uid}/invites/${first}`, {
      method: 'DELETE',
      headers: headersFor(OWNER, { [INVITE_HEADER]: doc.admin_invite.token }),
    });
    const second = ((await (await access(key, doc.uid)).json()) as { invite_token: string })
      .invite_token;
    expect(second).not.toBe(first);
    expect(await roleWith(doc.uid, second)).toBe('collaborator');
  });

  async function setDocRole(ringToken: string, agentId: string, uid: string, role: string) {
    return call(`/api/keyrings/self/agents/${agentId}/documents/${uid}`, {
      method: 'PUT',
      headers: ring(ringToken),
      body: { role },
    });
  }

  async function docRoles(ringToken: string, uid: string) {
    const res = await call(`/api/keyrings/self/agents?doc=${uid}`, { headers: ring(ringToken) });
    const body = (await res.json()) as {
      agents: Array<{ display_name: string; document: { role: string; invited: boolean } | null }>;
    };
    return Object.fromEntries(body.agents.map((a) => [a.display_name, a.document]));
  }

  test('re-roling a key moves its invites at the old role and leaves set ones alone', async () => {
    const a = await upload();
    const b = await upload();
    const token = await ringWith(a, b);
    const { key, agent: wire } = await mintKey(token);
    const onA = ((await (await access(key, a.uid)).json()) as { invite_token: string })
      .invite_token;
    expect((await setDocRole(token, wire.id, b.uid, 'reader')).status).toBe(200);
    const onB = ((await (await access(key, b.uid)).json()) as { invite_token: string })
      .invite_token;

    const res = await call(`/api/keyrings/self/agents/${wire.id}`, {
      method: 'PATCH',
      headers: ring(token),
      body: { role: 'editor' },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { agent: { role: string } }).agent.role).toBe('editor');
    expect(await roleWith(a.uid, onA)).toBe('editor');
    expect(await roleWith(b.uid, onB)).toBe('reader');

    // A document the agent opens later gets the new role.
    const c = await upload();
    await call(`/api/keyrings/self/docs/${c.uid}`, {
      method: 'PUT',
      headers: ring(token),
      body: { invite_token: c.admin_invite.token },
    });
    expect(((await (await access(key, c.uid)).json()) as { role: string }).role).toBe('editor');

    const admin = await call(`/api/keyrings/self/agents/${wire.id}`, {
      method: 'PATCH',
      headers: ring(token),
      body: { role: 'admin' },
    });
    expect(admin.status).toBe(400);
    const otherRing = await ringWith(await upload());
    const foreign = await call(`/api/keyrings/self/agents/${wire.id}`, {
      method: 'PATCH',
      headers: ring(otherRing),
      body: { role: 'reader' },
    });
    expect(foreign.status).toBe(404);
  });

  test('a role set on a document waits for the agent and shows in its lists', async () => {
    const doc = await upload();
    const token = await ringWith(doc);
    const { key, agent: wire } = await mintKey(token);
    expect(await docRoles(token, doc.uid)).toEqual({
      Claude: { role: 'collaborator', invited: false },
    });

    expect((await setDocRole(token, wire.id, doc.uid, 'editor')).status).toBe(200);
    expect(await docRoles(token, doc.uid)).toEqual({ Claude: { role: 'editor', invited: true } });
    const listed = (await (await call('/api/agent/documents', { headers: agent(key) })).json()) as {
      docs: Array<{ doc_uid: string; role: string | null }>;
    };
    expect(listed.docs.find((d) => d.doc_uid === doc.uid)?.role).toBe('editor');

    const granted = (await (await access(key, doc.uid)).json()) as {
      invite_token: string;
      role: string;
    };
    expect(granted.role).toBe('editor');
    expect((await setDocRole(token, wire.id, doc.uid, 'reader')).status).toBe(200);
    expect(await roleWith(doc.uid, granted.invite_token)).toBe('reader');
    expect((await setDocRole(token, wire.id, doc.uid, 'admin')).status).toBe(400);
  });

  test('a document the ring cannot delegate takes no role', async () => {
    const mine = await upload();
    const token = await ringWith(mine);
    const { agent: wire } = await mintKey(token);
    const outside = await upload();
    expect((await setDocRole(token, wire.id, outside.uid, 'editor')).status).toBe(404);
    expect(await docRoles(token, outside.uid)).toEqual({ Claude: null });
    expect(app.db.prepare('SELECT count(*) AS n FROM keyring_agent_invites').get()).toEqual({
      n: 0,
    });
  });
});
