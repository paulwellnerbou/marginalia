import { defaultSchema } from 'rehype-sanitize';
import type { Schema } from 'hast-util-sanitize';

const base = defaultSchema as Schema;
const baseAttrs = (base.attributes ?? {}) as Record<string, Array<string | [string, ...Array<string | number | boolean>]>>;

/**
 * Extends the rehype-sanitize default schema:
 * - id and className allowed on every element (themes + anchors)
 * - any data-* attribute allowed (block IDs, mermaid metadata)
 * - target/rel on links
 * - align on th/td (GFM-style column alignment)
 * - SVG output tags from SSR mermaid preserved
 */
export const sanitizeSchema: Schema = {
  ...base,
  // Our slugger already produces Unicode-safe, deterministic IDs; we don't
  // want the sanitizer prefixing them with "user-content-" and breaking TOC
  // links.
  clobberPrefix: '',
  clobber: [],
  attributes: {
    ...baseAttrs,
    '*': [...(baseAttrs['*'] ?? []), 'className', 'id', 'data*', 'ariaLabel', 'ariaHidden'],
    // Drop the default schema's restrictive `[['className', 'anchor']]` for
    // <a> so our heading-anchor class (and any user theme classes) survive.
    a: [
      ...(baseAttrs.a ?? []).filter(
        (entry) => !(Array.isArray(entry) && entry[0] === 'className'),
      ),
      'className',
      'target',
      'rel',
      'ariaLabel',
    ],
    th: [...(baseAttrs.th ?? []), 'align'],
    td: [...(baseAttrs.td ?? []), 'align'],
    pre: [...(baseAttrs.pre ?? []), 'className', 'style', 'data*'],
    code: [...(baseAttrs.code ?? []), 'className', 'style'],
    span: [...(baseAttrs.span ?? []), 'className', 'style'],
  },
  tagNames: [
    ...(base.tagNames ?? []),
    'svg',
    'g',
    'path',
    'circle',
    'rect',
    'line',
    'polyline',
    'polygon',
    'text',
    'tspan',
    'defs',
    'marker',
    'foreignObject',
    'title',
    'desc',
  ],
};
