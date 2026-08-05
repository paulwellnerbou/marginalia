import type { Element, ElementContent, Root } from 'hast';
import { formatAnchorQuote } from '../../lib/anchor-quote.js';
import type { Thread } from '../../lib/api.js';
import { isProposal, proposalStatus } from '../../lib/api.js';

/** What a comment body needs to turn an id it mentions into a link. */
export interface ThreadRefApi {
  /** The thread an id names, or null when nothing on screen matches. */
  resolve: (id: string) => Thread | null;
  /** Scroll to a thread and flash it, like the card header links. */
  focus: (target: Thread) => void;
}

/** Same hash target the per-comment "copy link" button produces. */
const REF_HREF_PREFIX = '#comment-';

export function threadRefHref(id: string): string {
  return `${REF_HREF_PREFIX}${id}`;
}

/** The id a `#comment-<id>` link points at, or null for any other href. */
export function parseThreadRefHref(href: string): string | null {
  return href.startsWith(REF_HREF_PREFIX) ? href.slice(REF_HREF_PREFIX.length) || null : null;
}

/**
 * Index of every id that names a thread — the thread's own id plus the
 * id of each comment in it, since a reply id deep-links to its thread.
 */
export function threadRefIndex(threads: Thread[]): Map<string, Thread> {
  const index = new Map<string, Thread>();
  for (const thread of threads) {
    index.set(thread.id, thread);
    for (const comment of thread.comments) index.set(comment.id, thread);
  }
  return index;
}

export interface ThreadRefSegment {
  text: string;
  /** True when `text` is an id that names a thread. */
  isRef: boolean;
}

/**
 * Split `text` around the ids that name a thread. Returns null when it
 * mentions none, so callers can leave the original node untouched.
 *
 * Ids are 16-char base64url strings (document uids are 22), and the
 * pattern deliberately takes the whole run of id characters: an id
 * glued to a longer token is part of that token, not a reference.
 */
export function splitThreadRefs(
  text: string,
  isRef: (id: string) => boolean,
): ThreadRefSegment[] | null {
  const scan = /[A-Za-z0-9_-]{16,}/g;
  let segments: ThreadRefSegment[] | null = null;
  let cut = 0;
  let match: RegExpExecArray | null = scan.exec(text);
  for (; match !== null; match = scan.exec(text)) {
    if (!isRef(match[0])) continue;
    segments ??= [];
    if (match.index > cut) segments.push({ text: text.slice(cut, match.index), isRef: false });
    segments.push({ text: match[0], isRef: true });
    cut = match.index + match[0].length;
  }
  if (!segments) return null;
  if (cut < text.length) segments.push({ text: text.slice(cut), isRef: false });
  return segments;
}

/**
 * Link the thread ids a comment body mentions. They arrive as bare
 * strings from tool output — "Addressed in edit proposal `abc`" — which
 * leaves the reader to hunt for the thread by hand. Only ids that name
 * a thread are linked, so ordinary prose can never turn into a link.
 */
export function rehypeThreadRefs(isRef: (id: string) => boolean) {
  return () => (tree: Root) => {
    for (const child of tree.children) if (child.type === 'element') linkifyElement(child, isRef);
  };
}

function linkifyElement(el: Element, isRef: (id: string) => boolean): void {
  // Verbatim blocks and existing links keep their text as written.
  if (el.tagName === 'pre' || el.tagName === 'a') return;
  const next: ElementContent[] = [];
  let changed = false;
  for (const child of el.children) {
    if (child.type === 'element') linkifyElement(child, isRef);
    if (child.type !== 'text') {
      next.push(child);
      continue;
    }
    const segments = splitThreadRefs(child.value, isRef);
    if (!segments) {
      next.push(child);
      continue;
    }
    changed = true;
    for (const segment of segments) {
      next.push(segment.isRef ? refLink(segment.text) : { type: 'text', value: segment.text });
    }
  }
  if (changed) el.children = next;
}

function refLink(id: string): Element {
  return {
    type: 'element',
    tagName: 'a',
    properties: { href: threadRefHref(id) },
    children: [{ type: 'text', value: id }],
  };
}

/** Tooltip for a linked id — the reader can't tell threads apart by id. */
export function describeThreadRef(thread: Thread): string {
  const author = thread.comments[0].author.display_name;
  const quote = formatAnchorQuote(thread.anchor.quote, 48);
  const where = quote ? ` on "${quote}"` : '';
  if (!isProposal(thread)) return `Comment by ${author}${where}`;
  const status = proposalStatus(thread);
  return `Edit proposal by ${author}${status === 'open' ? '' : ` (${status})`}${where}`;
}
