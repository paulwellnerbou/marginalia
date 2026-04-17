import type { Document } from './api.js';

/**
 * Best-effort document title for use as the browser tab title and
 * "Recent documents" card. Precedence:
 *   1. Explicit `doc.name` set on upload or via admin settings
 *   2. `frontmatter.title` if set and a string
 *   3. First heading's text (from rendered.anchors)
 *   4. Short UID as a last resort
 */
export function documentTitle(doc: Document): string {
  if (doc.name && doc.name.trim()) return doc.name.trim();
  const fm = doc.rendered.frontmatter as Record<string, unknown>;
  if (typeof fm.title === 'string' && fm.title.trim()) return fm.title.trim();
  const first = doc.rendered.anchors?.[0];
  if (first?.text) return first.text;
  return doc.uid.slice(0, 8);
}

/**
 * Set `document.title` for the lifetime of the caller, restoring it on
 * cleanup. Intended for use inside a `useEffect`.
 */
export function usePageTitle(title: string): () => void {
  const previous = document.title;
  document.title = title;
  return () => {
    document.title = previous;
  };
}
