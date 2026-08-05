import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { type App, createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

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

  async function connect(query = ''): Promise<Client> {
    const client = new Client({ name: 'test', version: '0' });
    // The SDK's client transport declares `sessionId?: string`, which the
    // repo's exactOptionalPropertyTypes rejects against `Transport`.
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp${query}`));
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
    const created = await callText(admin, 'create_document', { source: '# Doc\n\nAlpha.\n' });
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
