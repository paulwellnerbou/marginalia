import {
  type BlockSourceRange,
  type LocatedBlocks,
  locateAllBlocks,
  locateAllBlocksAsciidoc,
  locateAllBlocksHtml,
  locateBlocks,
  locateBlocksAsciidoc,
  locateBlocksHtml,
} from '@marginalia/renderer';
import type { DocumentFormat } from './db.js';

/** Every block's source range, for whichever format the document is in. */
export async function locateAllBlocksFor(
  source: string,
  format: DocumentFormat,
): Promise<Map<string, BlockSourceRange>> {
  if (format === 'asciidoc') return locateAllBlocksAsciidoc(source);
  if (format === 'html') return locateAllBlocksHtml(source);
  return locateAllBlocks(source);
}

/** `locateAllBlocksFor` with every occurrence of a repeated block kept. */
export async function locateBlocksFor(
  source: string,
  format: DocumentFormat,
): Promise<LocatedBlocks> {
  if (format === 'asciidoc') return locateBlocksAsciidoc(source);
  if (format === 'html') return locateBlocksHtml(source);
  return locateBlocks(source);
}
