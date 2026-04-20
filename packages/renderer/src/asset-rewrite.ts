import { unified } from 'unified';
import rehypeParse from 'rehype-parse';
import rehypeStringify from 'rehype-stringify';
import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';

export interface RewriteOptions {
  /** Document UID — goes into the proxy URL. */
  docUid: string;
  /**
   * The set of ref names currently attached to this document. A ref in
   * source is rewritten to the proxy URL iff it's in this set. Refs not
   * in the set are tagged with `data-missing-asset` so the UI can render
   * a placeholder / dropzone in their place.
   */
  attached: ReadonlySet<string>;
  /** Proxy URL prefix. Defaults to `/api/documents`. */
  apiBase?: string;
}

/**
 * Rewrite `<img src="...">` in already-rendered HTML so images reference
 * the per-document asset proxy. Relative (non-URL) sources get:
 *
 *   - `src` pointed at `<apiBase>/<uid>/assets/<refName>` when attached;
 *   - a `data-missing-asset="<refName>"` marker when not.
 *
 * Absolute URLs (`http:`, `https:`, `//…`, `data:`, `/foo`) pass through
 * unchanged. Runs over a fragment, so surrounding structure is preserved.
 *
 * Called on BOTH sides of the wire: the server applies it before
 * returning rendered HTML, and the edit-page preview applies it to the
 * client-rendered HTML before displaying. That keeps the missing-asset
 * placeholder flow identical in both paths.
 */
export async function rewriteAssetReferences(
  html: string,
  opts: RewriteOptions,
): Promise<string> {
  const base = opts.apiBase ?? '/api/documents';
  const prefix = `${base}/${encodeURIComponent(opts.docUid)}/assets/`;

  const processor = unified()
    .use(rehypeParse, { fragment: true })
    .use(() => (tree: Root) => {
      visit(tree, 'element', (node: Element) => {
        if (node.tagName !== 'img') return;
        const src = getStringProp(node, 'src');
        if (!src || isAbsoluteUrl(src)) return;
        // Must mirror the server's normalizeRefName() in routes/assets.ts:
        // refs that the server would reject (dot segments, backslashes,
        // URL delimiters, empty segments) can't be uploaded or fetched
        // through the proxy. Leaving them unchanged is friendlier than
        // tagging them `data-missing-asset` and showing an editor a
        // dropzone whose upload would always 400.
        if (!isAddressableRefName(src)) return;
        const refName = src;
        const props = { ...(node.properties ?? {}) };
        if (opts.attached.has(refName)) {
          props.src = `${prefix}${encodeRefSegment(refName)}`;
          // Keep the original ref around so the UI can offer "replace".
          props['data-asset-ref'] = refName;
        } else {
          props['data-missing-asset'] = refName;
          // Prevent the browser from trying to fetch the unresolved
          // relative URL before the UI swaps in a placeholder/dropzone.
          props.src = 'data:,';
        }
        node.properties = props;
      });
    })
    .use(rehypeStringify);

  const file = await processor.process(html);
  return String(file);
}

function getStringProp(node: Element, name: string): string | null {
  const v = node.properties?.[name];
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return null;
}

/**
 * A ref is "absolute" (leave alone) if it has a scheme, a protocol-relative
 * prefix, starts from the site root, is a fragment, or is a data/mailto/tel
 * URL. Everything else is treated as a document-local asset reference.
 */
function isAbsoluteUrl(src: string): boolean {
  if (src.startsWith('#')) return true;
  if (src.startsWith('/')) return true;
  if (src.startsWith('//')) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return true;
  return false;
}

/**
 * Mirror of the server's `normalizeRefName()` in routes/assets.ts. Kept
 * as a standalone function (not a shared import) because the renderer
 * package can't depend on the server package. Any change to one must
 * be mirrored in the other — covered by tests on both sides.
 */
function isAddressableRefName(src: string): boolean {
  if (!src || src.length > 200) return false;
  if (src.includes('\\') || src.includes('?') || src.includes('#')) return false;
  return !src
    .split('/')
    .some((seg) => seg === '' || seg === '.' || seg === '..');
}

/**
 * Percent-encode a ref name for URL path use, but keep `/` readable
 * (ref names may contain subpaths like `images/diagram.png`, and they
 * round-trip through `decodeURIComponent` on the server).
 */
function encodeRefSegment(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/');
}
