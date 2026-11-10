import { readFile } from 'node:fs/promises';
import { normalizeRefName } from '@marginalia/renderer/asset-rewrite';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocumentWire } from '../api-types.js';
import { MarginaliaApiError } from '../client.js';
import type { DocumentRef } from '../document-ref.js';
import { documentArg, failure, guard, type ToolContext, text } from './context.js';

/** The server serves an asset's type from its name's extension alone. */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];

export interface ImageInput {
  name: string;
  data_base64?: string | undefined;
  /** Only in the schema when local files are allowed, hence not typed tighter. */
  path?: unknown;
}

export function imageSchema(allowLocalFiles: boolean) {
  return z.object({
    name: z
      .string()
      .describe(
        'The name the source uses for it: `diagram.png` for `![…](diagram.png)` or ' +
          '`image::diagram.png[]`. Subfolders are fine (`img/a.png`). png, jpg, gif, webp or svg.',
      ),
    data_base64: z
      .string()
      .optional()
      .describe('The image bytes, base64-encoded. A `data:` URL works too.'),
    ...(allowLocalFiles
      ? { path: z.string().optional().describe('A local image file to read instead.') }
      : {}),
  });
}

export const IMAGES_HINT =
  'Images are files stored with the document and found by the name the source uses for ' +
  'them, so reference each one by its `name` (`![alt](diagram.png)` in markdown, ' +
  '`image::diagram.png[]` in AsciiDoc). An image at a full https:// address needs no upload.';

type Prepared =
  | { ok: true; name: string; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; line: string };

/** Validate one image and load its bytes, without touching the network. */
export async function prepareImage(input: ImageInput, allowLocalFiles: boolean): Promise<Prepared> {
  const name = normalizeRefName(input.name);
  const label = input.name.trim() || '(unnamed)';
  if (!name) {
    return {
      ok: false,
      line: `${label}: not a usable name — no leading /, \\, ?, #, :, or empty, . or .. segments`,
    };
  }
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (!IMAGE_EXTENSIONS.includes(ext)) {
    return { ok: false, line: `${name}: name must end in .${IMAGE_EXTENSIONS.join(', .')}` };
  }
  if (input.data_base64 !== undefined) {
    const bytes = decodeBase64(input.data_base64);
    if (!bytes) return { ok: false, line: `${name}: data_base64 is not valid base64` };
    return { ok: true, name, bytes };
  }
  if (allowLocalFiles && typeof input.path === 'string' && input.path) {
    try {
      return { ok: true, name, bytes: new Uint8Array(await readFile(input.path)) };
    } catch (err) {
      return {
        ok: false,
        line: `${name}: could not read ${input.path}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return {
    ok: false,
    line: `${name}: pass ${allowLocalFiles ? '`data_base64` or `path`' : '`data_base64` (this server cannot read local files)'}`,
  };
}

function decodeBase64(raw: string): Uint8Array<ArrayBuffer> | null {
  const payload = raw
    .trim()
    .replace(/^data:[^,]*;base64,/i, '')
    .replace(/\s+/g, '');
  if (payload.length === 0 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(payload)) return null;
  const bytes = Buffer.from(
    payload,
    payload.includes('-') || payload.includes('_') ? 'base64url' : 'base64',
  );
  return bytes.length > 0 ? new Uint8Array(bytes) : null;
}

/** Attach one image under `ref`'s access. Returns a line for the tool's report. */
export async function uploadImage(
  ctx: ToolContext,
  ref: DocumentRef,
  image: { name: string; bytes: Uint8Array<ArrayBuffer> },
): Promise<{ ok: boolean; line: string }> {
  const form = new FormData();
  form.set('ref_name', image.name);
  form.set('file', new Blob([image.bytes]), image.name.split('/').pop() ?? image.name);
  try {
    await ctx.client.json(ref, `/api/documents/${encodeURIComponent(ref.uid)}/assets`, {
      method: 'POST',
      form,
    });
    return { ok: true, line: `${image.name}: attached (${formatBytes(image.bytes.length)})` };
  } catch (err) {
    return { ok: false, line: `${image.name}: ${describeUploadError(err)}` };
  }
}

function describeUploadError(err: unknown): string {
  if (!(err instanceof MarginaliaApiError)) return err instanceof Error ? err.message : String(err);
  switch (err.code) {
    case 'forbidden':
      return (
        'refused — attaching images needs the editor or admin role, and you have less here. ' +
        'Ask the user for editor access, or put the reference in a proposal and let a person ' +
        'drop the file into the editor.'
      );
    case 'file-too-large':
      return 'refused — larger than the server’s upload limit (16 MiB unless configured otherwise)';
    default:
      return err.message;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Prepare and attach a batch, reporting each one; nothing here throws. */
export async function attachImages(
  ctx: ToolContext,
  ref: DocumentRef,
  images: readonly ImageInput[],
  allowLocalFiles: boolean,
): Promise<{ lines: string[]; attached: string[] }> {
  const lines: string[] = [];
  const attached: string[] = [];
  const seen = new Set<string>();
  for (const input of images) {
    const prepared = await prepareImage(input, allowLocalFiles);
    if (!prepared.ok) {
      lines.push(prepared.line);
      continue;
    }
    // A second upload under one name replaces the first, so both would
    // report "attached" while only one survives.
    if (seen.has(prepared.name)) {
      lines.push(`${prepared.name}: skipped — the same name appears earlier in the list`);
      continue;
    }
    seen.add(prepared.name);
    const result = await uploadImage(ctx, ref, prepared);
    lines.push(result.line);
    if (result.ok) attached.push(prepared.name);
  }
  return { lines, attached };
}

/**
 * Where the source and its images disagree: a reference nothing is
 * attached under, or an image just attached that nothing references.
 * Read from the rendered HTML, which marks every image reference as
 * missing or attached by name, for markdown and AsciiDoc alike.
 * Best-effort: a failed read yields no notes rather than an error.
 */
export async function imageReferenceNotes(
  ctx: ToolContext,
  ref: DocumentRef,
  justAttached: readonly string[],
): Promise<string[]> {
  let html: string;
  try {
    const doc = await ctx.client.json<DocumentWire>(
      ref,
      `/api/documents/${encodeURIComponent(ref.uid)}`,
    );
    html = doc.rendered.html;
  } catch {
    return [];
  }
  const missing = new Set(
    [...html.matchAll(/data-missing-asset="([^"]*)"/g)].map((m) => decodeEntities(m[1] ?? '')),
  );
  const referenced = new Set(missing);
  for (const m of html.matchAll(/data-asset-ref="([^"]*)"/g)) {
    referenced.add(decodeEntities(m[1] ?? ''));
  }
  return [
    ...[...missing].map((name) => `${name}: the source references it, but no image is attached`),
    ...justAttached
      .filter((name) => !referenced.has(name))
      .map((name) => `${name}: attached, but the source does not reference it under that name`),
  ];
}

function decodeEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function registerImageTools(
  server: McpServer,
  ctx: ToolContext,
  options: { allowLocalFiles: boolean },
): void {
  const { allowLocalFiles } = options;
  server.registerTool(
    'upload_image',
    {
      title: 'Attach an image to a document',
      description:
        `Attach an image to an existing document. ${IMAGES_HINT} Needs the editor or admin ` +
        'role on the document. Attaching under a name already in use replaces that image. To ' +
        'add images to a document you are creating, pass them to create_document instead.',
      inputSchema: {
        document: documentArg,
        ...imageSchema(allowLocalFiles).shape,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const prepared = await prepareImage(args, allowLocalFiles);
        if (!prepared.ok) return failure(prepared.line);
        const result = await uploadImage(ctx, ref, prepared);
        if (!result.ok) return failure(result.line);
        const notes = await imageReferenceNotes(ctx, ref, [prepared.name]);
        return text(result.line, ...notes);
      }),
  );
}
