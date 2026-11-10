import type { DocumentFolder } from './api.js';

/**
 * Links in a document that name another document of its folder —
 * `[outline](OUTLINE)`, `[notes](<My Notes>)`, AsciiDoc's
 * `xref:OUTLINE.adoc[]` — and the `/d/<uid>` route each one leads to.
 *
 * Resolved in the viewer rather than at render time: names change and
 * documents join the folder without the source changing, and the rendered
 * HTML is cached per source.
 */

/** The folder document a link names, and the in-document target it carries. */
export interface FolderLinkTarget {
  uid: string;
  /** `#…` including the hash sign, or empty. */
  hash: string;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Extensions a name may be written with. `.html` is what Asciidoctor turns
 * an `xref:` to an `.adoc` file into.
 */
const EXTENSION = /\.(md|markdown|adoc|asciidoc|asc|html?)$/i;

/** Case, spacing and punctuation folded away, so `my-notes` finds "My Notes". */
function nameKey(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The folder document `href` names, or null when it is not a bare name —
 * an absolute URL, a path, an in-page `#anchor` — or names none.
 * A document's `name` wins over another's title.
 */
export function folderLinkTarget(href: string, folder: DocumentFolder): FolderLinkTarget | null {
  let rest = href.trim();
  if (!rest || SCHEME.test(rest) || /^[/#?]/.test(rest)) return null;
  rest = rest.replace(/^\.\//, '');

  const hashAt = rest.indexOf('#');
  const hash = hashAt >= 0 && hashAt < rest.length - 1 ? rest.slice(hashAt) : '';
  if (hashAt >= 0) rest = rest.slice(0, hashAt);
  // Folders are one level deep, so a path or a query is something else.
  if (!rest || rest.includes('/') || rest.includes('?')) return null;

  let name = rest;
  try {
    name = decodeURIComponent(rest);
  } catch {
    // Malformed escapes: match on the raw text.
  }

  const keys = new Set([nameKey(name), nameKey(name.replace(EXTENSION, ''))]);
  keys.delete('');
  if (keys.size === 0) return null;

  const match =
    folder.documents.find((d) => d.name !== null && keys.has(nameKey(d.name))) ??
    folder.documents.find((d) => d.title !== null && keys.has(nameKey(d.title)));
  return match ? { uid: match.uid, hash } : null;
}

/** Holds the href as written, so a later pass can resolve it again. */
const SOURCE_ATTR = 'data-folder-href';
/** Marks a resolved link: the uid it leads to. */
export const FOLDER_UID_ATTR = 'data-folder-uid';

/**
 * Point every link under `root` that names a folder document at its route,
 * carrying `search` so a view mode set in the address survives. Safe to
 * re-run: a link resolved before is resolved again from what was written,
 * and one whose document left the folder gets its own href back.
 */
export function resolveFolderLinks(
  root: ParentNode,
  folder: DocumentFolder | null | undefined,
  search: string,
): void {
  for (const link of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const written = link.getAttribute(SOURCE_ATTR) ?? link.getAttribute('href') ?? '';
    const target = folder ? folderLinkTarget(written, folder) : null;
    if (target) {
      link.setAttribute(SOURCE_ATTR, written);
      link.setAttribute(FOLDER_UID_ATTR, target.uid);
      link.setAttribute('href', `/d/${target.uid}${search}${target.hash}`);
    } else if (link.hasAttribute(SOURCE_ATTR)) {
      link.setAttribute('href', written);
      link.removeAttribute(SOURCE_ATTR);
      link.removeAttribute(FOLDER_UID_ATTR);
    }
  }
}
