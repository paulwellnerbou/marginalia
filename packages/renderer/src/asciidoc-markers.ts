/**
 * Shared symbols used by the AsciiDoc renderer AND the block-ids rehype
 * plugin. Lives in its own tiny module to break the circular import
 * between them — without this, `render-asciidoc.ts` imports
 * `plugins/asciidoc-block-ids.ts` (to use the plugin) and the plugin
 * imports `render-asciidoc.ts` (to get these constants), which ESM
 * allows but is fragile and can trip up some bundlers.
 *
 * The marker classes themselves are written during the pre-render AST
 * walk and stripped during the post-render hast pass; they never reach
 * the sanitized output. Changing the prefix strings would invalidate
 * any in-flight render but not any stored data.
 */

export const MARGINALIA_BLOCK_MARKER_PREFIX = '__marginalia-block-';
export const MARGINALIA_SUBBLOCK_MARKER_PREFIX = '__marginalia-subblock-';

/** IDs for list-item sub-blocks emitted by the AST walk, indexed by
 *  their `__marginalia-subblock-<N>` marker. Shared with the hast pass
 *  so both walks agree on which `<li>` gets which `data-subblock`. */
export interface SubBlockEntry {
  id: string;
}
