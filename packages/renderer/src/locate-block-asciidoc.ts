import Asciidoctor from '@asciidoctor/core';
import {
  type BlockSection,
  computeSubBlockId,
  hashBlock,
  normalizeBlockText,
  SectionTracker,
} from './block-ids-shared.js';
import {
  addOccurrence,
  type BlockSourceRange,
  canMergeMultiBlock,
  type LocatedBlocks,
} from './locate-block.js';

declare global {
  var __asciidoctor: ReturnType<typeof Asciidoctor> | undefined;
}

const asciidoctor = globalThis.__asciidoctor ?? Asciidoctor();
globalThis.__asciidoctor = asciidoctor;

/**
 * AsciiDoc twin of `locateBlocks` — resolve block IDs back to source
 * ranges so the server can apply edit proposals. IDs must match what
 * `renderAsciidoc`'s walk produces, so both paths go through the same
 * `hashBlock(kind, normalizedText)` recipe on the same AST, and both
 * number blocks through the same `SectionTracker` so each copy of a
 * repeated block carries the section context the renderer gave it.
 */
export function locateBlocksAsciidoc(source: string): LocatedBlocks {
  const doc = asciidoctor.load(source, {
    safe: 'safe',
    standalone: false,
    sourcemap: true,
  });

  const state: WalkState = {
    source,
    out: { byId: new Map(), occurrences: new Map() },
    sections: new SectionTracker(),
    subBlockCounts: new Map(),
  };
  walkTopLevel(doc, state);
  return state.out;
}

/** Every block's id → source range, first occurrence winning. See `locateBlocksAsciidoc`. */
export function locateAllBlocksAsciidoc(source: string): Map<string, BlockSourceRange> {
  return locateBlocksAsciidoc(source).byId;
}

/**
 * AsciiDoc twin of `locateBlockRange`. Same min/max merge semantics:
 * the returned range covers everything from the earlier block's start
 * to the later block's end (in source order). Inter-block whitespace
 * is included so a server-side splice replaces the whole span atomically.
 *
 * `text` is intentionally '' for multi-block (matches the markdown
 * twin); callers slice `source` with `start`/`end` themselves.
 *
 * Validation goes through the shared `canMergeMultiBlock` predicate,
 * with one asciidoc-only difference: `listItem` is always rejected
 * because `listItemSourceRange` is best-effort (single line, no
 * continuation `+` lines), and we don't populate `parentStart` for
 * asciidoc list items — so the markdown same-parent path can't admit
 * them either. Re-allow once continuations are supported.
 */
export function locateBlockRangeAsciidoc(
  source: string,
  startId: string,
  endId: string | null,
): BlockSourceRange | null {
  const all = locateAllBlocksAsciidoc(source);
  const a = all.get(startId);
  if (!a) return null;
  if (!endId || endId === startId) return a;
  const b = all.get(endId);
  if (!b) return null;
  if (!canMergeMultiBlock(a, b, 'asciidoc')) return null;
  const start = Math.min(a.start, b.start);
  const end = Math.max(a.end, b.end);
  return { start, end, kind: 'multi', text: '' };
}

type Any = unknown;

interface WalkState {
  source: string;
  out: LocatedBlocks;
  sections: SectionTracker;
  /**
   * One counts map for the whole document, as the renderer keeps, so
   * `computeSubBlockId` suffixes duplicate items identically here.
   */
  subBlockCounts: Map<string, number>;
}

/**
 * Mirror `walkTopLevel` in render-asciidoc.ts: sections open a heading
 * and recurse, everything else is a leaf that is recorded and then
 * searched for list items, which inherit its section context.
 */
function walkTopLevel(block: Any, state: WalkState): void {
  const ctx = getContext(block) ?? '';
  if (ctx === 'document' || ctx === 'preamble') {
    for (const child of getChildren(block)) walkTopLevel(child, state);
    return;
  }
  if (ctx === 'section') {
    recordHeading(block, state);
    for (const child of getChildren(block)) walkTopLevel(child, state);
    return;
  }
  recordLeaf(block, ctx, state);
}

function recordHeading(block: Any, state: WalkState): void {
  const text = normalizeBlockText(getTitle(block) ?? '');
  state.sections.enterHeading(getLevel(block), text);
  const section = state.sections.next();
  const range = sourceRange(block, state.source, /* titleOnly */ true);
  if (!range) return;
  addOccurrence(
    state.out,
    hashBlock('heading', text),
    { ...range, kind: 'heading', text },
    section,
  );
}

function recordLeaf(block: Any, ctx: string, state: WalkState): void {
  if (ctx === 'thematic_break' || ctx === 'page_break') {
    const section = state.sections.next();
    const range = sourceRange(block, state.source, false);
    if (range)
      addOccurrence(state.out, hashBlock(ctx, ''), { ...range, kind: ctx, text: '' }, section);
    return;
  }
  const text = normalizeBlockText(extractBlockText(block));
  // The renderer records, and so numbers, a leaf only when it has text; a
  // textless list still lends its items the position it stands at.
  const section = text ? state.sections.next() : state.sections.peek();
  if (text) {
    const range = sourceRange(block, state.source, false);
    if (range)
      addOccurrence(state.out, hashBlock(ctx, text), { ...range, kind: ctx, text }, section);
  }
  if (ctx === 'ulist' || ctx === 'olist') recordListItems(block, section, state);
  else recordNestedLists(block, section, state);
}

/**
 * Mirror `emitListSubBlocks` / `descendForNestedLists` in
 * render-asciidoc.ts: ulist/olist items in document order, each recorded
 * and then searched for nested lists. Same visit order and the same
 * counts map, so every item's id matches the renderer's.
 */
function recordListItems(list: Any, section: BlockSection, state: WalkState): void {
  for (const item of getItems(list)) {
    recordListItem(item, section, state);
    recordNestedLists(item, section, state);
  }
}

function recordNestedLists(block: Any, section: BlockSection, state: WalkState): void {
  for (const child of getChildren(block)) {
    const ctx = getContext(child);
    if (ctx === undefined) continue;
    if (ctx === 'ulist' || ctx === 'olist') recordListItems(child, section, state);
    else recordNestedLists(child, section, state);
  }
}

function recordListItem(item: Any, section: BlockSection, state: WalkState): void {
  // Mirror the renderer: pull the item's own text from getText()
  // (getContent() yields nested-block HTML and is empty for leaf items).
  const fn = (item as { getText?: () => string | undefined }).getText;
  const raw = typeof fn === 'function' ? (fn.call(item) ?? '') : '';
  const text = normalizeBlockText(stripTags(raw));
  if (!text) return;
  const id = computeSubBlockId('listItem', text, state.subBlockCounts);
  const range = listItemSourceRange(item, state.source);
  if (!range) return;
  // Intentionally NOT setting `parentStart`: the multi-listItem path
  // is unsafe in asciidoc (best-effort `listItemSourceRange` doesn't
  // cover continuation lines), and `canMergeMultiBlock` rejects
  // asciidoc listItems explicitly via its `format` argument. Don't
  // start populating `parentStart` here without first making
  // continuation ranges accurate.
  addOccurrence(state.out, id, { ...range, kind: 'listItem', text }, section);
}

/**
 * Best-effort: return the source range for a single list item. We use
 * `getLineNumber()` for the start and, for now, end at the start of
 * the following source line. This is intentionally conservative:
 * multi-line list items are not fully covered yet because asciidoctor's
 * AST does not expose a reliable end position for item continuations.
 * A looser heuristic is fine here — edit proposals only target leaf
 * list items, and asciidoctor's own source map for items is
 * line-accurate at the start.
 */
function listItemSourceRange(item: Any, source: string): { start: number; end: number } | null {
  const lineNoFn = (item as { getLineNumber?: () => number | undefined }).getLineNumber;
  const startLine = typeof lineNoFn === 'function' ? lineNoFn.call(item) : undefined;
  if (!startLine) return null;

  const idx = getLineIndex(source);
  const startOffset = idx.starts[startLine - 1];
  if (startOffset === undefined) return null;

  // Fallback end: start of the line AFTER startLine. For multi-line
  // items we'd ideally extend to the last continuation line; leaving
  // that for a future pass since asciidoctor's AST doesn't expose it
  // cleanly.
  const endOffset = idx.starts[startLine] ?? idx.total;
  return { start: startOffset, end: endOffset };
}

interface LineIndex {
  // 1-based line N → byte offset of start of that line in source
  readonly starts: readonly number[];
  readonly total: number;
}

function buildLineIndex(source: string): LineIndex {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 0x0a) starts.push(i + 1);
  }
  return { starts, total: source.length };
}

let cachedLineIndex: { source: string; index: LineIndex } | null = null;
function getLineIndex(source: string): LineIndex {
  if (cachedLineIndex && cachedLineIndex.source === source) return cachedLineIndex.index;
  const idx = buildLineIndex(source);
  cachedLineIndex = { source, index: idx };
  return idx;
}

function getContext(block: Any): string | undefined {
  const fn = (block as { getContext?: () => string | undefined } | null)?.getContext;
  return typeof fn === 'function' ? fn.call(block) : undefined;
}

function getChildren(block: Any): Any[] {
  const fn = (block as { getBlocks?: () => Any[] }).getBlocks;
  if (typeof fn !== 'function') return [];
  return fn.call(block) ?? [];
}

function getItems(list: Any): Any[] {
  const fn = (list as { getItems?: () => Any[] | undefined }).getItems;
  if (typeof fn !== 'function') return [];
  return fn.call(list) ?? [];
}

function getLevel(block: Any): number {
  const fn = (block as { getLevel?: () => number }).getLevel;
  return typeof fn === 'function' ? fn.call(block) : 1;
}

function getTitle(block: Any): string | null {
  const fn = (block as { getTitle?: () => string | undefined }).getTitle;
  if (typeof fn !== 'function') return null;
  return fn.call(block) ?? null;
}

function extractBlockText(block: Any): string {
  const contentFn = (block as { getContent?: () => string | undefined }).getContent;
  if (typeof contentFn === 'function') {
    try {
      const html = contentFn.call(block);
      if (typeof html === 'string' && html.length > 0) return stripTags(html);
    } catch {
      /* fall through */
    }
  }
  const sourceFn = (block as { getSource?: () => string | undefined }).getSource;
  if (typeof sourceFn === 'function') {
    const src = sourceFn.call(block);
    if (typeof src === 'string') return src;
  }
  const linesFn = (block as { getSourceLines?: () => string[] | undefined }).getSourceLines;
  if (typeof linesFn === 'function') {
    const lines = linesFn.call(block);
    if (Array.isArray(lines)) return lines.join('\n');
  }
  return '';
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

/**
 * Best-effort: translate asciidoctor's source map (1-based start line) into
 * byte offsets. Section "heading only" narrows to the single title line.
 * Regular blocks span the lines returned by `getSourceLines()`. Delimited
 * compound blocks — admonition/example/sidebar/quote/openblock/verse
 * styled with `====` / `****` / `____` / `--` / etc. — have no direct
 * source lines on the wrapper (content lives on the child paragraphs)
 * and `getLineNumber()` points at the opening delimiter, so we scan the
 * source forward for the matching closing delimiter to cover the whole
 * block end-to-end.
 */
function sourceRange(
  block: Any,
  source: string,
  titleOnly: boolean,
): { start: number; end: number } | null {
  const lineNoFn = (block as { getLineNumber?: () => number | undefined }).getLineNumber;
  const sourceLocFn = (
    block as { getSourceLocation?: () => { getLineNumber?: () => number } | undefined }
  ).getSourceLocation;
  let startLine: number | undefined;
  if (typeof lineNoFn === 'function') startLine = lineNoFn.call(block);
  if (!startLine && typeof sourceLocFn === 'function') {
    const loc = sourceLocFn.call(block);
    startLine = loc?.getLineNumber?.();
  }
  if (!startLine) return null;

  const idx = getLineIndex(source);
  const startOffset = idx.starts[startLine - 1];
  if (startOffset === undefined) return null;

  if (titleOnly) {
    const nextLineStart = idx.starts[startLine] ?? idx.total;
    return { start: startOffset, end: nextLineStart };
  }

  const linesFn = (block as { getSourceLines?: () => string[] | undefined }).getSourceLines;
  const lines = typeof linesFn === 'function' ? (linesFn.call(block) ?? []) : [];
  const lineCount = Array.isArray(lines) ? lines.length : 0;

  if (lineCount > 0) {
    const endLine = startLine + lineCount;
    const endOffset = idx.starts[endLine] ?? idx.total;
    return { start: startOffset, end: endOffset };
  }

  // Compound delimited block: asciidoctor reports zero own-lines and
  // points at the delimiter. Scan forward for a line matching the same
  // delimiter. Supported:
  //   `====`  — example / admonition (block form)
  //   `****`  — sidebar
  //   `____`  — quote / verse
  //   `----`  — listing (only reaches here if the block had no source
  //             lines, which is rare but possible)
  //   `....`  — literal
  //   `++++`  — passthrough
  //   `--`    — open block (the only two-char delimiter)
  const openingLine = readLine(source, idx, startLine);
  const delim = openingLine.trim();
  const isDelimiter = delim === '--' || /^([=\-*._+])\1{3,}$/.test(delim);
  if (isDelimiter) {
    for (let i = startLine + 1; i <= idx.starts.length; i++) {
      const candidate = readLine(source, idx, i).trim();
      if (candidate === delim) {
        const endOffset = idx.starts[i] ?? idx.total;
        return { start: startOffset, end: endOffset };
      }
    }
    // No matching closer found — fall back to EOF rather than emitting
    // just the opening delimiter line (which is what the composer
    // otherwise renders for a malformed doc).
    return { start: startOffset, end: idx.total };
  }

  // Non-delimited zero-lines block: best we can do is the single line.
  const nextLineStart = idx.starts[startLine] ?? idx.total;
  return { start: startOffset, end: nextLineStart };
}

function readLine(source: string, idx: LineIndex, oneBasedLine: number): string {
  const from = idx.starts[oneBasedLine - 1];
  if (from === undefined) return '';
  const to = idx.starts[oneBasedLine] ?? idx.total;
  return source.slice(from, to).replace(/\r?\n$/, '');
}
