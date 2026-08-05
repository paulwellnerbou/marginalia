import { readFile } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { HistoryEntryWire, InviteWire, UploadResponseWire } from '../api-types.js';
import { clip, matchBlocks, resolveSection, sectionContains } from '../blocks.js';
import {
  blockList,
  documentHeader,
  gutter,
  lineDiff,
  outline,
  sectionHeader,
  timestamp,
} from '../format.js';
import {
  blockDriftNote,
  documentArg,
  failure,
  guard,
  loadDocument,
  type ToolContext,
  text,
} from './context.js';

export function registerDocumentTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'get_identity',
    {
      title: 'Show Marginalia identity and known documents',
      description:
        'Who this MCP server acts as (the name every comment and proposal is signed with), ' +
        'which Marginalia instance it talks to by default, and which documents it already ' +
        'has an access link for. Start here when a document URL is not to hand.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      guard(async () => {
        const known = ctx.state.knownDocuments();
        const lines = [
          `display name: ${ctx.client.displayName}  (comments and proposals are authored under this name)`,
          `client id: ${ctx.client.clientId}`,
          `default instance: ${ctx.client.defaultBaseUrl}`,
          `allowed hosts: ${ctx.config.allowedHosts.length > 0 ? ctx.config.allowedHosts.join(', ') : '(any host you name in a URL)'}`,
          `state file: ${ctx.state.path ?? '(in-memory only; document links are forgotten on exit)'}`,
          `password configured: ${ctx.config.password ? 'yes' : 'no'}`,
          `download directory: ${ctx.config.downloadDir}`,
        ];
        const docs =
          known.length === 0
            ? 'known documents: none yet — pass a full document URL to any tool to register one.'
            : `known documents:\n${known
                .map(
                  (d) =>
                    `  ${d.uid}  ${d.baseUrl}  ${d.token ? 'access link stored' : 'no invite token (read-only)'}`,
                )
                .join('\n')}`;
        return text(lines.join('\n'), docs);
      }),
  );

  server.registerTool(
    'create_document',
    {
      title: 'Upload markdown to Marginalia',
      description:
        'Create a new Marginalia document from markdown or AsciiDoc so it can be reviewed in ' +
        'the browser. Returns the admin link (keep private) and instructions for sharing a ' +
        'reviewer link. Pass either `source` or `source_path`.',
      inputSchema: {
        source: z.string().optional().describe('The document text.'),
        source_path: z.string().optional().describe('Path to a local file to upload instead.'),
        name: z
          .string()
          .optional()
          .describe('Document name. Defaults to a title from the content.'),
        format: z
          .enum(['markdown', 'asciidoc'])
          .optional()
          .describe('Source flavour. Defaults to markdown, or is inferred from source_path.'),
        password_protected: z
          .boolean()
          .optional()
          .describe('Generate a password gate. The generated password is returned once.'),
        base_url: z
          .string()
          .optional()
          .describe('Marginalia instance to create it on. Defaults to the configured one.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        let source = args.source ?? null;
        if (source === null && args.source_path) {
          try {
            source = await readFile(args.source_path, 'utf8');
          } catch (err) {
            // A wrong path is a typo, not a crash — say which path and let
            // the caller correct it, rather than surfacing a stack trace.
            return failure(
              `Could not read ${args.source_path}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        if (!source) return failure('Provide either `source` or `source_path`.');
        const format =
          args.format ??
          (args.source_path && /\.adoc$|\.asciidoc$/i.test(args.source_path)
            ? 'asciidoc'
            : 'markdown');

        const base = ctx.client.createBaseRef(args.base_url);
        const created = await ctx.client.json<UploadResponseWire>(base, '/api/documents', {
          method: 'POST',
          body: {
            source,
            format,
            ...(args.name ? { name: args.name } : {}),
            ...(args.password_protected ? { password_protected: true } : {}),
          },
        });

        const ref = { baseUrl: base.baseUrl, uid: created.uid, token: created.admin_invite.token };
        ctx.client.rememberDocument(ref);
        return text(
          [
            `Created "${created.name ?? '(untitled)'}" (${created.format}).`,
            `uid: ${created.uid}`,
            `admin link (full control — keep private): ${base.baseUrl}${created.admin_invite.url}`,
            `read-only link: ${base.baseUrl}/d/${created.uid}`,
            created.password
              ? `password (shown once, store it now): ${created.password}`
              : 'no password gate',
          ].join('\n'),
          'To let someone review it, use create_invite with role "collaborator" (comment + ' +
            'propose) or "editor" (also accept proposals) and share that link — not the admin link.',
        );
      }),
  );

  server.registerTool(
    'get_document',
    {
      title: 'Read a Marginalia document, or one section of it',
      description:
        'Fetch a document: metadata, your access role, the outline, and the source. Read this ' +
        'before commenting or proposing so quotes match the real text.\n\n' +
        'On anything book-length, do not pull the whole thing. Call it once with ' +
        '`include_source: false` to get the outline — every section with its line range and ' +
        'size — then call it again with `section` set to the one chapter you need. `section` ' +
        'takes the heading text, its `#slug`, or a "Parent > Child" path, and returns that ' +
        'heading plus everything nested under it.',
      inputSchema: {
        document: documentArg,
        section: z
          .string()
          .optional()
          .describe(
            'Return only this section instead of the whole document. Heading text, `#slug`, or ' +
              '"Parent > Child". Omit for the whole source.',
          ),
        include_source: z
          .boolean()
          .optional()
          .describe('Include the source text. Default true. False gives the outline alone.'),
        include_outline: z
          .boolean()
          .optional()
          .describe(
            'Include the outline of sections. Defaults to true for the whole document, false ' +
              'when `section` is set (you already navigated).',
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const { ref, doc, blocks } = await loadDocument(ctx, args.document);
        const section = args.section ? resolveSection(blocks, args.section) : null;
        const showOutline = args.include_outline ?? section === null;
        const body = section ? section.source : doc.source;
        return text(
          documentHeader(doc, ref, blocks),
          section ? sectionHeader(section) : null,
          showOutline ? `outline:\n${outline(blocks.sections)}` : null,
          blockDriftNote(blocks),
          args.include_source === false
            ? 'source omitted (include_source=false)'
            : `--- ${section ? `section source` : 'source'} (${doc.format}) ---\n${body}`,
          section === null && blocks.sections.length > 1 && doc.source.length > 8000
            ? 'note: this is the whole document. To spend less context next time, request one ' +
                '`section` at a time — the outline above lists them with their sizes.'
            : null,
        );
      }),
  );

  server.registerTool(
    'list_blocks',
    {
      title: 'List a document’s anchorable blocks',
      description:
        'Every block of the document with its `block_id`, section, line range, and exact ' +
        'source. Block ids are what comments and edit proposals anchor to, and a proposal ' +
        'replaces a block’s entire source range — so read the block here before proposing a ' +
        'replacement for it. List items and table cells appear as their own blocks in addition ' +
        'to the enclosing list or table, so either granularity can be targeted. On a long ' +
        'document always narrow with `section` or `query` — unfiltered, this returns the whole ' +
        'source one block at a time.',
      inputSchema: {
        document: documentArg,
        query: z
          .string()
          .optional()
          .describe('Only blocks whose source or text contains this string.'),
        section: z
          .string()
          .optional()
          .describe(
            'Only blocks in this section and its subsections. Heading text, `#slug`, or ' +
              '"Parent > Child" — the same values get_document takes.',
          ),
        block_ids: z.array(z.string()).optional().describe('Only these specific block ids.'),
        offset: z.number().int().min(0).optional().describe('Skip this many matches. Default 0.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe('Max blocks to return. Default 40.'),
        include_source: z
          .boolean()
          .optional()
          .describe('Include each block’s source. Default true.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const { doc, blocks } = await loadDocument(ctx, args.document);
        const section = args.section ? resolveSection(blocks, args.section) : null;
        let selected = blocks.blocks;
        if (args.block_ids?.length) {
          const wanted = new Set(args.block_ids);
          selected = selected.filter((b) => wanted.has(b.id));
        }
        if (section) selected = selected.filter((b) => sectionContains(section, b));
        if (args.query) selected = matchBlocks(selected, args.query);

        const total = selected.length;
        const offset = args.offset ?? 0;
        const limit = args.limit ?? 40;
        const page = selected.slice(offset, offset + limit);
        const more =
          offset + page.length < total
            ? `\n\n(${total - offset - page.length} more blocks match; raise \`limit\` or set \`offset\`=${offset + page.length}.)`
            : '';
        return text(
          `document ${doc.uid} — ${blocks.blocks.length} blocks total`,
          section ? sectionHeader(section) : null,
          blockDriftNote(blocks),
          `${blockList(page, total, {
            includeSource: args.include_source !== false,
            sourceLimit: 4000,
          })}${more}`,
        );
      }),
  );

  server.registerTool(
    'list_history',
    {
      title: 'List document revisions',
      description:
        'Revision history of the document source: who changed it, when, and whether the ' +
        'change came from accepting an edit proposal. Use `get_version_diff` for the contents.',
      inputSchema: {
        document: documentArg,
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe('Newest N entries. Default 20.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const { history } = await ctx.client.json<{ history: HistoryEntryWire[] }>(
          ref,
          `/api/documents/${encodeURIComponent(ref.uid)}/history`,
        );
        const page = history.slice(0, args.limit ?? 20);
        if (page.length === 0) return text('No history entries.');
        const lines = page.map((entry) => {
          const who = entry.actor.display_name ?? 'unknown';
          const extra = entry.proposal
            ? ` — accepted proposal ${entry.proposal.id} by ${entry.proposal.author.display_name}: ${clip(entry.proposal.summary, 100)}`
            : entry.restored_from_oid
              ? ` — restored from ${entry.restored_from_oid}`
              : '';
          return `${entry.oid}  ${timestamp(entry.timestamp)}  ${entry.action.padEnd(16)} ${who}${extra}`;
        });
        return text(`${history.length} revisions (newest first):`, lines.join('\n'));
      }),
  );

  server.registerTool(
    'get_version_diff',
    {
      title: 'Diff a document revision',
      description: 'The before/after source for one revision id (`oid`) from `list_history`.',
      inputSchema: {
        document: documentArg,
        oid: z.string().describe('Revision id from list_history.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const diff = await ctx.client.json<{ before: string; after: string }>(
          ref,
          `/api/documents/${encodeURIComponent(ref.uid)}/history/${encodeURIComponent(args.oid)}/diff`,
        );
        return text(`diff for ${args.oid}:`, lineDiff(diff.before, diff.after));
      }),
  );

  server.registerTool(
    'authenticate',
    {
      title: 'Unlock a password-protected document',
      description:
        'Open a session for a password-protected document. Prefer setting the ' +
        'MARGINALIA_PASSWORD environment variable — then this is unnecessary and the ' +
        'password never travels through the conversation. The session lasts until this ' +
        'server exits.',
      inputSchema: {
        document: documentArg,
        password: z
          .string()
          .optional()
          .describe('Only if MARGINALIA_PASSWORD is not set. Ask the user; never guess.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const password = args.password ?? ctx.config.password;
        if (!password) {
          return failure(
            'No password available. Set MARGINALIA_PASSWORD in this server’s environment, or ' +
              'ask the user to supply it.',
          );
        }
        const ref = ctx.client.resolve(args.document);
        await ctx.client.authenticate(ref, password);
        return text(`Authenticated for document ${ref.uid}.`);
      }),
  );

  server.registerTool(
    'list_invites',
    {
      title: 'List a document’s access links',
      description:
        'All invite links for a document and the role each grants. Requires admin access.',
      inputSchema: { document: documentArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const { invites } = await ctx.client.json<{ invites: InviteWire[] }>(
          ref,
          `/api/documents/${encodeURIComponent(ref.uid)}/invites`,
        );
        if (invites.length === 0) return text('No invites.');
        return text(
          invites
            .map(
              (i) =>
                `${i.kind.padEnd(8)} ${i.role.padEnd(13)} ${i.display_name ?? '(any name)'}\n  ${ref.baseUrl}${i.url}${i.note ? `\n  note: ${i.note}` : ''}`,
            )
            .join('\n'),
        );
      }),
  );

  server.registerTool(
    'create_invite',
    {
      title: 'Create an access link',
      description:
        'Mint a shareable link granting a role on a document. Requires admin access. Use this ' +
        'to give a reviewer — or this MCP server itself — comment and proposal rights, instead ' +
        'of sharing the admin link.',
      inputSchema: {
        document: documentArg,
        role: z
          .enum(['reader', 'collaborator', 'editor'])
          .describe(
            'reader: view only. collaborator: comment and propose edits. editor: also edit the ' +
              'source and accept/reject proposals.',
          ),
        display_name: z
          .string()
          .optional()
          .describe('Name the recipient is shown as. Omit for a link where they pick their own.'),
        note: z.string().optional().describe('Private note about who this link is for.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const { invite } = await ctx.client.json<{ invite: InviteWire }>(
          ref,
          `/api/documents/${encodeURIComponent(ref.uid)}/invites`,
          {
            method: 'POST',
            body: {
              kind: args.display_name ? 'named' : 'generic',
              role: args.role,
              ...(args.display_name ? { display_name: args.display_name } : {}),
              ...(args.note ? { note: args.note } : {}),
            },
          },
        );
        return text(
          `Created a ${invite.role} link${invite.display_name ? ` for ${invite.display_name}` : ''}:`,
          `${ref.baseUrl}${invite.url}`,
        );
      }),
  );

  server.registerTool(
    'get_rendered_html',
    {
      title: 'Get the rendered HTML of a document',
      description:
        'The server-rendered HTML for the document — the same markup the browser viewer shows, ' +
        'with `data-block` attributes carrying the block ids. Useful for inspecting how a ' +
        'document renders; for reading the content prefer get_document or list_blocks.',
      inputSchema: { document: documentArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const { doc } = await loadDocument(ctx, args.document);
        return text(`rendered HTML for ${doc.uid}:`, gutter(doc.rendered.html, ''));
      }),
  );
}
