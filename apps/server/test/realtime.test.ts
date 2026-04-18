import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

const ALICE = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const BOB = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Bob' };

function headersFor(c: { id: string; name: string }): Headers {
  return new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: c.id,
    [CLIENT_NAME_HEADER]: c.name,
  });
}

describe('realtime events', () => {
  let dir: string;
  let app: App;
  let server: ReturnType<typeof Bun.serve> | null = null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-rt-'));
    app = await createApp(loadConfig({ dataDir: dir, port: 0 }));
    server = Bun.serve({
      port: await getAvailablePort(),
      fetch: app.hono.fetch,
      websocket: app.websocket,
    });
  });

  afterEach(() => {
    server?.stop(true);
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function url(path: string): string {
    return `http://localhost:${server?.port}${path}`;
  }

  function wsUrl(path: string): string {
    return `ws://localhost:${server?.port}${path}`;
  }

  let adminToken = '';
  async function uploadDoc(markdown: string): Promise<string> {
    const res = await fetch(url('/api/documents'), {
      method: 'POST',
      headers: headersFor(ALICE),
      body: JSON.stringify({ markdown }),
    });
    const j = (await res.json()) as { uid: string; admin_invite: { token: string } };
    adminToken = j.admin_invite.token;
    return j.uid;
  }

  function asAdmin(c: { id: string; name: string } = ALICE): Headers {
    const h = headersFor(c);
    h.set(INVITE_HEADER, adminToken);
    return h;
  }

  async function createInvite(
    uid: string,
    displayName: string,
    role: 'admin' | 'editor' | 'collaborator' | 'commentor' | 'reader' = 'commentor',
  ): Promise<string> {
    const res = await fetch(url(`/api/documents/${uid}/invites`), {
      method: 'POST',
      headers: asAdmin(),
      body: JSON.stringify({ display_name: displayName, role }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invite: { token: string } };
    return body.invite.token;
  }

  async function firstBlockId(uid: string): Promise<string> {
    const res = await fetch(url(`/api/documents/${uid}`), { headers: headersFor(ALICE) });
    const j = (await res.json()) as { rendered: { blocks: Array<{ id: string }> } };
    const block = j.rendered.blocks[0];
    if (!block) throw new Error('missing rendered block');
    return block.id;
  }

  function openSocket(
    uid: string,
    clientId: string,
    opts: { clientName?: string; inviteToken?: string } = {},
  ): Promise<{ ws: WebSocket; events: unknown[] }> {
    const events: unknown[] = [];
    const params = new URLSearchParams();
    params.set('client_id', clientId);
    if (opts.clientName) params.set('client_name', opts.clientName);
    if (opts.inviteToken) params.set('invite', opts.inviteToken);
    const ws = new WebSocket(`${wsUrl(`/api/documents/${uid}/events`)}?${params.toString()}`);
    ws.addEventListener('message', (e) => {
      events.push(JSON.parse(String(e.data)));
    });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws open timeout')), 3000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve({ ws, events });
      });
      ws.addEventListener('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  async function waitFor<T>(fn: () => T | undefined, ms = 2000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const v = fn();
      if (v !== undefined) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timeout waiting for condition');
  }

  test('subscriber receives comment.created from a different client', async () => {
    const uid = await uploadDoc('# Hi');
    const blockId = await firstBlockId(uid);

    const { ws, events } = await openSocket(uid, BOB.id);
    // Drain the initial 'subscribed' ack
    await waitFor(() => events.find((e) => (e as { type: string }).type === 'subscribed'));

    // Alice posts a comment via HTTP (as admin so the role gate lets her
    // comment on the non-editable public doc).
    const postRes = await fetch(url(`/api/documents/${uid}/comments`), {
      method: 'POST',
      headers: asAdmin(),
      body: JSON.stringify({
        anchor: { block_id: blockId, quote: 'Hi' },
        body: 'hello from alice',
      }),
    });
    expect(postRes.status).toBe(201);

    const received = (await waitFor(() =>
      events.find((e) => (e as { type: string }).type === 'comment.created'),
    )) as { type: string; comment: { body: string; author: { display_name: string } } };
    expect(received.comment.body).toBe('hello from alice');
    expect(received.comment.author.display_name).toBe('Alice');
    ws.close();
  });

  test('sender does NOT receive their own event', async () => {
    const uid = await uploadDoc('# Hi');
    const blockId = await firstBlockId(uid);

    // Alice subscribes with her own client_id
    const { ws, events } = await openSocket(uid, ALICE.id);
    await waitFor(() => events.find((e) => (e as { type: string }).type === 'subscribed'));

    // Alice also posts a comment as admin — should NOT get echoed back
    const postRes = await fetch(url(`/api/documents/${uid}/comments`), {
      method: 'POST',
      headers: asAdmin(),
      body: JSON.stringify({
        anchor: { block_id: blockId, quote: 'Hi' },
        body: 'self',
      }),
    });
    expect(postRes.status).toBe(201);

    // Wait 200ms for any potential message; then assert none arrived.
    await new Promise((r) => setTimeout(r, 200));
    const commentEvent = events.find((e) => (e as { type: string }).type === 'comment.created');
    expect(commentEvent).toBeUndefined();
    ws.close();
  });

  test('whitespace-only document update does NOT broadcast document.updated', async () => {
    const uid = await uploadDoc('# Hello\n\nA paragraph.\n');
    const { ws, events } = await openSocket(uid, BOB.id);
    await waitFor(() => events.find((e) => (e as { type: string }).type === 'subscribed'));

    // Only whitespace change: trailing newlines + spaces.
    const putRes = await fetch(url(`/api/documents/${uid}`), {
      method: 'PUT',
      headers: asAdmin(),
      body: JSON.stringify({ markdown: '#    Hello\n\n\n\nA paragraph.   \n\n\n' }),
    });
    expect(putRes.status).toBe(200);

    await new Promise((r) => setTimeout(r, 200));
    const docEvent = events.find((e) => (e as { type: string }).type === 'document.updated');
    expect(docEvent).toBeUndefined();
    ws.close();
  });

  test('real content document update DOES broadcast document.updated', async () => {
    const uid = await uploadDoc('# Hello\n\nA paragraph.\n');
    const { ws, events } = await openSocket(uid, BOB.id);
    await waitFor(() => events.find((e) => (e as { type: string }).type === 'subscribed'));

    const putRes = await fetch(url(`/api/documents/${uid}`), {
      method: 'PUT',
      headers: asAdmin(),
      body: JSON.stringify({ markdown: '# Hello\n\nA different paragraph.\n' }),
    });
    expect(putRes.status).toBe(200);

    const received = (await waitFor(() =>
      events.find((e) => (e as { type: string }).type === 'document.updated'),
    )) as { type: string; author: string };
    expect(received.author).toBe('Alice');
    ws.close();
  });

  test('mentioned invitee receives mention.created while the doc is open', async () => {
    const uid = await uploadDoc('# Hi');
    const blockId = await firstBlockId(uid);
    const bobInvite = await createInvite(uid, 'Bob', 'commentor');

    const { ws, events } = await openSocket(uid, BOB.id, { inviteToken: bobInvite });
    await waitFor(() => events.find((e) => (e as { type: string }).type === 'subscribed'));

    const postRes = await fetch(url(`/api/documents/${uid}/comments`), {
      method: 'POST',
      headers: asAdmin(),
      body: JSON.stringify({
        anchor: { block_id: blockId, quote: 'Hi' },
        body: 'hello @Bob',
      }),
    });
    expect(postRes.status).toBe(201);

    const received = (await waitFor(() =>
      events.find((e) => (e as { type: string }).type === 'mention.created'),
    )) as { type: string; comment: { body: string } };
    expect(received.comment.body).toBe('hello @Bob');
    ws.close();
  });
});

async function getAvailablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();

    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('failed to allocate port'));
        return;
      }

      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}
