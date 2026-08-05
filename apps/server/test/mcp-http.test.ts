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
