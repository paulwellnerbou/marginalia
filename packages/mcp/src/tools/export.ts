import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocumentWire } from '../api-types.js';
import { MarginaliaApiError } from '../client.js';
import type { DocumentRef } from '../document-ref.js';
import { documentArg, guard, type ToolContext, text } from './context.js';

/**
 * Every download the server can produce.
 *
 * `source` and `bundle` are cheap; `docx` and `pdf` are rendered
 * server-side and can take seconds on a long document (PDF also needs
 * Chromium installed there).
 */
const FORMATS = ['source', 'bundle', 'docx', 'pdf'] as const;
type Format = (typeof FORMATS)[number];

export function registerExportTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'export_document',
    {
      title: 'Download a document',
      description:
        'Write the document to local files in one or more formats.\n\n' +
        '  source — the raw markdown/AsciiDoc\n' +
        '  bundle — .marginalia.json: source plus every comment thread and proposal\n' +
        '  docx   — themed Word document; with `with_review_comments` the open comments and ' +
        'proposals become native Word comments and tracked changes\n' +
        '  pdf    — themed PDF\n\n' +
        'Set `with_open_proposals_applied` to export the document as it would read if every ' +
        'open edit proposal were accepted, without changing the stored document. Pass ' +
        '`formats: ["all"]` for everything.',
      inputSchema: {
        document: documentArg,
        formats: z
          .array(z.enum([...FORMATS, 'all']))
          .optional()
          .describe('Default ["source"].'),
        output_dir: z
          .string()
          .optional()
          .describe('Directory to write into. Defaults to the configured download directory.'),
        basename: z
          .string()
          .optional()
          .describe('Filename without extension. Defaults to the server-suggested name.'),
        theme: z.string().optional().describe('Theme id for docx/pdf. Defaults to the document’s.'),
        with_review_comments: z
          .boolean()
          .optional()
          .describe('DOCX only: fold open comments and proposals in as Word review markup.'),
        with_open_proposals_applied: z
          .boolean()
          .optional()
          .describe(
            'source/docx only: export with every open proposal applied (nothing is saved).',
          ),
        include_assets: z
          .boolean()
          .optional()
          .describe('Also download the document’s attached images into an `assets/` subfolder.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const doc = await ctx.client.json<DocumentWire>(
          ref,
          `/api/documents/${encodeURIComponent(ref.uid)}`,
        );

        const requested = args.formats ?? ['source'];
        const formats: Format[] = requested.includes('all')
          ? [...FORMATS]
          : (requested as Format[]);
        const dir = resolveDir(args.output_dir ?? ctx.config.downloadDir);
        await mkdir(dir, { recursive: true });

        const written: string[] = [];
        const failed: string[] = [];
        for (const format of formats) {
          try {
            written.push(await exportOne(ctx, ref, doc, format, dir, args));
          } catch (err) {
            failed.push(
              `  ${format}: ${err instanceof MarginaliaApiError ? err.message : String(err)}`,
            );
          }
        }

        if (args.include_assets && doc.attached_assets.length > 0) {
          const assetDir = join(dir, 'assets');
          await mkdir(assetDir, { recursive: true });
          for (const asset of doc.attached_assets) {
            try {
              const { bytes } = await ctx.client.bytes(
                ref,
                `/api/documents/${encodeURIComponent(ref.uid)}/assets/${asset.ref_name
                  .split('/')
                  .map(encodeURIComponent)
                  .join('/')}`,
              );
              const target = safeJoin(assetDir, asset.ref_name);
              await writeFile(target, bytes);
              written.push(`${target} (${bytes.length} bytes)`);
            } catch (err) {
              failed.push(`  asset ${asset.ref_name}: ${String(err)}`);
            }
          }
        }

        return text(
          written.length > 0 ? `Wrote:\n${written.map((w) => `  ${w}`).join('\n')}` : null,
          failed.length > 0 ? `Failed:\n${failed.join('\n')}` : null,
          written.length === 0 && failed.length === 0 ? 'Nothing to export.' : null,
        );
      }),
  );
}

interface ExportArgs {
  basename?: string | undefined;
  theme?: string | undefined;
  with_review_comments?: boolean | undefined;
  with_open_proposals_applied?: boolean | undefined;
}

async function exportOne(
  ctx: ToolContext,
  ref: DocumentRef,
  doc: DocumentWire,
  format: Format,
  dir: string,
  args: ExportArgs,
): Promise<string> {
  const base = `/api/documents/${encodeURIComponent(ref.uid)}`;
  const applied = args.with_open_proposals_applied === true;

  if (format === 'source' && !applied) {
    // The source already came back with the document; no second round-trip.
    const name = `${args.basename ?? fallbackName(doc)}.${sourceExtension(doc)}`;
    const target = safeJoin(dir, name);
    await writeFile(target, doc.source, 'utf8');
    return `${target} (${doc.source.length} bytes, ${doc.format})`;
  }

  const { path, query } = exportRequest(base, format, applied, args);
  const { bytes, filename, headers } = await ctx.client.bytes(ref, path, { query });
  const name = args.basename
    ? `${args.basename}.${extensionOf(filename, format, doc)}`
    : (filename ?? `${fallbackName(doc)}.${extensionOf(null, format, doc)}`);
  const target = safeJoin(dir, name);
  await writeFile(target, bytes);

  const skipped = headers.get('X-Marginalia-Proposals-Skipped');
  const appliedCount = headers.get('X-Marginalia-Proposals-Applied');
  const note =
    applied && appliedCount
      ? `, ${appliedCount} proposal(s) applied${skipped && skipped !== '0' ? `, ${skipped} skipped as conflicting` : ''}`
      : '';
  return `${target} (${bytes.length} bytes${note})`;
}

function exportRequest(
  base: string,
  format: Format,
  applied: boolean,
  args: ExportArgs,
): { path: string; query: Record<string, string | undefined> } {
  const theme = args.theme;
  switch (format) {
    case 'source':
      return { path: `${base}/export.accepted-source`, query: {} };
    case 'bundle':
      return { path: `${base}/export`, query: {} };
    case 'docx':
      return applied
        ? { path: `${base}/export.accepted.docx`, query: { theme } }
        : {
            path: `${base}/export.docx`,
            query: { theme, review: args.with_review_comments ? 'both' : undefined },
          };
    case 'pdf':
      return { path: `${base}/export.pdf`, query: { theme } };
  }
}

function extensionOf(filename: string | null, format: Format, doc: DocumentWire): string {
  if (filename) {
    const dot = filename.lastIndexOf('.');
    if (dot > 0) return filename.slice(dot + 1);
  }
  switch (format) {
    case 'source':
      return sourceExtension(doc);
    case 'bundle':
      return 'marginalia.json';
    case 'docx':
      return 'docx';
    case 'pdf':
      return 'pdf';
  }
}

function sourceExtension(doc: DocumentWire): string {
  return doc.format === 'asciidoc' ? 'adoc' : 'md';
}

function fallbackName(doc: DocumentWire): string {
  return sanitizeName(doc.name ?? doc.uid);
}

/**
 * Build the path to write to, keeping it inside `dir`.
 *
 * Filenames arrive from two untrusted-ish places — the caller's
 * `basename` and the server's `Content-Disposition` — so every write
 * goes through here rather than a bare `join`. Flattening separators
 * and leading dots handles the ordinary cases; the containment check
 * afterwards is the part that has to hold, and it fails loudly instead
 * of quietly writing somewhere else.
 */
function safeJoin(dir: string, name: string): string {
  const target = join(dir, sanitizeName(name));
  const rel = relative(dir, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to write "${name}" outside ${dir}`);
  }
  return target;
}

function sanitizeName(name: string): string {
  return (
    name
      .replace(/[/\\]+/g, '_')
      .replace(/^\.+/, '_')
      .slice(0, 120) || 'document'
  );
}

function resolveDir(dir: string): string {
  return isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
}
