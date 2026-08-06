import type { BlockSourceRange } from '@marginalia/renderer/locate-block';
import type { DocumentFormat } from './api.js';

type BlockLocator = (source: string) => Map<string, BlockSourceRange>;

const locatorPromises = new Map<DocumentFormat, Promise<BlockLocator>>();

/**
 * Load source-range parsing independently from the document viewer.
 *
 * The rendered document can be displayed without these ranges. They are only
 * needed for selection comments and edit proposals, so neither the Markdown
 * parser nor Asciidoctor should delay the first document paint.
 */
export function loadBlockRanges(
  source: string,
  format: DocumentFormat,
): Promise<Map<string, BlockSourceRange>> {
  let promise = locatorPromises.get(format);
  if (!promise) {
    promise =
      format === 'asciidoc'
        ? import('@marginalia/renderer/locate-block-asciidoc').then(
            (module) => module.locateAllBlocksAsciidoc,
          )
        : import('@marginalia/renderer/locate-block').then((module) => module.locateAllBlocks);
    locatorPromises.set(format, promise);
    promise.catch(() => {
      if (locatorPromises.get(format) === promise) locatorPromises.delete(format);
    });
  }
  return promise.then((locate) => locate(source));
}
