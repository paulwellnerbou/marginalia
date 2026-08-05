/**
 * Turns the rendered article into an ordered list of speakable segments.
 *
 * Segments are anchored by their block element plus a character range
 * *within that block's collected text*, never by a live `Range`.
 * Comment and search highlighting both wrap matches in `<mark>`, which
 * splits the text nodes underneath them — a Range captured beforehand
 * would survive as an object but point into the wrong offsets. Ranges
 * are therefore rebuilt from offsets immediately before use, against
 * whatever the DOM looks like at that moment.
 */

/**
 * Longest text handed to a single utterance. Chrome's synthesis
 * watchdog cuts off after roughly 15 s of continuous speech; ~200
 * characters at the default rate stays comfortably under that, so
 * splitting long sentences here doubles as the workaround.
 */
export const MAX_SEGMENT_CHARS = 200;

/** Subtrees whose text is never spoken. */
const SKIP_SELECTOR = [
  // Source text of a diagram before mermaid swaps it for SVG, plus the
  // SVG internals afterwards.
  '[data-block-kind="mermaid"]',
  '.mermaid',
  // Code blocks read terribly as prose.
  'pre',
  // The `#` permalink sigil prepended to every heading, which would
  // otherwise be spoken as "number sign" before each title.
  '.heading-anchor',
  // Chevron button injected by heading-collapse.
  '.heading-collapse-toggle',
  // Editor affordance, not document content.
  '.missing-asset',
].join(', ');

/**
 * Elements that start a new segment group. `[data-block]` /
 * `[data-subblock]` come from the renderer; the tag fallbacks catch
 * AsciiDoc output that the block-id plugins leave unmarked. `closest`
 * returns the *nearest* match, so a list item inside a marked list
 * correctly groups on the item.
 */
const GROUP_SELECTOR = [
  '[data-block]',
  '[data-subblock]',
  'p',
  'li',
  'td',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'dd',
  'dt',
  'figcaption',
].join(', ');

export interface TextSpan {
  text: string;
  start: number;
  end: number;
}

export interface ReadAloudSegment extends TextSpan {
  /** Stable id across the sequence, for React keys and progress. */
  id: string;
  /** The element this segment's offsets are relative to. */
  blockEl: HTMLElement;
  /** `data-block` / `data-subblock` id, when the renderer emitted one. */
  blockId: string | null;
}

/** Walk `root` and produce every speakable segment, in reading order. */
export function collectSegments(root: HTMLElement, lang: string): ReadAloudSegment[] {
  const segments: ReadAloudSegment[] = [];

  for (const group of collectGroups(root)) {
    for (const span of splitIntoSentences(group.text, lang)) {
      segments.push({
        ...span,
        id: `read-aloud-${segments.length}`,
        blockEl: group.el,
        blockId: group.el.dataset.block ?? group.el.dataset.subblock ?? null,
      });
    }
  }

  return segments;
}

/**
 * Rebuild a live `Range` for `segment` from the current DOM. Returns
 * null when the block is gone (document edited underneath us) or the
 * offsets no longer fit — callers treat that as "skip this segment".
 */
export function resolveSegmentRange(root: HTMLElement, segment: ReadAloudSegment): Range | null {
  if (!root.contains(segment.blockEl)) return null;

  const nodes = collectGroupTextNodes(root, segment.blockEl);
  const start = locateOffset(nodes, segment.start);
  const end = locateOffset(nodes, segment.end);
  if (!start || !end) return null;

  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

interface Group {
  el: HTMLElement;
  text: string;
}

function collectGroups(root: HTMLElement): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;

  for (const node of walkTextNodes(root)) {
    const el = nearestGroupElement(node, root);
    if (!el) continue;
    if (!current || current.el !== el) {
      current = { el, text: '' };
      groups.push(current);
    }
    current.text += node.data;
  }

  return groups;
}

/**
 * Text nodes belonging to `groupEl` itself — nodes that sit inside a
 * *nested* group are excluded, so offsets match what `collectGroups`
 * accumulated for this element.
 */
function collectGroupTextNodes(root: HTMLElement, groupEl: HTMLElement): Text[] {
  const nodes: Text[] = [];
  for (const node of walkTextNodes(groupEl)) {
    if (nearestGroupElement(node, root) !== groupEl) continue;
    nodes.push(node);
  }
  return nodes;
}

function* walkTextNodes(root: HTMLElement): Generator<Text> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      return parent.closest(SKIP_SELECTOR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    yield node as Text;
  }
}

function nearestGroupElement(node: Text, root: HTMLElement): HTMLElement | null {
  const parent = node.parentElement;
  if (!parent) return null;
  const match = parent.closest<HTMLElement>(GROUP_SELECTOR);
  // Stay inside the article: `closest` would happily walk out of it.
  if (match && root.contains(match)) return match;
  return root.contains(parent) ? root : null;
}

function locateOffset(nodes: Text[], offset: number): { node: Text; offset: number } | null {
  let consumed = 0;
  for (const node of nodes) {
    const length = node.data.length;
    if (offset <= consumed + length) return { node, offset: offset - consumed };
    consumed += length;
  }
  const last = nodes[nodes.length - 1];
  return last ? { node: last, offset: last.data.length } : null;
}

/**
 * Split `text` into speakable spans. Sentence boundaries come from
 * `Intl.Segmenter` — it knows that "z. B." and "Dr. Meier" are not
 * sentence ends, which a punctuation regex does not. Spans without any
 * letter or digit (bullets, rules, stray punctuation) are dropped, and
 * over-long ones are subdivided.
 */
export function splitIntoSentences(text: string, lang: string): TextSpan[] {
  // A line break inside a paragraph is only whitespace once rendered,
  // but UAX #29 makes it a sentence terminator — so hard-wrapped
  // markdown (any author wrapping at 80 columns) would otherwise be
  // read out in mid-sentence fragments. Flattening every whitespace
  // character to a plain space fixes that, and because the
  // substitution is one-for-one the offsets still address the caller's
  // original string.
  const flat = text.replace(/\s/gu, ' ');
  const spans: TextSpan[] = [];

  for (const raw of rawSentences(flat, lang)) {
    const trimmed = trimSpan(flat, raw.start, raw.end);
    if (!trimmed || !hasSpeakableContent(trimmed.text)) continue;
    for (const capped of capSpan(flat, trimmed)) {
      if (hasSpeakableContent(capped.text)) spans.push(capped);
    }
  }

  return spans;
}

type SegmenterCtor = new (
  locale: string,
  options: { granularity: 'sentence' },
) => { segment(input: string): Iterable<{ segment: string; index: number }> };

function rawSentences(text: string, lang: string): TextSpan[] {
  const ctor = (Intl as unknown as { Segmenter?: SegmenterCtor }).Segmenter;
  if (ctor) {
    try {
      const segmenter = new ctor(lang, { granularity: 'sentence' });
      const spans: TextSpan[] = [];
      for (const part of segmenter.segment(text)) {
        spans.push({
          text: part.segment,
          start: part.index,
          end: part.index + part.segment.length,
        });
      }
      return spans;
    } catch {
      // Unsupported locale tag — fall through to the regex split.
    }
  }

  const spans: TextSpan[] = [];
  const boundary = /[^.!?…]*[.!?…]+[\s]*|[^.!?…]+$/gu;
  for (const match of text.matchAll(boundary)) {
    const start = match.index ?? 0;
    spans.push({ text: match[0], start, end: start + match[0].length });
  }
  return spans;
}

function trimSpan(source: string, start: number, end: number): TextSpan | null {
  let from = start;
  let to = end;
  while (from < to && /\s/u.test(source[from] ?? '')) from++;
  while (to > from && /\s/u.test(source[to - 1] ?? '')) to--;
  if (to <= from) return null;
  return { text: source.slice(from, to), start: from, end: to };
}

function hasSpeakableContent(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

function capSpan(source: string, span: TextSpan): TextSpan[] {
  if (span.text.length <= MAX_SEGMENT_CHARS) return [span];

  const out: TextSpan[] = [];
  let start = span.start;

  while (span.end - start > MAX_SEGMENT_CHARS) {
    const cut = findCut(source, start, start + MAX_SEGMENT_CHARS);
    const piece = trimSpan(source, start, cut);
    if (piece) out.push(piece);
    // A cut that fails to advance would spin forever; force progress.
    start = cut > start ? cut : start + MAX_SEGMENT_CHARS;
  }

  const tail = trimSpan(source, start, span.end);
  if (tail) out.push(tail);
  return out;
}

/**
 * Pick a break point at or before `limit`: a clause boundary if there
 * is one, otherwise the last word boundary, otherwise a hard cut.
 */
function findCut(source: string, start: number, limit: number): number {
  for (let i = limit; i > start; i--) {
    const char = source[i - 1] ?? '';
    if (/[,;:)\]—–]/u.test(char) && /\s/u.test(source[i] ?? ' ')) return i;
  }
  for (let i = limit; i > start; i--) {
    if (/\s/u.test(source[i - 1] ?? '')) return i;
  }
  return limit;
}
