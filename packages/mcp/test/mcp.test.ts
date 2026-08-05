import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '@marginalia/server/src/app.js';
import { loadConfig } from '@marginalia/server/src/config.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpConfig } from '../src/config.js';
import { createMarginaliaMcpServer } from '../src/main.js';

/**
 * End-to-end: a real Marginalia server over real HTTP, driven through
 * the real MCP protocol. Nothing here stubs the API, so a change to the
 * server's wire format shows up as a failing tool call rather than a
 * silently wrong tool.
 */

const BOOK = `# The Salt Road

## Chapter One

The caravan left before dawn, when the sand was still cold enough to walk on.
Ibrahim counted the camels twice and found the same number both times.

## Chapter Two

By noon the dunes had swallowed the horizon. Ibrahim counted the camels twice
and found the same number both times.

- Water rations: four days
- Distance to the well: unknown

## Chapter Three

They reached the well on the fourth evening, which Ibrahim considered luck.
`;

/** A human reviewer, talking to the server directly rather than through MCP. */
const REVIEWER = { clientId: 'reviewer-client-id-0001', displayName: 'Paul' };

describe('marginalia MCP server', () => {
  let dataDir: string;
  let stateDir: string;
  let downloadDir: string;
  let app: App;
  let httpServer: ReturnType<typeof Bun.serve>;
  let baseUrl: string;
  let client: Client;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'mcp-data-'));
    stateDir = mkdtempSync(join(tmpdir(), 'mcp-state-'));
    downloadDir = mkdtempSync(join(tmpdir(), 'mcp-dl-'));
    app = await createApp(loadConfig({ dataDir, port: 0, webDir: join(dataDir, 'web') }));
    httpServer = Bun.serve({ port: 0, fetch: app.hono.fetch, websocket: app.websocket });
    baseUrl = `http://localhost:${httpServer.port}`;

    const config: McpConfig = {
      baseUrl,
      displayName: 'Claude',
      clientId: 'claude-mcp-test-client-id',
      allowedHosts: [],
      password: null,
      defaultToken: null,
      stateDir,
      downloadDir,
    };
    const { server } = createMarginaliaMcpServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-harness', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    httpServer.stop(true);
    await app.close();
    for (const dir of [dataDir, stateDir, downloadDir]) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function call(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const body = result.content
      .map((part) => part.text ?? '')
      .join('\n')
      .trim();
    if (result.isError) throw new Error(`tool ${name} failed: ${body}`);
    return body;
  }

  async function callExpectingError(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<string> {
    const result = (await client.callTool({ name, arguments: args })) as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    expect(result.isError).toBe(true);
    return result.content.map((part) => part.text ?? '').join('\n');
  }

  /** Upload a book and return the admin link the tools take as `document`. */
  async function seedBook(source = BOOK): Promise<{ adminUrl: string; uid: string }> {
    const output = await call('create_document', { source, name: 'The Salt Road' });
    const uid = /^uid: (\S+)$/m.exec(output)?.[1];
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(output)?.[1];
    expect(uid).toBeTruthy();
    expect(adminUrl).toBeTruthy();
    return { adminUrl: adminUrl as string, uid: uid as string };
  }

  /** Post a comment as the human reviewer, straight against the HTTP API. */
  async function reviewerComments(
    uid: string,
    token: string,
    blockId: string,
    quote: string,
    body: string,
    endBlockId?: string,
  ): Promise<string> {
    const res = await fetch(`${baseUrl}/api/documents/${uid}/threads`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-marginalia-client': REVIEWER.clientId,
        'x-marginalia-client-name': REVIEWER.displayName,
        'x-marginalia-invite': token,
      },
      body: JSON.stringify({
        anchor: { block_id: blockId, quote, ...(endBlockId ? { end_block_id: endBlockId } : {}) },
        body,
      }),
    });
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { thread: { id: string } };
    return payload.thread.id;
  }

  /** Reply as the human reviewer, straight against the HTTP API. */
  async function reviewerReplies(
    uid: string,
    token: string,
    threadId: string,
    body: string,
  ): Promise<void> {
    const res = await fetch(`${baseUrl}/api/documents/${uid}/threads/${threadId}/respond`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-marginalia-client': REVIEWER.clientId,
        'x-marginalia-client-name': REVIEWER.displayName,
        'x-marginalia-invite': token,
      },
      body: JSON.stringify({ body }),
    });
    expect(res.status).toBe(200);
  }

  test('advertises every tool with a description', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'authenticate',
        'create_comment',
        'create_document',
        'create_invite',
        'create_proposal',
        'delete_thread',
        'edit_comment',
        'edit_document',
        'export_document',
        'get_document',
        'get_identity',
        'get_proposal_diff',
        'get_rendered_html',
        'get_version_diff',
        'list_blocks',
        'list_history',
        'list_invites',
        'list_threads',
        'react_to_comment',
        'reply_to_thread',
        'repair_proposal_anchor',
        'respond_to_thread',
        'update_document',
        'update_proposal',
      ].sort(),
    );
    for (const tool of tools) {
      expect(tool.description ?? '').not.toBe('');
    }
  });

  test('names the path when an upload source file cannot be read', async () => {
    const message = await callExpectingError('create_document', {
      source_path: join(downloadDir, 'no-such-book.md'),
    });
    expect(message).toContain('Could not read');
    expect(message).toContain('no-such-book.md');
    // A typo'd path is a recoverable user error, not a stack trace.
    expect(message).not.toContain('Unexpected failure');
  });

  test('reports the identity comments will be signed with', async () => {
    const output = await call('get_identity');
    expect(output).toContain('display name: Claude');
    expect(output).toContain(baseUrl);
  });

  test('reads a document with its outline and source', async () => {
    const { adminUrl } = await seedBook();
    const output = await call('get_document', { document: adminUrl });
    expect(output).toContain('The Salt Road');
    expect(output).toContain('your role: admin');
    expect(output).toContain('- Chapter One');
    expect(output).toContain('The caravan left before dawn');
  });

  test('gives an outline with per-section sizes without any source', async () => {
    const { adminUrl } = await seedBook();
    const output = await call('get_document', { document: adminUrl, include_source: false });
    expect(output).toContain('source omitted');
    expect(output).not.toContain('The caravan left before dawn');
    // Every section addressable, with enough detail to choose one.
    expect(output).toContain('- Chapter Two');
    expect(output).toContain('#chapter-two');
    expect(output).toMatch(/lines \d+-\d+, \d+ chars, \d+ lines/);
  });

  test('returns one section instead of the whole document', async () => {
    const { adminUrl } = await seedBook();
    const output = await call('get_document', { document: adminUrl, section: 'Chapter Two' });

    expect(output).toContain('section: The Salt Road › Chapter Two');
    expect(output).toContain('By noon the dunes had swallowed the horizon');
    expect(output).toContain('Water rations: four days');
    // Neither neighbour leaks in, and the outline isn't repeated.
    expect(output).not.toContain('The caravan left before dawn');
    expect(output).not.toContain('They reached the well');
    expect(output).not.toContain('outline:');
  });

  test('addresses a section by slug or by path, and a parent pulls its children', async () => {
    const { adminUrl } = await seedBook();
    const bySlug = await call('get_document', { document: adminUrl, section: '#chapter-three' });
    expect(bySlug).toContain('They reached the well');
    expect(bySlug).not.toContain('By noon the dunes');

    const byPath = await call('get_document', {
      document: adminUrl,
      section: 'The Salt Road > Chapter One',
    });
    expect(byPath).toContain('The caravan left before dawn');
    expect(byPath).not.toContain('By noon the dunes');

    // The top-level heading's section is the whole book.
    const whole = await call('get_document', { document: adminUrl, section: 'The Salt Road' });
    expect(whole).toContain('The caravan left before dawn');
    expect(whole).toContain('They reached the well');
  });

  test('flags text that sits before the first heading', async () => {
    const { adminUrl } = await seedBook('A note to the reader.\n\n# Title\n\nBody.\n');
    const output = await call('get_document', { document: adminUrl, include_source: false });
    expect(output).toContain('outside every section');
  });

  test('lists the available sections when the name does not match', async () => {
    const { adminUrl } = await seedBook();
    const message = await callExpectingError('get_document', {
      document: adminUrl,
      section: 'Chapter Nine',
    });
    expect(message).toContain('No section matches');
    expect(message).toContain('Chapter One');
    expect(message).toContain('Chapter Three');
  });

  test('refuses an ambiguous section rather than picking one', async () => {
    const { adminUrl } = await seedBook();
    const message = await callExpectingError('get_document', {
      document: adminUrl,
      section: 'Chapter',
    });
    expect(message).toContain('3 sections match');
  });

  test('narrows blocks and threads to a single section', async () => {
    const { adminUrl } = await seedBook();
    const blocks = await call('list_blocks', { document: adminUrl, section: 'Chapter Three' });
    expect(blocks).toContain('They reached the well');
    expect(blocks).not.toContain('By noon the dunes');

    await call('create_comment', {
      document: adminUrl,
      anchor_text: 'The caravan left before dawn',
      body: 'Comment in chapter one.',
    });
    await call('create_comment', {
      document: adminUrl,
      anchor_text: 'They reached the well',
      body: 'Comment in chapter three.',
    });

    const inThree = await call('list_threads', { document: adminUrl, section: 'Chapter Three' });
    expect(inThree).toContain('section: The Salt Road › Chapter Three');
    expect(inThree).toContain('Comment in chapter three.');
    expect(inThree).not.toContain('Comment in chapter one.');

    const inOne = await call('list_threads', { document: adminUrl, section: 'Chapter One' });
    expect(inOne).toContain('Comment in chapter one.');
    expect(inOne).not.toContain('Comment in chapter three.');
  });

  test('lists blocks with ids, line ranges and verbatim source', async () => {
    const { adminUrl } = await seedBook();
    const output = await call('list_blocks', { document: adminUrl, query: 'caravan' });
    expect(output).toMatch(/block_id=[0-9a-f]{16}/);
    expect(output).toContain('kind: paragraph');
    expect(output).toContain('section: The Salt Road › Chapter One');
    expect(output).toContain('| The caravan left before dawn');
  });

  test('remembers a document so a bare uid works afterwards', async () => {
    const { adminUrl, uid } = await seedBook();
    await call('get_document', { document: adminUrl });
    const output = await call('get_document', { document: uid, include_source: false });
    // The stored token is what keeps the role at admin rather than reader.
    expect(output).toContain('your role: admin');
  });

  test('anchors a comment to the block a snippet appears in', async () => {
    const { adminUrl } = await seedBook();
    const output = await call('create_comment', {
      document: adminUrl,
      anchor_text: 'Water rations: four days',
      body: 'How is this reconciled with the unknown distance?',
    });
    expect(output).toContain('Commented as "Claude"');

    const threads = await call('list_threads', { document: adminUrl });
    expect(threads).toContain('COMMENT THREAD 1/1 — open');
    expect(threads).toContain('How is this reconciled');
    expect(threads).toContain('Water rations');
  });

  test('reads the paragraphs around a thread when context is asked for', async () => {
    const { adminUrl } = await seedBook();
    await call('create_comment', {
      document: adminUrl,
      anchor_text: 'Water rations: four days',
      body: 'How is this reconciled with the unknown distance?',
    });

    const bare = await call('list_threads', { document: adminUrl });
    expect(bare).not.toContain('By noon the dunes');

    const withContext = await call('list_threads', { document: adminUrl, context_blocks: 1 });
    expect(withContext).toContain('source before the anchor (1 block)');
    expect(withContext).toContain('By noon the dunes had swallowed the horizon');
    expect(withContext).toContain('source after the anchor (1 block)');
    expect(withContext).toContain('## Chapter Three');
    // The list enclosing the anchored bullet overlaps it, so context is
    // what reads around the list — the sibling bullet is not surroundings.
    expect(withContext).not.toContain('Distance to the well');
  });

  test('shows every block a comment spans, not only the first', async () => {
    const { adminUrl, uid } = await seedBook();
    const invite = await call('create_invite', {
      document: adminUrl,
      role: 'collaborator',
      display_name: REVIEWER.displayName,
    });
    const token = new URL(/(http\S+)/.exec(invite)?.[1] as string).pathname.split('/')[3] as string;

    // A bullet's text matches the enclosing list too, and that entry comes
    // first — so ask for the item itself rather than the first id present.
    const idOf = async (query: string): Promise<string> => {
      const listed = await call('list_blocks', { document: adminUrl, query });
      const id = /block_id=([0-9a-f]{16})\n\s+kind: listItem\b/.exec(listed)?.[1];
      expect(id).toBeTruthy();
      return id as string;
    };

    // What the viewer writes when a selection covers two blocks: the
    // endpoints' ids, and one quote holding both fragments.
    await reviewerComments(
      uid,
      token,
      await idOf('Water rations: four days'),
      'Water rations: four days\n\nDistance to the well: unknown',
      'Both of these need a source.',
      await idOf('Distance to the well: unknown'),
    );

    const threads = await call('list_threads', { document: adminUrl });
    expect(threads).toContain('end_block_id=');
    expect(threads).toContain('listItem…listItem span');
    expect(threads).toContain('current source of the anchored blocks:');
    expect(threads).toContain('- Water rations: four days');
    expect(threads).toContain('- Distance to the well: unknown');
  });

  test('refuses an ambiguous anchor rather than guessing a block', async () => {
    const { adminUrl } = await seedBook();
    const message = await callExpectingError('create_comment', {
      document: adminUrl,
      anchor_text: 'counted the camels twice',
      body: 'Repetition.',
    });
    expect(message).toContain('ambiguous');
    expect(message).toMatch(/block_id/);
  });

  test('reports shareable comment links without the invite token', async () => {
    const { adminUrl, uid } = await seedBook();
    const adminToken = new URL(adminUrl).pathname.split('/')[3] as string;

    const created = await call('create_comment', {
      document: adminUrl,
      anchor_text: 'They reached the well',
      body: 'Lovely ending.',
    });
    const threadId = /^thread_id: (\S+)/m.exec(created)?.[1] as string;
    // The link a person can click. Never with the token: opening
    // /d/<uid>/<token> claims that invite for whoever clicks it.
    expect(created).toContain(`url: ${baseUrl}/d/${uid}#comment-${threadId}`);
    expect(created).not.toContain(adminToken);

    const listed = await call('list_threads', { document: adminUrl });
    expect(listed).toContain(`url: ${baseUrl}/d/${uid}#comment-${threadId}`);
    expect(listed).not.toContain(adminToken);
  });

  test('the work queue tracks who spoke last, not who has spoken', async () => {
    const { adminUrl, uid } = await seedBook();
    const invite = await call('create_invite', {
      document: adminUrl,
      role: 'collaborator',
      display_name: REVIEWER.displayName,
    });
    const token = new URL(/(http\S+)/.exec(invite)?.[1] as string).pathname.split('/')[3] as string;

    // Our own unanswered comment: nobody is waiting on us.
    const mine = await call('create_comment', {
      document: adminUrl,
      anchor_text: 'They reached the well',
      body: 'Is this ending intentional?',
    });
    const myThread = /^thread_id: (\S+)/m.exec(mine)?.[1] as string;
    expect(
      await call('list_threads', { document: adminUrl, awaiting_my_response: true }),
    ).toContain('No threads matched.');

    // Once the reviewer answers it, it is ours to deal with again.
    await reviewerReplies(uid, token, myThread, 'Yes — leave it.');
    const answered = await call('list_threads', {
      document: adminUrl,
      awaiting_my_response: true,
    });
    expect(answered).toContain(myThread);

    // We reply; the queue clears.
    await call('reply_to_thread', {
      document: adminUrl,
      thread_id: myThread,
      body: 'Understood, leaving it.',
    });
    expect(
      await call('list_threads', { document: adminUrl, awaiting_my_response: true }),
    ).toContain('No threads matched.');

    // The reviewer comes back after our reply — back on the queue, which a
    // "have I posted in this thread at all" test would have missed.
    await reviewerReplies(uid, token, myThread, 'Actually, one more thought.');
    expect(
      await call('list_threads', { document: adminUrl, awaiting_my_response: true }),
    ).toContain(myThread);
  });

  test('works through a reviewer comment into an accepted proposal', async () => {
    const { adminUrl, uid } = await seedBook();
    const invite = await call('create_invite', {
      document: adminUrl,
      role: 'collaborator',
      display_name: REVIEWER.displayName,
    });
    const token = new URL(/(http\S+)/.exec(invite)?.[1] as string).pathname.split('/')[3] as string;

    const blocks = await call('list_blocks', { document: adminUrl, query: 'By noon the dunes' });
    const blockId = /block_id=([0-9a-f#]+)/.exec(blocks)?.[1] as string;
    const threadId = await reviewerComments(
      uid,
      token,
      blockId,
      'counted the camels twice',
      'This repeats chapter one word for word. Please vary it.',
    );

    // The queue a reviewer's comments form.
    const queue = await call('list_threads', {
      document: adminUrl,
      awaiting_my_response: true,
    });
    expect(queue).toContain(threadId);
    expect(queue).toContain('Paul');
    expect(queue).toContain('current source of the anchored block');

    const proposed =
      'By noon the dunes had swallowed the horizon. Ibrahim stopped counting; the desert\nhad already made the tally meaningless.';
    const created = await call('create_proposal', {
      document: adminUrl,
      block_id: blockId,
      proposed_text: proposed,
      rationale: 'Varies the repeated line, as Paul asked.',
      answers_thread_id: threadId,
    });
    expect(created).toContain('Created an edit proposal');
    expect(created).toContain(`Linked to thread ${threadId}`);
    expect(created).toContain('Replied there too');
    const proposalId = /^thread_id: (\S+)/m.exec(created)?.[1] as string;

    // The reviewer's thread now carries our reply, so it drops out of the queue.
    const requeued = await call('list_threads', {
      document: adminUrl,
      awaiting_my_response: true,
    });
    expect(requeued).not.toContain(threadId);

    const diff = await call('get_proposal_diff', { document: adminUrl, thread_id: proposalId });
    expect(diff).toContain('applies cleanly: clean');
    expect(diff).toContain(
      '+By noon the dunes had swallowed the horizon. Ibrahim stopped counting',
    );

    const accepted = await call('respond_to_thread', {
      document: adminUrl,
      thread_id: proposalId,
      action: 'accept',
      body: 'Applied.',
    });
    expect(accepted).toContain('accept → now accepted');

    const after = await call('get_document', { document: adminUrl });
    expect(after).toContain('the desert');
    expect(after).not.toContain('By noon the dunes had swallowed the horizon. Ibrahim counted');

    // Accepting carried out what the comment asked for, so the comment
    // closed with it — no second call needed.
    expect(accepted).toContain(`Also resolved comment thread ${threadId}`);

    const open = await call('list_threads', { document: adminUrl, state: 'open' });
    expect(open).toContain('No threads matched.');
  });

  test('replies to an edit proposal without deciding it', async () => {
    const { adminUrl } = await seedBook();
    const created = await call('create_proposal', {
      document: adminUrl,
      anchor_text: 'Water rations: four days',
      proposed_text: '- Water rations: six days',
      rationale: 'Four days looks too tight for an unknown distance.',
    });
    const proposalId = /^thread_id: (\S+)/m.exec(created)?.[1] as string;

    const reply = await call('reply_to_thread', {
      document: adminUrl,
      thread_id: proposalId,
      body: 'Happy to change it back if the map says otherwise.',
    });
    expect(reply).toContain('Replied as "Claude"');
    expect(reply).toContain('now open');

    const threads = await call('list_threads', { document: adminUrl, kind: 'proposals' });
    expect(threads).toContain('EDIT PROPOSAL 1/1 — open');
    expect(threads).toContain('[reply 1] Claude');
    expect(threads).toContain('Happy to change it back');
  });

  test('rejects a proposal with a reason', async () => {
    const { adminUrl } = await seedBook();
    const created = await call('create_proposal', {
      document: adminUrl,
      anchor_text: 'Distance to the well: unknown',
      proposed_text: '- Distance to the well: 40km',
      rationale: 'Concrete numbers read better.',
    });
    const proposalId = /^thread_id: (\S+)/m.exec(created)?.[1] as string;
    const out = await call('respond_to_thread', {
      document: adminUrl,
      thread_id: proposalId,
      action: 'reject',
      body: 'The vagueness is deliberate.',
    });
    expect(out).toContain('reject → now rejected');
  });

  test('revises a proposal in place and the accept applies the new text', async () => {
    const { adminUrl } = await seedBook();
    const created = await call('create_proposal', {
      document: adminUrl,
      anchor_text: 'Water rations: four days',
      proposed_text: '- Water rations: six days',
      rationale: 'Four days looks too tight for an unknown distance.',
    });
    const proposalId = /^thread_id: (\S+)/m.exec(created)?.[1] as string;

    // Feedback arrives: six is too generous. Same thread, new text.
    const updated = await call('update_proposal', {
      document: adminUrl,
      thread_id: proposalId,
      proposed_text: '- Water rations: five days',
      rationale: 'Five days — six exceeds what the camels can carry.',
    });
    expect(updated).toContain(`Updated proposal ${proposalId}`);
    expect(updated).toContain('Rationale updated too.');
    expect(updated).toContain('-- Water rations: four days');
    expect(updated).toContain('+- Water rations: five days');

    // Still one thread, carrying the new rationale and the update capability.
    const threads = await call('list_threads', { document: adminUrl, kind: 'proposals' });
    expect(threads).toContain('EDIT PROPOSAL 1/1 — open');
    expect(threads).toContain('six exceeds what the camels can carry');
    expect(threads).not.toContain('too tight for an unknown distance');
    expect(threads).toMatch(/you can: .*update/);

    const diff = await call('get_proposal_diff', { document: adminUrl, thread_id: proposalId });
    expect(diff).toContain('applies cleanly: clean');
    expect(diff).toContain('+- Water rations: five days');

    const accepted = await call('respond_to_thread', {
      document: adminUrl,
      thread_id: proposalId,
      action: 'accept',
    });
    expect(accepted).toContain('accept → now accepted');
    const after = await call('get_document', { document: adminUrl });
    expect(after).toContain('Water rations: five days');
  });

  test('update_proposal refreshes a proposal the document moved away from', async () => {
    const { adminUrl } = await seedBook();
    const created = await call('create_proposal', {
      document: adminUrl,
      anchor_text: 'Distance to the well: unknown',
      proposed_text: '- Distance to the well: 40km',
      rationale: 'Concrete numbers read better.',
    });
    const proposalId = /^thread_id: (\S+)/m.exec(created)?.[1] as string;

    // The document changes elsewhere while the proposal sits open.
    await call('edit_document', {
      document: adminUrl,
      edits: [{ find: 'They reached the well', replace: 'They finally reached the well' }],
    });

    const updated = await call('update_proposal', {
      document: adminUrl,
      thread_id: proposalId,
      proposed_text: '- Distance to the well: 40km, by the old map',
    });
    expect(updated).toContain('+- Distance to the well: 40km, by the old map');

    const diff = await call('get_proposal_diff', { document: adminUrl, thread_id: proposalId });
    expect(diff).toContain('applies cleanly: clean');

    const accepted = await call('respond_to_thread', {
      document: adminUrl,
      thread_id: proposalId,
      action: 'accept',
    });
    expect(accepted).toContain('accept → now accepted');
    const after = await call('get_document', { document: adminUrl });
    expect(after).toContain('Distance to the well: 40km, by the old map');
    expect(after).toContain('They finally reached the well');
  });

  test('diffs a multi-block span against the whole span, not just its first block', async () => {
    const { adminUrl } = await seedBook();
    const listing = await call('list_blocks', { document: adminUrl });
    const items = [...listing.matchAll(/block_id=(\S+)\n\s+kind: (\w+)/g)]
      .filter(([, , kind]) => kind === 'listItem')
      .map(([, id]) => id as string);
    const [startId, endId] = items;
    expect(items).toHaveLength(2);

    // proposed_text is verbatim the FIRST block, so a diff taken against
    // that block alone reports no change — while accepting would drop the
    // second list item.
    const created = await call('create_proposal', {
      document: adminUrl,
      block_id: startId,
      end_block_id: endId,
      proposed_text: '- Water rations: four days',
      rationale: 'Drops the unknown distance, which we never resolve.',
    });

    expect(created).not.toContain('(no textual difference)');
    expect(created).toContain('-- Distance to the well: unknown');

    // The diff the tool reported is the change the server will apply.
    const proposalId = /^thread_id: (\S+)/m.exec(created)?.[1] as string;
    const stored = await call('get_proposal_diff', { document: adminUrl, thread_id: proposalId });
    expect(stored).toContain('-- Distance to the well: unknown');
  });

  test('creates a whole-document proposal', async () => {
    const { adminUrl } = await seedBook();
    const created = await call('create_proposal', {
      document: adminUrl,
      whole_document: true,
      proposed_text: '# The Salt Road\n\nA much shorter book.\n',
      rationale: 'Radical trim for discussion.',
    });
    expect(created).toContain('whole-document edit proposal');

    const threads = await call('list_threads', { document: adminUrl, kind: 'proposals' });
    expect(threads).toContain('replaces the WHOLE document on accept');
  });

  test('reacts to an edit proposal and to a reply, and toggles back off', async () => {
    const { adminUrl, uid } = await seedBook();
    const invite = await call('create_invite', {
      document: adminUrl,
      role: 'collaborator',
      display_name: REVIEWER.displayName,
    });
    const token = new URL(/(http\S+)/.exec(invite)?.[1] as string).pathname.split('/')[3] as string;

    const created = await call('create_proposal', {
      document: adminUrl,
      anchor_text: 'Distance to the well: unknown',
      proposed_text: '- Distance to the well: nobody agreed on a number',
      rationale: 'Makes the uncertainty explicit.',
    });
    const proposalId = /^thread_id: (\S+)/m.exec(created)?.[1] as string;

    // The reviewer replies, so there is a message that is not the opener.
    const replyRes = await fetch(`${baseUrl}/api/documents/${uid}/threads/${proposalId}/respond`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-marginalia-client': REVIEWER.clientId,
        'x-marginalia-client-name': REVIEWER.displayName,
        'x-marginalia-invite': token,
      },
      body: JSON.stringify({ body: 'Good — that reads better.' }),
    });
    expect(replyRes.status).toBe(200);
    const replyId = ((await replyRes.json()) as { created_reply_id: string }).created_reply_id;

    // React to the proposal itself (opener id == thread id) …
    const onProposal = await call('react_to_comment', {
      document: adminUrl,
      thread_id: proposalId,
      comment_id: proposalId,
      emoji: '📝',
    });
    expect(onProposal).toContain('📝×1');

    // … and to somebody else's reply inside it.
    const onReply = await call('react_to_comment', {
      document: adminUrl,
      thread_id: proposalId,
      comment_id: replyId,
      emoji: '🎉',
    });
    expect(onReply).toContain('🎉×1');

    const threads = await call('list_threads', { document: adminUrl, kind: 'proposals' });
    expect(threads).toContain('📝×1');
    expect(threads).toContain('🎉×1');

    // Same emoji again removes it.
    const toggled = await call('react_to_comment', {
      document: adminUrl,
      thread_id: proposalId,
      comment_id: proposalId,
      emoji: '📝',
    });
    expect(toggled).toContain('none');
  });

  test('edits and deletes its own comments', async () => {
    const { adminUrl } = await seedBook();
    const created = await call('create_comment', {
      document: adminUrl,
      anchor_text: 'The caravan left before dawn',
      body: 'Typo here.',
    });
    const threadId = /^thread_id: (\S+)/m.exec(created)?.[1] as string;

    await call('edit_comment', {
      document: adminUrl,
      thread_id: threadId,
      comment_id: threadId,
      body: 'Actually this reads well.',
    });
    expect(await call('list_threads', { document: adminUrl })).toContain(
      'Actually this reads well',
    );

    await call('react_to_comment', {
      document: adminUrl,
      thread_id: threadId,
      comment_id: threadId,
      emoji: '👍',
    });
    expect(await call('list_threads', { document: adminUrl })).toContain('👍×1');

    await call('delete_thread', { document: adminUrl, thread_id: threadId });
    expect(await call('list_threads', { document: adminUrl })).toContain('No threads matched.');
  });

  test('applies direct edits and records them in history', async () => {
    const { adminUrl } = await seedBook();
    const dry = await call('edit_document', {
      document: adminUrl,
      edits: [{ find: 'four days', replace: 'five days' }],
      dry_run: true,
    });
    expect(dry).toContain('Dry run');
    expect(await call('get_document', { document: adminUrl })).toContain('four days');

    const applied = await call('edit_document', {
      document: adminUrl,
      edits: [{ find: 'four days', replace: 'five days' }],
      commit_message: 'Stretch the rations',
    });
    expect(applied).toContain('Saved 1 edit(s)');
    expect(await call('get_document', { document: adminUrl })).toContain('five days');

    const history = await call('list_history', { document: adminUrl });
    expect(history.split('\n').length).toBeGreaterThan(1);
    const oid = /^(\S+)\s+\d{4}-/m.exec(history)?.[1] as string;
    expect(await call('get_version_diff', { document: adminUrl, oid })).toContain('five days');
  });

  test('refuses an edit whose search text is not unique', async () => {
    const { adminUrl } = await seedBook();
    const message = await callExpectingError('edit_document', {
      document: adminUrl,
      edits: [{ find: 'counted the camels twice', replace: 'lost count' }],
    });
    expect(message).toContain('occurs 2 times');
  });

  test('downloads the document in several formats', async () => {
    const { adminUrl } = await seedBook();
    await call('create_comment', {
      document: adminUrl,
      anchor_text: 'Water rations: four days',
      body: 'Check this against the map.',
    });

    const output = await call('export_document', {
      document: adminUrl,
      formats: ['source', 'bundle'],
      output_dir: downloadDir,
      basename: 'salt-road',
    });
    expect(output).toContain('Wrote:');

    const files = await readdir(downloadDir);
    expect(files).toContain('salt-road.md');
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);

    const bundleName = files.find((f) => f.endsWith('.json')) as string;
    const bundle = (await Bun.file(join(downloadDir, bundleName)).json()) as {
      kind: string;
      comments: unknown[];
    };
    expect(bundle.kind).toBe('marginalia.document-bundle');
    expect(bundle.comments.length).toBe(1);
  });

  test('exports a Word document carrying the open review threads', async () => {
    const { adminUrl } = await seedBook();
    await call('create_comment', {
      document: adminUrl,
      anchor_text: 'The caravan left before dawn',
      body: 'Nice opening.',
    });

    await call('export_document', {
      document: adminUrl,
      formats: ['docx'],
      output_dir: downloadDir,
      basename: 'salt-road',
      with_review_comments: true,
    });
    const bytes = await Bun.file(join(downloadDir, 'salt-road.docx')).bytes();
    // DOCX is a zip; "PK" is enough to prove it isn't a JSON error body.
    expect(bytes.length).toBeGreaterThan(1000);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });

  test('keeps a download inside the output directory', async () => {
    const { adminUrl } = await seedBook();
    const escapeDir = join(downloadDir, 'nested');

    await call('export_document', {
      document: adminUrl,
      formats: ['source'],
      output_dir: escapeDir,
      basename: '../../escaped',
    });

    // The traversal is flattened into a single filename, not followed:
    // one file lands in the requested directory and nothing escapes it.
    const written = await readdir(escapeDir);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^[^/\\.].*escaped\.md$/);
    expect(await readdir(downloadDir)).toEqual(['nested']);
  });

  test('refuses to link a proposal to a thread that does not exist', async () => {
    const { adminUrl } = await seedBook();
    // The link is validated server-side before the proposal is created,
    // so a bad id fails outright rather than leaving an unlinked orphan.
    const message = await callExpectingError('create_proposal', {
      document: adminUrl,
      anchor_text: 'Distance to the well: unknown',
      proposed_text: '- Distance to the well: four days out, they guessed',
      rationale: 'Concrete enough to argue with.',
      answers_thread_id: 'no-such-thread-id',
    });
    expect(message).toContain('answers-thread-not-found');

    const threads = await call('list_threads', { document: adminUrl, kind: 'proposals' });
    expect(threads).toContain('No threads matched.');
  });

  test('tracks which comments still have no proposal', async () => {
    const { adminUrl } = await seedBook();
    const first = await call('create_comment', {
      document: adminUrl,
      anchor_text: 'The caravan left before dawn',
      body: 'Tighten this opening.',
    });
    const firstId = /^thread_id: (\S+)/m.exec(first)?.[1] as string;
    await call('create_comment', {
      document: adminUrl,
      anchor_text: 'They reached the well',
      body: 'And this ending.',
    });

    const backlog = await call('list_threads', { document: adminUrl, needs_proposal: true });
    expect(backlog).toContain('Tighten this opening.');
    expect(backlog).toContain('And this ending.');

    await call('create_proposal', {
      document: adminUrl,
      anchor_text: 'The caravan left before dawn',
      proposed_text: 'The caravan left before dawn.',
      rationale: 'Tightened.',
      answers_thread_id: firstId,
    });

    // Answered by a proposal, so it drops off the backlog — even though
    // no one has replied in words.
    const after = await call('list_threads', { document: adminUrl, needs_proposal: true });
    expect(after).not.toContain('Tighten this opening.');
    expect(after).toContain('And this ending.');

    // Both ends of the link are visible when listing everything.
    const all = await call('list_threads', { document: adminUrl });
    expect(all).toContain(`answers comment thread: ${firstId}`);
    expect(all).toContain('answered by proposal(s):');
  });

  test('exports the source with open proposals folded in, without saving them', async () => {
    const { adminUrl } = await seedBook();
    await call('create_proposal', {
      document: adminUrl,
      anchor_text: 'Water rations: four days',
      proposed_text: '- Water rations: six days',
      rationale: 'Trial balloon.',
    });

    await call('export_document', {
      document: adminUrl,
      formats: ['source'],
      output_dir: downloadDir,
      basename: 'preview',
      with_open_proposals_applied: true,
    });
    const files = await readdir(downloadDir);
    const name = files.find((f) => f.startsWith('preview')) as string;
    expect(await Bun.file(join(downloadDir, name)).text()).toContain('six days');
    // The stored document is untouched.
    expect(await call('get_document', { document: adminUrl })).toContain('four days');
  });

  test('mints a reviewer link that cannot accept proposals', async () => {
    const { adminUrl } = await seedBook();
    const invite = await call('create_invite', {
      document: adminUrl,
      role: 'collaborator',
      display_name: 'Reviewer',
    });
    const link = /(http\S+)/.exec(invite)?.[1] as string;
    expect(link).toContain('/d/');

    const created = await call('create_proposal', {
      document: link,
      anchor_text: 'Distance to the well: unknown',
      proposed_text: '- Distance to the well: three days on foot',
      rationale: 'Suggested by the reviewer link.',
    });
    const proposalId = /^thread_id: (\S+)/m.exec(created)?.[1] as string;

    const message = await callExpectingError('respond_to_thread', {
      document: link,
      thread_id: proposalId,
      action: 'accept',
    });
    expect(message).toContain('access level is too low');
  });

  test('explains what a read-only link cannot do', async () => {
    const { adminUrl, uid } = await seedBook();
    const invite = await call('create_invite', { document: adminUrl, role: 'reader' });
    const link = /(http\S+)/.exec(invite)?.[1] as string;

    // A fresh MCP server, so nothing about this document is remembered.
    const { server } = createMarginaliaMcpServer({
      baseUrl,
      displayName: 'Claude',
      clientId: 'reader-only-client',
      allowedHosts: [],
      password: null,
      defaultToken: null,
      stateDir: mkdtempSync(join(tmpdir(), 'mcp-state2-')),
      downloadDir,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const readerClient = new Client({ name: 'reader-harness', version: '0' });
    await Promise.all([server.connect(serverTransport), readerClient.connect(clientTransport)]);

    const result = (await readerClient.callTool({
      name: 'create_comment',
      arguments: { document: link, anchor_text: 'The caravan left', body: 'Hello?' },
    })) as { content: Array<{ text?: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
    expect(result.content.map((c) => c.text).join('')).toContain('access level is too low');

    // Reading is still fine.
    const readable = (await readerClient.callTool({
      name: 'get_document',
      arguments: { document: uid, include_source: false },
    })) as { content: Array<{ text?: string }> };
    expect(readable.content.map((c) => c.text).join('')).toContain('your role: reader');
    await readerClient.close();
  });

  test('unlocks a password-protected document', async () => {
    const created = await call('create_document', {
      source: '# Secret\n\nOnly for the initiated.\n',
      name: 'Secret',
      password_protected: true,
    });
    const adminUrl = /^admin link[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    const password = /^password[^:]*: (\S+)$/m.exec(created)?.[1] as string;
    expect(password).toBeTruthy();

    const blocked = await callExpectingError('get_document', { document: adminUrl });
    expect(blocked).toContain('password protected');

    await call('authenticate', { document: adminUrl, password });
    expect(await call('get_document', { document: adminUrl })).toContain('Only for the initiated');
  });

  test('reports a missing document instead of failing opaquely', async () => {
    const message = await callExpectingError('get_document', {
      document: `${baseUrl}/d/AAAAAAAAAAAAAAAAAAAAAA`,
    });
    expect(message).toContain('does not exist');
  });
});
