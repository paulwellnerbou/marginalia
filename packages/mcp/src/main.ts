import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { MarginaliaClient } from './client.js';
import { loadMcpConfig, type McpConfig } from './config.js';
import { McpState } from './state.js';
import type { ToolContext } from './tools/context.js';
import { registerDocumentTools } from './tools/documents.js';
import { registerEditingTools } from './tools/editing.js';
import { registerExportTools } from './tools/export.js';
import { registerReviewTools } from './tools/review.js';

export const SERVER_NAME = 'marginalia';
export const SERVER_VERSION = '0.1.0';

/**
 * Shown to the model once, when the server connects. It carries the two
 * things the per-tool descriptions can't: the order the tools are meant
 * to be used in, and the distinction between suggesting a change and
 * making one.
 */
function instructions(config: McpConfig): string {
  return [
    'Marginalia is a collaborative reviewer for markdown and AsciiDoc documents: readers',
    'highlight text, leave comments, and suggest edits that the owner accepts or rejects.',
    '',
    `Everything you write here is signed "${config.displayName}" and is visible to everyone`,
    'with access to the document.',
    '',
    'Access comes from the document link. A URL of the form https://<host>/d/<uid>/<token>',
    'carries an invite token that grants a role (reader, collaborator, editor, admin). Pass',
    'the full URL the user gave you as the `document` argument — a bare uid only works for a',
    'document seen before.',
    '',
    'Working through a review:',
    '  1. list_threads (state="open") — read the reviewer’s comments, each with the text it',
    '     is anchored to. `awaiting_my_response: true` narrows it to what still needs work.',
    '  2. list_blocks — read the exact source of the block a comment is about. An edit',
    '     proposal replaces a block’s whole source range, so this is where the replacement',
    '     text comes from.',
    '  3. create_proposal — suggest the concrete rewrite, with `reply_to_thread_id` set to',
    '     the comment you are answering so the reviewer sees it was addressed.',
    '  4. create_comment — flag knock-on effects elsewhere in the document that the same',
    '     change implies, anchored where they occur.',
    '  5. reply_to_thread — answer questions and explain decisions in the thread itself.',
    '',
    'Read a chapter at a time. These are long documents — books, specs, reports — and',
    'pulling the whole source to work on one part wastes the context you need for the work.',
    'get_document with `include_source: false` returns just the outline: every section with',
    'its line range and size. Then get_document, list_blocks and list_threads all take a',
    '`section` (heading text, `#slug`, or "Parent > Child") that scopes them to that section',
    'and everything nested under it. Fetch the whole source only when the task genuinely',
    'spans the document.',
    '',
    'Suggest, don’t overwrite. create_proposal leaves the decision with the document owner;',
    'edit_document and update_document change the document immediately and should be used',
    'only when the user explicitly asks for a direct edit. respond_to_thread with',
    'action="accept" applies someone else’s proposal — also the user’s call, not yours.',
    '',
    'Accepting a proposal rewrites the source, which can orphan other open proposals that',
    'touched the same text. Re-run list_threads after any accept.',
  ].join('\n');
}

export function createMarginaliaMcpServer(config = loadMcpConfig()): {
  server: McpServer;
  context: ToolContext;
} {
  const state = new McpState(config.stateDir, config.clientId);
  const client = new MarginaliaClient(config, state);
  const context: ToolContext = { client, config, state };

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION, title: 'Marginalia document review' },
    { capabilities: { tools: {} }, instructions: instructions(config) },
  );

  registerDocumentTools(server, context);
  registerReviewTools(server, context);
  registerEditingTools(server, context);
  registerExportTools(server, context);

  return { server, context };
}

export async function main(): Promise<void> {
  const { server } = createMarginaliaMcpServer();
  await server.connect(new StdioServerTransport());
  // stdout belongs to the JSON-RPC channel; anything human-facing goes to stderr.
  console.error(`[marginalia-mcp] ready (${SERVER_VERSION})`);
}
