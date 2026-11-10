import type { Element, ElementContent, Root, RootContent } from 'hast';
import rehypeParse from 'rehype-parse';
import { unified } from 'unified';
import {
  type BlockSection,
  hashBlock,
  normalizeBlockText,
  SectionTracker,
} from './block-ids-shared.js';

/**
 * The block model of an HTML document, shared by `renderHtml` (which
 * writes `data-block` onto the elements) and `locateBlocksHtml` (which
 * maps an id back to a source range for edit proposals). Both parse the
 * source with `parseHtmlSource` and walk it with `walkHtmlBlocks`, so the
 * two can't number blocks differently.
 *
 * Markdown has a block structure the author spelled out; HTML only has
 * elements, most of them layout. A block here is the innermost element
 * that holds text of its own: a `<p>`, a `<td>`, a `<div class="num">`.
 * Wrappers whose text all sits in child blocks (`<section>`, `<tr>`, a
 * grid of cards) are walked through. Blocks never nest, so a selection
 * always lands in exactly one block per text node.
 */

/**
 * Elements whose content is never document text. The renderer drops them
 * and the sanitizer strips them, so the block walk has to skip exactly
 * these or an id would hash text the page never shows.
 */
export const NON_CONTENT_TAGS: readonly string[] = [
  'script',
  'style',
  'template',
  'noscript',
  'head',
  'title',
  'meta',
  'link',
  'base',
  'iframe',
  'object',
  'embed',
];
const NON_CONTENT = new Set(NON_CONTENT_TAGS);

/**
 * Phrasing (inline) elements: their text belongs to the enclosing block.
 * CSS can lay any of them out as a block, but going by the tag keeps the
 * model stable under style edits.
 */
const PHRASING = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'big',
  'br',
  'button',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'mark',
  'math',
  'meter',
  'output',
  'picture',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'select',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'svg',
  'textarea',
  'time',
  'tt',
  'u',
  'var',
  'wbr',
]);

const HEADING_RE = /^h([1-6])$/;

export interface HtmlBlock {
  node: Element;
  id: string;
  kind: string;
  /** Normalized source-tree text, the string `id` was hashed from. */
  text: string;
  section: BlockSection;
  /** Heading level, for heading blocks only. */
  level?: number;
}

/** Parse a whole document or a fragment; both end up under `<html><body>`. */
export function parseHtmlSource(source: string): Root {
  return unified().use(rehypeParse, { fragment: false }).parse(source) as Root;
}

export function findElement(parent: Root | Element, tagName: string): Element | null {
  for (const child of parent.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === tagName) return child;
    const found = findElement(child, tagName);
    if (found) return found;
  }
  return null;
}

export function isNonContent(node: Element): boolean {
  return NON_CONTENT.has(node.tagName);
}

/** Every block of the document body, in document order. */
export function walkHtmlBlocks(tree: Root): HtmlBlock[] {
  const body = findElement(tree, 'body');
  const out: HtmlBlock[] = [];
  if (!body) return out;
  const sections = new SectionTracker();

  const visitContainer = (el: Element): void => {
    for (const child of el.children) {
      if (child.type !== 'element' || isNonContent(child)) continue;
      visitElement(child);
    }
  };

  const visitElement = (el: Element): void => {
    if (PHRASING.has(el.tagName)) {
      // Loose inline content between blocks has no element of its own to
      // anchor to; only blocks a phrasing element wraps (`<a><div>`) count.
      visitContainer(el);
      return;
    }
    const level = headingLevel(el);
    const own = hasOwnText(el);
    // A wrapper with text of its own becomes one block — unless it holds a
    // heading, which the outline needs to see on its own.
    if (!own || (level === null && containsHeading(el))) {
      visitContainer(el);
      return;
    }
    const text = normalizeBlockText(textOf(el));
    if (!text) return;
    const kind = kindOf(el, level);
    if (level !== null) sections.enterHeading(level, text);
    out.push({
      node: el,
      id: hashBlock(kind, text),
      kind,
      text,
      section: sections.next(),
      ...(level !== null ? { level } : {}),
    });
  };

  visitContainer(body);
  return out;
}

function headingLevel(el: Element): number | null {
  const m = HEADING_RE.exec(el.tagName);
  return m ? Number(m[1]) : null;
}

function kindOf(el: Element, level: number | null): string {
  if (level !== null) return 'heading';
  switch (el.tagName) {
    case 'p':
      return 'paragraph';
    case 'pre':
      return 'code';
    case 'blockquote':
      return 'blockquote';
    case 'li':
    case 'dt':
    case 'dd':
      return 'item';
    case 'td':
    case 'th':
      return 'cell';
    default:
      return 'block';
  }
}

/** Whether `el` holds non-blank text outside any child block. */
function hasOwnText(el: Element): boolean {
  for (const child of el.children) {
    if (child.type === 'text') {
      if (child.value.trim()) return true;
    } else if (child.type === 'element' && !isNonContent(child) && PHRASING.has(child.tagName)) {
      if (hasOwnText(child)) return true;
    }
  }
  return false;
}

function containsHeading(el: Element): boolean {
  for (const child of el.children) {
    if (child.type !== 'element' || isNonContent(child)) continue;
    if (HEADING_RE.test(child.tagName) || containsHeading(child)) return true;
  }
  return false;
}

/** Concatenated text, skipping `<style>` and friends. */
export function textOf(node: Root | RootContent | ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element' && isNonContent(node)) return '';
  if (!('children' in node)) return '';
  let out = '';
  for (const child of node.children) out += textOf(child);
  return out;
}

/** Where `el` ends in the source, falling back to its last positioned descendant. */
export function sourceEnd(el: Element): number | undefined {
  const end = el.position?.end?.offset;
  if (end !== undefined) return end;
  for (let i = el.children.length - 1; i >= 0; i--) {
    const child = el.children[i]!;
    const childEnd = child.type === 'element' ? sourceEnd(child) : child.position?.end?.offset;
    if (childEnd !== undefined) return childEnd;
  }
  return el.position?.start?.offset;
}
