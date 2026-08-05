import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { DocumentWire } from '../api-types.js';
import { BlockLookupError, buildBlockMap, type DocumentBlockMap } from '../blocks.js';
import { MarginaliaApiError, type MarginaliaClient } from '../client.js';
import type { McpConfig } from '../config.js';
import { type DocumentRef, DocumentRefError } from '../document-ref.js';
import type { McpState } from '../state.js';

export interface ToolContext {
  client: MarginaliaClient;
  config: McpConfig;
  state: McpState;
}

/** Every document-scoped tool takes the same first argument. */
export const documentArg = z
  .string()
  .describe(
    'The document: a full Marginalia URL (https://host/d/<uid>/<token> — the token grants ' +
      'comment/edit rights, so always pass the link you were given), or a bare uid for a ' +
      'document seen before.',
  );

export interface LoadedDocument {
  ref: DocumentRef;
  doc: DocumentWire;
  blocks: DocumentBlockMap;
}

/** Fetch a document and join its rendered block map with local source ranges. */
export async function loadDocument(ctx: ToolContext, documentRef: string): Promise<LoadedDocument> {
  const ref = ctx.client.resolve(documentRef);
  const doc = await ctx.client.json<DocumentWire>(
    ref,
    `/api/documents/${encodeURIComponent(ref.uid)}`,
  );
  const blocks = await buildBlockMap(doc);
  return { ref, doc, blocks };
}

export function text(...parts: Array<string | null | undefined>): CallToolResult {
  return {
    content: [{ type: 'text', text: parts.filter((p) => p != null && p !== '').join('\n\n') }],
  };
}

export function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * Turn thrown errors into tool errors the model can recover from.
 *
 * Everything the API and the block resolver raise is already phrased as
 * an instruction ("re-read the block list and retry"), so it is passed
 * through verbatim; anything else is unexpected and reported as such.
 */
export async function guard(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (err) {
    if (
      err instanceof MarginaliaApiError ||
      err instanceof DocumentRefError ||
      err instanceof BlockLookupError
    ) {
      return failure(err.message);
    }
    return failure(`Unexpected failure: ${err instanceof Error ? err.stack : String(err)}`);
  }
}

/** Warn once per response when the local block walk disagreed with the server. */
export function blockDriftNote(blocks: DocumentBlockMap): string | null {
  if (blocks.unresolved.length === 0) return null;
  return (
    `note: ${blocks.unresolved.length} block(s) could not be located in the source by this ` +
    'client, so their exact source text is unavailable. Comments still work; edit proposals ' +
    'against them need `anchor_text` verified against the raw source.'
  );
}
