// Lazy, format-aware loader for editor and proposal previews.
//
// Import the narrow renderer entrypoints instead of the package barrel. The
// barrel also exports DOCX and AsciiDoc support, which makes bundlers retain
// the sizeable Asciidoctor/Opal runtime even for ordinary Markdown pages.

import type { RewriteOptions } from '@marginalia/renderer/asset-rewrite';
import type { RenderOptions, RenderResult } from '@marginalia/renderer/types';
import type { DocumentFormat } from './api.js';

export interface LoadedRenderer {
  renderDocument(source: string, options?: RenderOptions): Promise<RenderResult>;
  rewriteAssetReferences(html: string, options: RewriteOptions): Promise<string>;
}

const rendererPromises = new Map<DocumentFormat, Promise<LoadedRenderer>>();

export function loadRenderer(format: DocumentFormat): Promise<LoadedRenderer> {
  const existing = rendererPromises.get(format);
  if (existing) return existing;

  const promise = Promise.all([
    import('@marginalia/renderer/render'),
    import('@marginalia/renderer/asset-rewrite'),
  ]).then(([renderer, assetRewrite]) => ({
    renderDocument: (source: string, options?: RenderOptions) =>
      renderer.renderDocument(source, format, options),
    rewriteAssetReferences: assetRewrite.rewriteAssetReferences,
  }));

  rendererPromises.set(format, promise);
  promise.catch(() => {
    if (rendererPromises.get(format) === promise) rendererPromises.delete(format);
  });
  return promise;
}
