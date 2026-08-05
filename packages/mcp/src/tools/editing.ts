import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocumentFormat } from '../api-types.js';
import { type DocumentSection, resolveSection } from '../blocks.js';
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
      title: 'Replace a document’s source, or one section of it',
      description:
        'Overwrite a document’s source with new text and save it as a revision. Needs editor ' +
        'access, and writes directly — use create_proposal when the change should be reviewed ' +
        'first.\n\n' +
        'With `section`, only that heading and everything nested under it is replaced. This is ' +
        'the counterpart to reading one chapter with `get_document`, and the right tool on ' +
        'anything book-length: rewriting a chapter costs one chapter, not the whole book sent ' +
        'back. `section` takes the same values get_document does — heading text, `#slug`, or ' +
        '"Parent > Child" — and `source` is then that section alone, starting with its heading ' +
        'line.\n\n' +
        'Without `section` the whole document is replaced, so everything absent from `source` ' +
        'is gone from the current revision (the previous one stays in history). Prefer ' +
        'edit_document for changes small enough to describe as search-and-replace.',
      inputSchema: {
        document: documentArg,
        source: z
          .string()
          .describe(
            'The complete new source: of the named `section` including its heading line, or of ' +
              'the whole document when `section` is omitted.',
          ),
        section: z
          .string()
          .optional()
          .describe(
            'Replace only this section and its subsections, leaving the rest of the document ' +
              'untouched. Heading text, `#slug`, or "Parent > Child".',
          ),
        commit_message: z.string().optional().describe('Short summary stored with the revision.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const { ref, doc, blocks } = await loadDocument(ctx, args.document);
        const section = args.section ? resolveSection(blocks, args.section) : null;
        // The replaced range runs heading to heading with the blank lines
        // between sections outside it on both sides: `section.source` was
        // cut with its trailing whitespace stripped, and what precedes
        // `section.start` already ends with the separator. So whitespace
        // the caller left on either end is theirs, not the document's —
        // keeping it would double the separator into a growing gap, and
        // leading blank lines would additionally push the heading off line
        // one and trip the check below with a message describing a problem
        // the caller does not have.
        const replacement = section ? args.source.replace(/^\s+|\s+$/gu, '') : args.source;

        if (section) {
          const heading = headingLine(replacement, doc.format);
          if (!heading) return failure(missingHeadingMessage(section, doc.format));
          const next =
            doc.source.slice(0, section.start) + replacement + doc.source.slice(section.end);
          if (next === doc.source) return text('No change — the section is already identical.');
          const { oid } = await saveSource(ctx, ref, next, args.commit_message);
          const oldHeading = (section.source.split('\n')[0] as string).trim();
          return text(
            `Replaced section ${section.path.join(' › ')} of ${ref.uid} (revision ${oid}).`,
            [
              `section: lines ${section.startLine}-${section.endLine}, ` +
                `${section.source.split('\n').length} → ${replacement.split('\n').length} lines`,
              `document: ${doc.source.split('\n').length} → ${next.split('\n').length} lines`,
            ].join('\n'),
            heading.trim() === oldHeading
              ? null
              : `note: the heading changed (${oldHeading} → ${heading.trim()}), so this section’s ` +
                  '#slug changes with it and links pointing at the old one stop resolving.',
            `diff:\n${lineDiff(doc.source, next)}`,
          );
        }

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

/**
 * The replacement's own heading line, or null if it does not open with one.
 *
 * A section runs from its heading to the next one at the same depth, so a
 * replacement lacking a heading dissolves the boundary: the text merges
 * into whatever precedes it and every subsection under it reparents.
 * A diff of the prose looks right while the outline has quietly collapsed,
 * which is why this is refused rather than warned about.
 */
function headingLine(source: string, format: DocumentFormat): string | null {
  const lines = source.split('\n');
  const first = lines[0] ?? '';
  if (format === 'asciidoc') return /^={1,6}\s+\S/u.test(first) ? first : null;
  if (/^ {0,3}#{1,6}(\s|$)/u.test(first)) return first;
  // Setext: it is the underline that makes the line above it a heading.
  return first.trim() !== '' && /^ {0,3}(=+|-+)\s*$/u.test(lines[1] ?? '') ? first : null;
}

function missingHeadingMessage(section: DocumentSection, format: DocumentFormat): string {
  const opener = (section.source.split('\n')[0] as string).trim();
  return (
    `A section replacement has to start with the section’s heading line — ` +
    `${JSON.stringify(clipInline(opener))}, or a ${format} heading rewriting it. Without one the ` +
    'section stops existing: its text merges into the section above and any subsections below ' +
    'reparent. Put the heading back, or drop `section` and pass the whole document source.'
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
