import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { lineDiff } from '../format.js';
import { documentArg, failure, guard, loadDocument, type ToolContext, text } from './context.js';

/**
 * Direct edits to the stored source, for callers with editor rights.
 *
 * These bypass review: the change lands in the document immediately and
 * shows up in its history. When the point is to *suggest* a change,
 * `create_proposal` is the right tool — it leaves the decision with the
 * document owner.
 */
export function registerEditingTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'edit_document',
    {
      title: 'Apply text edits to a document',
      description:
        'Search-and-replace edits applied to the document source and saved as a new revision. ' +
        'Needs editor access, and writes directly — no review step. When the user is reviewing ' +
        'and wants to approve changes, use create_proposal instead.\n\n' +
        'Each `find` must occur exactly once unless `replace_all` is set. Use `dry_run` to see ' +
        'the diff without saving.',
      inputSchema: {
        document: documentArg,
        edits: z
          .array(
            z.object({
              find: z.string().describe('Exact text to locate in the source.'),
              replace: z.string().describe('Replacement text.'),
              replace_all: z
                .boolean()
                .optional()
                .describe('Replace every occurrence instead of requiring exactly one.'),
            }),
          )
          .min(1)
          .describe('Applied in order; each sees the result of the previous one.'),
        commit_message: z.string().optional().describe('Short summary stored with the revision.'),
        dry_run: z.boolean().optional().describe('Show the diff without saving. Default false.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const { ref, doc } = await loadDocument(ctx, args.document);
        let next = doc.source;
        const applied: string[] = [];
        for (const [index, edit] of args.edits.entries()) {
          const occurrences = countOccurrences(next, edit.find);
          if (occurrences === 0) {
            return failure(
              `Edit ${index + 1} failed: ${JSON.stringify(clipInline(edit.find))} does not occur ` +
                'in the current source. Re-read the document — it may have changed.',
            );
          }
          if (occurrences > 1 && !edit.replace_all) {
            return failure(
              `Edit ${index + 1} failed: ${JSON.stringify(clipInline(edit.find))} occurs ` +
                `${occurrences} times. Include more surrounding text, or set replace_all.`,
            );
          }
          next = edit.replace_all
            ? next.split(edit.find).join(edit.replace)
            : next.replace(edit.find, edit.replace);
          applied.push(`  ${index + 1}. replaced ${occurrences} occurrence(s)`);
        }

        if (next === doc.source) return text('No change — the edits produced identical source.');
        const diff = lineDiff(doc.source, next);
        if (args.dry_run)
          return text('Dry run — nothing was saved.', `diff:\n${diff}`, applied.join('\n'));

        const { oid } = await saveSource(ctx, ref, next, args.commit_message);
        return text(
          `Saved ${args.edits.length} edit(s) to ${ref.uid} as revision ${oid}.`,
          applied.join('\n'),
          `diff:\n${diff}`,
        );
      }),
  );

  server.registerTool(
    'update_document',
    {
      title: 'Replace a document’s entire source',
      description:
        'Overwrite the whole document source with new text and save it as a revision. Needs ' +
        'editor access. Destructive: everything not present in `source` is gone from the ' +
        'current revision (the previous one stays in history). Prefer edit_document for ' +
        'targeted changes, and create_proposal when the change should be reviewed first.',
      inputSchema: {
        document: documentArg,
        source: z.string().describe('The complete new document source.'),
        commit_message: z.string().optional().describe('Short summary stored with the revision.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const { ref, doc } = await loadDocument(ctx, args.document);
        if (args.source === doc.source) return text('No change — the source is already identical.');
        const { oid } = await saveSource(ctx, ref, args.source, args.commit_message);
        return text(
          `Replaced the source of ${ref.uid} (revision ${oid}).`,
          `${doc.source.split('\n').length} → ${args.source.split('\n').length} lines`,
          `diff:\n${lineDiff(doc.source, args.source)}`,
        );
      }),
  );
}

async function saveSource(
  ctx: ToolContext,
  ref: { baseUrl: string; uid: string; token: string | null },
  source: string,
  commitMessage: string | undefined,
): Promise<{ oid: string }> {
  return ctx.client.json<{ oid: string }>(ref, `/api/documents/${encodeURIComponent(ref.uid)}`, {
    method: 'PUT',
    body: { source, ...(commitMessage ? { commit_message: commitMessage } : {}) },
  });
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count++;
    from = at + needle.length;
  }
}

function clipInline(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= 60 ? flat : `${flat.slice(0, 59)}…`;
}
