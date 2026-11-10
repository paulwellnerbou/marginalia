import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type App, createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { publicUrl } from '../src/routes/mcp.js';

/**
 * The hosted MCP endpoint, driven by a real MCP client over real HTTP.
 * This is the path a user gets by pasting a URL into their agent, so it
 * is worth proving end to end rather than unit-testing the router.
 */
describe('hosted MCP endpoint', () => {
  let dir: string;
  let app: App;
  let http: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-http-'));
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir: join(dir, 'web') }));
    http = Bun.serve({ port: 0, fetch: app.hono.fetch, websocket: app.websocket });
    baseUrl = `http://localhost:${http.port}`;
  });

  afterEach(async () => {
    http.stop(true);
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function connect(query = '', headers: Record<string, string> = {}): Promise<Client> {
    const client = new Client({ name: 'test', version: '0' });
    // The SDK's client transport declares `sessionId?: string`, which the
    // repo's exactOptionalPropertyTypes rejects against `Transport`.
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp${query}`), {
      requestInit: { headers },
    });
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    return client;
  }

  async function callText(
    client: Client,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const res = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ text?: string }>;
      isError?: boolean;
    };
    const body = res.content.map((c) => c.text ?? '').join('\n');
    if (res.isError) throw new Error(`${name}: ${body}`);
    return body;
  }

  test('serves the same tool set as the stdio server', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.map((t) => t.name)).toContain('create_proposal');
    expect(tools.map((t) => t.name)).toContain('list_threads');
    await client.close();
  });

  test('opens a quiet SSE stream immediately and keeps it alive', async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'quiet-stream-test', version: '0' },
        },
      }),
    });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    // No notifications are sent to this stream. The opening comment must
    // flush the response before a client's five-second connection deadline,
    // then the periodic comment must keep it ahead of Bun's idle timeout.
    const streamStartedAt = Date.now();
    const stream = await fetch(`${baseUrl}/mcp`, {
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId as string,
        'mcp-protocol-version': '2025-06-18',
      },
      signal: AbortSignal.timeout(9_000),
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    expect(Date.now() - streamStartedAt).toBeLessThan(5_000);

    const body = stream.body;
    expect(body).toBeTruthy();
    if (!body) throw new Error('SSE response has no body');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!buffer.includes(': keepalive\n\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
    }
    expect(buffer.startsWith(': connected\n\n')).toBe(true);
    expect(buffer).toContain(': keepalive\n\n');

    await reader.cancel();

    // A reconnect uses the same session. The route must retire the previous
    // stream even when Bun did not propagate the client's cancellation, or
    // the SDK's single-active-GET guard rejects the successor.
    const reconnected = await fetch(`${baseUrl}/mcp`, {
      headers: {
        accept: 'text/event-stream',
        'mcp-session-id': sessionId as string,
        'mcp-protocol-version': '2025-06-18',
      },
      signal: AbortSignal.timeout(2_000),
    });
    expect(reconnected.status).toBe(200);
    const reconnectedReader = reconnected.body?.getReader();
    const opened = await reconnectedReader?.read();
    expect(decoder.decode(opened?.value)).toStartWith(': connected\n\n');
    await reconnectedReader?.cancel();

    await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId as string },
    });
  }, 10_000);

  test('creates and reads a document with no local install', async () => {
    const client = await connect();
    const created = await callText(client, 'create_document', {
      source: '# Hosted\n\nA paragraph to review.\n',
      name: 'Hosted',
    });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    expect(adminUrl).toContain(baseUrl);

    const doc = await callText(client, 'get_document', { document: adminUrl });
    expect(doc).toContain('A paragraph to review.');
    await client.close();
  });

  test('a document it creates is invite-only, and it says so about the bare link', async () => {
    const client = await connect();
    const created = await callText(client, 'create_document', { source: '# Hosted\n\nBody.\n' });
    // The bare link is still worth printing — the agent needs the uid, and
    // it is the URL a recipient ends up with — but handing it to a person
    // does nothing, and the tool has to say that rather than call it a
    // "read-only link".
    expect(created).toContain('invite-only');
    expect(created).not.toContain('read-only link');

    const uid = /^uid: (\S+)$/m.exec(created)?.[1] as string;
    const stranger = await connect('?name=Nobody');
    const res = (await stranger.callTool({
      name: 'get_document',
      arguments: { document: `${baseUrl}/d/${uid}`, include_source: false },
    })) as { content: Array<{ text?: string }>; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => c.text).join('')).toContain('invite-required');
    await stranger.close();
    await client.close();
  });

  test('signs its work with the name given in the URL', async () => {
    const client = await connect('?name=Codex');
    const created = await callText(client, 'create_document', { source: '# Doc\n\nBody.\n' });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    await callText(client, 'create_comment', {
      document: adminUrl,
      anchor_text: 'Body.',
      body: 'A note from the agent.',
    });

    const threads = await callText(client, 'list_threads', { document: adminUrl });
    expect(threads).toContain('Codex');
    await client.close();
  });

  test('keeps the same identity across reconnects, so it still owns its comments', async () => {
    const first = await connect('?name=Codex');
    const created = await callText(first, 'create_document', { source: '# Doc\n\nBody.\n' });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    const comment = await callText(first, 'create_comment', {
      document: adminUrl,
      anchor_text: 'Body.',
      body: 'First draft of the note.',
    });
    const threadId = /^thread_id: (\S+)/m.exec(comment)?.[1] as string;
    await first.close();

    // A fresh connection: editing its own comment must still be allowed.
    const second = await connect('?name=Codex');
    await callText(second, 'edit_comment', {
      document: adminUrl,
      thread_id: threadId,
      comment_id: threadId,
      body: 'Revised note.',
    });
    expect(await callText(second, 'list_threads', { document: adminUrl })).toContain(
      'Revised note.',
    );
    await second.close();
  });

  test('a named invite seeds the first write, so the URL must carry the same name', async () => {
    const admin = await connect('?name=Paul');
    const created = await callText(admin, 'create_document', { source: '# Doc\n\nAlpha.\n' });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    const thread = await callText(admin, 'create_comment', {
      document: adminUrl,
      anchor_text: 'Alpha.',
      body: 'a question',
    });
    const threadId = /^thread_id: (\S+)/m.exec(thread)?.[1] as string;
    const invite = await callText(admin, 'create_invite', {
      document: adminUrl,
      role: 'collaborator',
      display_name: 'Claude',
    });
    const link = /(http\S+)/.exec(invite)?.[1] as string;

    // A write as the agent's very first request, with no prior read.
    // `authorize()` seeds a named invite's own display name onto a
    // client it hasn't seen, so a mismatched URL name loses this one
    // write — which is why the MCP tab derives `?name=` from the invite
    // rather than letting the two be set independently.
    const mismatched = await connect('?name=Codex');
    await callText(mismatched, 'reply_to_thread', {
      document: link,
      thread_id: threadId,
      body: 'reply from a mismatched name',
    });
    await mismatched.close();
    expect(await callText(admin, 'list_threads', { document: adminUrl })).toContain(
      '[reply 1] Claude',
    );

    // Matching names — what the tab generates — attribute correctly from
    // the first request onward.
    const matched = await connect('?name=Claude');
    await callText(matched, 'reply_to_thread', {
      document: link,
      thread_id: threadId,
      body: 'reply from the matching name',
    });
    await matched.close();
    const threads = await callText(admin, 'list_threads', { document: adminUrl });
    expect(threads).toContain('[reply 2] Claude');
    await admin.close();
  });

  test('a named invite makes the agent @-mentionable before it connects', async () => {
    const admin = await connect('?name=Paul');
    const created = await callText(admin, 'create_document', { source: '# Doc\n\nAlpha.\n' });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    await callText(admin, 'create_invite', {
      document: adminUrl,
      role: 'collaborator',
      display_name: 'Claude',
    });

    // The whole point of naming the invite: you can write "@Claude look
    // at this" and let the agent find the mention on its first visit.
    expect(await callText(admin, 'list_threads', { document: adminUrl })).toContain(
      '@-mentionable names: Claude, Paul',
    );
    await admin.close();
  });

  test('two agents sharing a name share one identity', async () => {
    // Why agent names must be unique: the client id is derived from the
    // name, and Marginalia decides comment ownership by client id. Same
    // name means the same participant, not two of them.
    const admin = await connect('?name=Paul');
    const created = await callText(admin, 'create_document', { source: '# Doc\n\nAlpha.\n' });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;

    const first = await connect('?name=Code');
    const comment = await callText(first, 'create_comment', {
      document: adminUrl,
      anchor_text: 'Alpha.',
      body: 'written by the first agent',
    });
    const threadId = /^thread_id: (\S+)/m.exec(comment)?.[1] as string;
    await first.close();

    // A different agent, same name — and it can rewrite the other's comment.
    const second = await connect('?name=Code');
    await callText(second, 'edit_comment', {
      document: adminUrl,
      thread_id: threadId,
      comment_id: threadId,
      body: 'silently rewritten by the second agent',
    });
    await second.close();

    expect(await callText(admin, 'list_threads', { document: adminUrl })).toContain(
      'silently rewritten by the second agent',
    );

    // Distinct ids keep them apart, which is the escape hatch.
    const third = await connect('?name=Code&client_id=a-separate-agent-id');
    const res = (await third.callTool({
      name: 'edit_comment',
      arguments: { document: adminUrl, thread_id: threadId, comment_id: threadId, body: 'nope' },
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
    await third.close();
    await admin.close();
  });

  test('has no filesystem tools, so it cannot be used to read or write the host', async () => {
    const client = await connect();
    const { tools } = await client.listTools();

    // Writing files would land on the Marginalia host, unreachable by the
    // caller, and `output_dir` accepts an absolute path — so the tool is
    // withheld entirely rather than sandboxed.
    expect(tools.map((t) => t.name)).not.toContain('export_document');

    // Same for reading: creating a document needs no invite, so a
    // `source_path` would hand the server's files to anyone who asked.
    const create = tools.find((t) => t.name === 'create_document');
    const properties = Object.keys(
      (create?.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {},
    );
    expect(properties).toContain('source');
    expect(properties).not.toContain('source_path');
    await client.close();
  });

  test('ignores a source_path even if a client sends one anyway', async () => {
    const client = await connect();
    // The schema omits it, but a hand-rolled client can still put it on
    // the wire; the handler must not act on it.
    const res = (await client.callTool({
      name: 'create_document',
      arguments: { source_path: '/etc/passwd', name: 'Nope' },
    })) as { content: Array<{ text?: string }>; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => c.text).join('')).toContain('no access to local files');
    await client.close();
  });

  test('strips control characters out of the identity given in the URL', async () => {
    // A newline in the name percent-encodes safely onto the wire but
    // decodes back to a raw CR/LF in the database, where it corrupts the
    // line-oriented text these tools emit. A newline in client_id is
    // worse: it is sent verbatim, and Headers.set rejects it outright.
    const agent = await connect('?name=Ev%0D%0Ail&client_id=aaaa%0D%0Abbbb');
    const created = await callText(agent, 'create_document', { source: '# Doc\n\nAlpha.\n' });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    await callText(agent, 'create_comment', {
      document: adminUrl,
      anchor_text: 'Alpha.',
      body: 'a note',
    });

    const threads = await callText(agent, 'list_threads', { document: adminUrl });
    expect(threads).toContain('[opener] Evil');
    expect(threads).not.toContain('Ev\r');
    expect(threads).not.toContain('Ev\n');
    await agent.close();
  });

  test('a token on the connection covers references that carry none', async () => {
    const admin = await connect('?name=Paul');
    // Not invite-only: this is about what a token adds on top of the
    // anonymous reader role, which an invite-only doc would not grant.
    const created = await callText(admin, 'create_document', {
      source: '# Doc\n\nAlpha.\n',
      invite_only: false,
    });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    const uid = /^uid: (\S+)$/m.exec(created)?.[1] as string;
    const invite = await callText(admin, 'create_invite', {
      document: adminUrl,
      role: 'collaborator',
      display_name: 'Claude',
    });
    const token = new URL(/(http\S+)/.exec(invite)?.[1] as string).pathname.split('/')[3] as string;
    await admin.close();

    // The viewer strips the token from the URL once an invite is claimed,
    // so a copied comment link looks like this — no token at all.
    const tokenless = `${baseUrl}/d/${uid}`;

    const without = await connect('?name=Claude');
    expect(
      await callText(without, 'get_document', { document: tokenless, include_source: false }),
    ).toContain('your role: reader');
    await without.close();

    const withToken = await connect(`?name=Claude&token=${token}`);
    expect(
      await callText(withToken, 'get_document', { document: tokenless, include_source: false }),
    ).toContain('your role: collaborator');
    // And it can act, not just read.
    await callText(withToken, 'create_comment', {
      document: tokenless,
      anchor_text: 'Alpha.',
      body: 'written through the connection token',
    });
    await withToken.close();
  });

  test('an agent key opens the whole keyring by bare uid, and files what it creates', async () => {
    const owner = {
      'content-type': 'application/json',
      'x-marginalia-client': 'owner-client-0001',
      'x-marginalia-client-name': 'Paul',
    };
    const upload = async (title: string) => {
      const res = await fetch(`${baseUrl}/api/documents`, {
        method: 'POST',
        headers: owner,
        body: JSON.stringify({ markdown: `# ${title}\n\nAlpha.\n` }),
      });
      return (await res.json()) as { uid: string; admin_invite: { token: string } };
    };
    const one = await upload('One');
    const two = await upload('Two');
    const ringRes = await fetch(`${baseUrl}/api/keyrings`, {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({
        docs: [one, two].map((d) => ({ doc_uid: d.uid, invite_token: d.admin_invite.token })),
      }),
    });
    const ring = ((await ringRes.json()) as { token: string }).token;
    const keyRes = await fetch(`${baseUrl}/api/keyrings/self/agents`, {
      method: 'POST',
      headers: { ...owner, 'x-marginalia-keyring': ring },
      body: JSON.stringify({ display_name: 'Codex', role: 'collaborator' }),
    });
    const { key } = (await keyRes.json()) as { key: string };

    // No `?name=`: the key carries it.
    const agent = await connect(`?key=${encodeURIComponent(key)}`);
    expect(await callText(agent, 'get_identity')).toContain('display name: Codex');
    const listed = await callText(agent, 'list_documents');
    expect(listed).toContain(one.uid);
    expect(listed).toContain(two.uid);
    expect(listed).not.toContain(one.admin_invite.token);

    expect(
      await callText(agent, 'get_document', { document: two.uid, include_source: false }),
    ).toContain('your role: collaborator');
    await callText(agent, 'create_comment', {
      document: two.uid,
      anchor_text: 'Alpha.',
      body: 'through the agent key',
    });
    const threads = await callText(agent, 'list_threads', { document: two.uid });
    expect(threads).toContain('Codex');

    const created = await callText(agent, 'create_document', { source: '# Fresh\n\nNew.\n' });
    const uid = /^uid: (\S+)$/m.exec(created)?.[1] as string;
    expect(created).toContain('added to the user’s keyring');
    expect(
      await callText(agent, 'get_document', { document: uid, include_source: false }),
    ).toContain('your role: collaborator');
    const pulled = await fetch(`${baseUrl}/api/keyrings/self`, {
      headers: { ...owner, 'x-marginalia-keyring': ring },
    });
    const docs = ((await pulled.json()) as { docs: Array<{ doc_uid: string; role: string }> }).docs;
    expect(docs.find((d) => d.doc_uid === uid)?.role).toBe('admin');

    // The owner deletes the agent's invite on `two`; the session's
    // remembered token dies with it, and the key mints a fresh one.
    const listing = await fetch(`${baseUrl}/api/documents/${two.uid}/invites`, {
      headers: { ...owner, 'x-marginalia-invite': two.admin_invite.token },
    });
    const agentInvite = (
      (await listing.json()) as { invites: Array<{ token: string; kind: string }> }
    ).invites.find((i) => i.kind === 'named');
    await fetch(`${baseUrl}/api/documents/${two.uid}/invites/${agentInvite?.token}`, {
      method: 'DELETE',
      headers: { ...owner, 'x-marginalia-invite': two.admin_invite.token },
    });
    await callText(agent, 'create_comment', {
      document: two.uid,
      anchor_text: 'Alpha.',
      body: 'after the invite was deleted',
    });
    await agent.close();
  });

  test('a document outside the keyring says why the agent key could not open it', async () => {
    const owner = {
      'content-type': 'application/json',
      'x-marginalia-client': 'owner-client-0001',
      'x-marginalia-client-name': 'Paul',
    };
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({ markdown: '# Elsewhere\n' }),
    });
    const outside = (await res.json()) as { uid: string };
    const ringRes = await fetch(`${baseUrl}/api/keyrings`, {
      method: 'POST',
      headers: owner,
      body: JSON.stringify({ docs: [] }),
    });
    const ring = ((await ringRes.json()) as { token: string }).token;
    const keyRes = await fetch(`${baseUrl}/api/keyrings/self/agents`, {
      method: 'POST',
      headers: { ...owner, 'x-marginalia-keyring': ring },
      body: JSON.stringify({}),
    });
    const { key } = (await keyRes.json()) as { key: string };

    const agent = await connect(`?key=${encodeURIComponent(key)}`);
    const failed = (await agent.callTool({
      name: 'get_document',
      arguments: { document: outside.uid },
    })) as { content: Array<{ text?: string }>; isError?: boolean };
    expect(failed.isError).toBe(true);
    expect(failed.content.map((c) => c.text).join('')).toContain('not in the user’s keyring');
    await agent.close();
  });

  const OWNER = {
    'content-type': 'application/json',
    'x-marginalia-client': 'owner-client-0001',
    'x-marginalia-client-name': 'Paul',
  };

  async function ownerDocInRing(role = 'collaborator'): Promise<{
    doc: { uid: string; admin_invite: { token: string } };
    key: string;
    ring: string;
  }> {
    const res = await fetch(`${baseUrl}/api/documents`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({ markdown: '# Ring\n\nAlpha.\n' }),
    });
    const doc = (await res.json()) as { uid: string; admin_invite: { token: string } };
    const ringRes = await fetch(`${baseUrl}/api/keyrings`, {
      method: 'POST',
      headers: OWNER,
      body: JSON.stringify({
        docs: [{ doc_uid: doc.uid, invite_token: doc.admin_invite.token }],
      }),
    });
    const ring = ((await ringRes.json()) as { token: string }).token;
    const keyRes = await fetch(`${baseUrl}/api/keyrings/self/agents`, {
      method: 'POST',
      headers: { ...OWNER, 'x-marginalia-keyring': ring },
      body: JSON.stringify({ display_name: 'Codex', role }),
    });
    return { doc, key: ((await keyRes.json()) as { key: string }).key, ring };
  }

  // A 1×1 PNG.
  const PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

  test('a collaborator agent creates a document with its images attached', async () => {
    const { key, ring } = await ownerDocInRing();
    const agent = await connect(`?key=${encodeURIComponent(key)}`);
    const created = await callText(agent, 'create_document', {
      source: '# Figures\n\n![chart](img/chart.png)\n\n![bad](../x.png)\n',
      images: [
        { name: 'img/chart.png', data_base64: `data:image/png;base64,${PIXEL}` },
        { name: '../x.png', data_base64: PIXEL },
      ],
    });
    const uid = /^uid: (\S+)$/m.exec(created)?.[1] as string;
    expect(created).toContain('img/chart.png: attached');
    expect(created).toContain('../x.png: not a usable name');
    expect(created).toContain('added to the user’s keyring');

    const doc = await callText(agent, 'get_document', { document: uid, include_source: false });
    expect(doc).toContain('your role: collaborator');
    const pulled = await fetch(`${baseUrl}/api/keyrings/self`, {
      headers: { ...OWNER, 'x-marginalia-keyring': ring },
    });
    const admin = (
      (await pulled.json()) as { docs: Array<{ doc_uid: string; invite_token: string }> }
    ).docs.find((d) => d.doc_uid === uid)?.invite_token as string;
    const asset = await fetch(`${baseUrl}/api/documents/${uid}/assets/img/chart.png`, {
      headers: { ...OWNER, 'x-marginalia-invite': admin },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await asset.arrayBuffer()).toString('base64')).toBe(PIXEL);
    await agent.close();
  });

  test('images reach a new password-protected document', async () => {
    const { key } = await ownerDocInRing();
    const agent = await connect(`?key=${encodeURIComponent(key)}`);
    const created = await callText(agent, 'create_document', {
      source: '# Locked\n\n![a](a.png)\n',
      password_protected: true,
      images: [{ name: 'a.png', data_base64: PIXEL }],
    });
    expect(created).toContain('a.png: attached');
    expect(created).toMatch(/password \(shown once, store it now\): \S+/);
    await agent.close();
  });

  test('says where images and references disagree, and skips a repeated name', async () => {
    const { key } = await ownerDocInRing();
    const agent = await connect(`?key=${encodeURIComponent(key)}`);
    const created = await callText(agent, 'create_document', {
      source: '# Figures\n\n![one](figure-1.png)\n\n![two](figure-2.png)\n',
      images: [
        { name: 'figure-1.png', data_base64: PIXEL },
        { name: 'figure-1.png', data_base64: PIXEL },
        { name: 'figure1.png', data_base64: PIXEL },
      ],
    });
    expect(created).toContain('figure-1.png: attached');
    expect(created).toContain('figure-1.png: skipped — the same name appears earlier');
    expect(created).toContain('figure-2.png: the source references it, but no image is attached');
    expect(created).toContain('figure1.png: attached, but the source does not reference it');
    expect(created).not.toContain('figure-1.png: attached, but');
    await agent.close();
  });

  test('names the HTML escapes still match their references', async () => {
    const { key } = await ownerDocInRing();
    const agent = await connect(`?key=${encodeURIComponent(key)}`);
    const created = await callText(agent, 'create_document', {
      source: '# R&D\n\n![chart](r&d.png)\n',
      images: [{ name: 'r&d.png', data_base64: PIXEL }],
    });
    expect(created).toContain('r&d.png: attached');
    expect(created).not.toContain('no image is attached');
    expect(created).not.toContain('does not reference it');
    await agent.close();
  });

  test('upload_image says when the source does not reference what it attached', async () => {
    const { doc, key } = await ownerDocInRing('editor');
    const agent = await connect(`?key=${encodeURIComponent(key)}`);
    const uploaded = await callText(agent, 'upload_image', {
      document: doc.uid,
      name: 'unused.png',
      data_base64: PIXEL,
    });
    expect(uploaded).toContain('unused.png: attached');
    expect(uploaded).toContain('unused.png: attached, but the source does not reference it');
    await agent.close();
  });

  test('a folder document gets its images with the agent’s access to the folder', async () => {
    const { doc, key } = await ownerDocInRing('editor');
    const agent = await connect(`?key=${encodeURIComponent(key)}`);
    const added = await callText(agent, 'create_document', {
      source: '# Notes\n\n![n](n.png)\n',
      name: 'NOTES',
      folder: doc.uid,
      images: [{ name: 'n.png', data_base64: PIXEL }],
    });
    expect(added).toContain('n.png: attached');
    expect(added).not.toContain('no image is attached');
    await agent.close();
  });

  test('upload_image needs editor: a collaborator is told why, an editor attaches', async () => {
    const collaborator = await ownerDocInRing();
    const asCollaborator = await connect(`?key=${encodeURIComponent(collaborator.key)}`);
    const refused = (await asCollaborator.callTool({
      name: 'upload_image',
      arguments: { document: collaborator.doc.uid, name: 'a.png', data_base64: PIXEL },
    })) as { content: Array<{ text?: string }>; isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(refused.content.map((c) => c.text).join('')).toContain('needs the editor or admin role');
    await asCollaborator.close();

    const editor = await ownerDocInRing('editor');
    const asEditor = await connect(`?key=${encodeURIComponent(editor.key)}`);
    expect(
      await callText(asEditor, 'upload_image', {
        document: editor.doc.uid,
        name: 'a.png',
        data_base64: PIXEL,
      }),
    ).toContain('a.png: attached');
    const asset = await fetch(`${baseUrl}/api/documents/${editor.doc.uid}/assets/a.png`, {
      headers: { ...OWNER, 'x-marginalia-invite': editor.doc.admin_invite.token },
    });
    expect(asset.status).toBe(200);
    expect(Buffer.from(await asset.arrayBuffer()).toString('base64')).toBe(PIXEL);
    await asEditor.close();
  });

  test('a link handed to a keyed agent is not swapped for its own invite on a refusal', async () => {
    const { doc, key } = await ownerDocInRing();
    const editorRes = await fetch(`${baseUrl}/api/documents/${doc.uid}/invites`, {
      method: 'POST',
      headers: { ...OWNER, 'x-marginalia-invite': doc.admin_invite.token },
      body: JSON.stringify({ kind: 'named', display_name: 'Codex', role: 'editor' }),
    });
    const editor = ((await editorRes.json()) as { invite: { token: string } }).invite.token;

    const agent = await connect(`?key=${encodeURIComponent(key)}`);
    expect(
      await callText(agent, 'get_document', {
        document: `${baseUrl}/d/${doc.uid}/${editor}`,
        include_source: false,
      }),
    ).toContain('your role: editor');
    const refused = (await agent.callTool({
      name: 'create_invite',
      arguments: { document: doc.uid, role: 'reader' },
    })) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(
      await callText(agent, 'get_document', { document: doc.uid, include_source: false }),
    ).toContain('your role: editor');
    await agent.close();
  });

  test('behind a trusted proxy, the public https origin is the one it knows', async () => {
    http.stop(true);
    await app.close();
    app = await createApp(
      loadConfig({ dataDir: dir, port: 0, webDir: join(dir, 'web'), trustedProxyHops: 1 }),
    );
    http = Bun.serve({ port: 0, fetch: app.hono.fetch, websocket: app.websocket });
    baseUrl = `http://localhost:${http.port}`;
    const { doc, key } = await ownerDocInRing();

    const agent = await connect(`?key=${encodeURIComponent(key)}`, {
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'marginalia.example',
    });
    const listed = await callText(agent, 'list_documents');
    expect(listed).toContain(`url: https://marginalia.example/d/${doc.uid}`);
    expect(
      await callText(agent, 'get_document', {
        document: `https://marginalia.example/d/${doc.uid}`,
        include_source: false,
      }),
    ).toContain('your role: collaborator');
    await agent.close();
  });

  test('a #comment- link selects that thread, opener or reply', async () => {
    const admin = await connect('?name=Paul');
    const created = await callText(admin, 'create_document', {
      source: '# Doc\n\nAlpha.\n\nBeta.\n',
    });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    const uid = /^uid: (\S+)$/m.exec(created)?.[1] as string;
    const token = new URL(adminUrl).pathname.split('/')[3] as string;

    const first = await callText(admin, 'create_comment', {
      document: adminUrl,
      anchor_text: 'Alpha.',
      body: 'the thread we want',
    });
    const threadId = /^thread_id: (\S+)/m.exec(first)?.[1] as string;
    const reply = await callText(admin, 'reply_to_thread', {
      document: adminUrl,
      thread_id: threadId,
      body: 'a reply inside it',
    });
    const replyId = /^comment_id: (\S+)/m.exec(reply)?.[1] as string;
    await callText(admin, 'create_comment', {
      document: adminUrl,
      anchor_text: 'Beta.',
      body: 'an unrelated thread',
    });

    // The copy-link button sits on replies too, so both shapes must work.
    for (const id of [threadId, replyId]) {
      const viaLink = await callText(admin, 'list_threads', {
        document: `${baseUrl}/d/${uid}/${token}#comment-${id}`,
      });
      expect(viaLink).toContain('the thread we want');
      expect(viaLink).not.toContain('an unrelated thread');
      expect(viaLink).toContain(`#comment-${id}`);
    }

    // A reply id passed outright resolves to its thread as well.
    const viaArg = await callText(admin, 'list_threads', {
      document: adminUrl,
      thread_id: replyId,
    });
    expect(viaArg).toContain('the thread we want');
    await admin.close();
  });

  test('remembers a document’s link for the rest of the session', async () => {
    const admin = await connect('?name=Paul');
    const created = await callText(admin, 'create_document', {
      source: '# Doc\n\nAlpha.\n',
      invite_only: false,
    });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    const uid = /^uid: (\S+)$/m.exec(created)?.[1] as string;
    const invite = await callText(admin, 'create_invite', {
      document: adminUrl,
      role: 'collaborator',
      display_name: 'Claude',
    });
    const link = /(http\S+)/.exec(invite)?.[1] as string;
    await admin.close();

    // An invite names one document, so an agent working across several
    // has to be handed each one's link. It should only need telling once.
    const agent = await connect('?name=Claude');
    const bare = `${baseUrl}/d/${uid}`;
    expect(
      await callText(agent, 'get_document', { document: bare, include_source: false }),
    ).toContain('your role: reader');
    await callText(agent, 'get_document', { document: link, include_source: false });
    expect(
      await callText(agent, 'get_document', { document: bare, include_source: false }),
    ).toContain('your role: collaborator');
    // The shape this exists for: a comment link, which carries no token.
    // Its fragment has to be a real id — an unrecognized one is ignored,
    // and asserting against that would prove nothing.
    const comment = await callText(agent, 'create_comment', {
      document: bare,
      anchor_text: 'Alpha.',
      body: 'written through a remembered token',
    });
    const threadId = /^thread_id: (\S+)/m.exec(comment)?.[1] as string;
    const viaCommentLink = await callText(agent, 'list_threads', {
      document: `${bare}#comment-${threadId}`,
    });
    expect(viaCommentLink).toContain(`#comment-${threadId}`);
    expect(viaCommentLink).toContain('written through a remembered token');
    await agent.close();
  });

  test('one session’s tokens are invisible to another', async () => {
    const admin = await connect('?name=Paul');
    const created = await callText(admin, 'create_document', {
      source: '# Doc\n\nAlpha.\n',
      invite_only: false,
    });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    const uid = /^uid: (\S+)$/m.exec(created)?.[1] as string;
    const invite = await callText(admin, 'create_invite', {
      document: adminUrl,
      role: 'collaborator',
      display_name: 'Claude',
    });
    const link = /(http\S+)/.exec(invite)?.[1] as string;

    // Two connections at once: the endpoint is shared, so what one is
    // told must not become the other's access.
    const first = await connect('?name=Claude');
    const second = await connect('?name=Claude');
    await callText(first, 'get_document', { document: link, include_source: false });

    expect(
      await callText(second, 'get_document', {
        document: `${baseUrl}/d/${uid}`,
        include_source: false,
      }),
    ).toContain('your role: reader');
    expect(
      await callText(first, 'get_document', {
        document: `${baseUrl}/d/${uid}`,
        include_source: false,
      }),
    ).toContain('your role: collaborator');

    await first.close();
    await second.close();
    await admin.close();
  });

  test('a request that never initializes leaves nothing behind', async () => {
    // `handleRequest` can reject, and an un-sessioned server has no id to
    // reach it by afterwards — so a burst of bad requests must not strand
    // one apiece. The endpoint staying responsive afterwards is the
    // observable part; the close happens in a finally.
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: 'not json at all',
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.headers.get('mcp-session-id')).toBeNull();
    }

    const client = await connect();
    expect((await client.listTools()).tools.length).toBeGreaterThan(20);
    await client.close();
  });

  test('a DELETE ends the session and its remembered tokens', async () => {
    // Driven by hand rather than through the SDK client, because the
    // point is what happens to the session id itself.
    const init = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const deleted = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId as string },
    });
    expect(deleted.status).toBeLessThan(500);

    // Gone: whatever it had been told is no longer reachable, and the
    // client is expected to initialize again.
    const after = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId as string,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(after.status).toBe(404);
  });

  test('an unknown session id is refused rather than silently starting a new one', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'a-session-that-does-not-exist',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(404);
  });

  test('refuses to reach a different Marginalia instance', async () => {
    const client = await connect();
    const res = (await client.callTool({
      name: 'get_document',
      arguments: { document: 'https://elsewhere.example/d/AAAAAAAAAAAAAAAAAAAAAA' },
    })) as { content: Array<{ text?: string }>; isError?: boolean };
    expect(res.isError).toBe(true);
    expect(res.content.map((c) => c.text).join('')).toContain('not in MARGINALIA_ALLOWED_HOSTS');
    await client.close();
  });
});

describe('publicUrl', () => {
  async function originFor(hops: number, headers: Record<string, string>): Promise<string> {
    const { Hono } = await import('hono');
    const app = new Hono().get('/mcp', (c) => c.text(publicUrl(c, hops).origin));
    return (await app.fetch(new Request('http://internal:8080/mcp', { headers }))).text();
  }

  test('takes the scheme and host the trusted proxy vouched for', async () => {
    const forwarded = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'marginalia.example' };
    expect(await originFor(1, forwarded)).toBe('https://marginalia.example');
    expect(await originFor(0, forwarded)).toBe('http://internal:8080');
  });

  test('ignores a chain shorter than the configured hops, which the caller could have written', async () => {
    expect(
      await originFor(2, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' }),
    ).toBe('http://internal:8080');
    expect(
      await originFor(2, {
        'x-forwarded-proto': 'https, http',
        'x-forwarded-host': 'marginalia.example, caddy.internal',
      }),
    ).toBe('https://marginalia.example');
  });
});
