import Asciidoctor from '@asciidoctor/core';
import { computeSubBlockId, hashBlock, normalizeBlockText } from './block-ids-shared.js';
import type { BlockSourceRange } from './locate-block.js';

declare global {
  var __asciidoctor: ReturnType<typeof Asciidoctor> | undefined;
}

const asciidoctor = globalThis.__asciidoctor ?? Asciidoctor();
globalThis.__asciidoctor = asciidoctor;

/**
 * AsciiDoc twin of `locateAllBlocks` — resolve block IDs back to source
 * ranges so the server can apply edit proposals. IDs must match what
 * `renderAsciidoc`'s walk produces, so both paths go through the same
 * `hashBlock(kind, normalizedText)` recipe on the same AST.
 */
export function locateAllBlocksAsciidoc(source: string): Map<string, BlockSourceRange> {
  const doc = asciidoctor.load(source, {
    safe: 'safe',
    standalone: false,
    sourcemap: true,
  });

  const out = new Map<string, BlockSourceRange>();
  walkTopLevel(doc, source, out);
  walkSubBlocks(doc, source, out);
  return out;
}

/**
 * AsciiDoc twin of `locateBlockRange`. Same min/max merge semantics:
 * the returned range covers everything from the earlier block's start
 * to the later block's end (in source order). Inter-block whitespace
 * is included so a server-side splice replaces the whole span atomically.
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
  const start = Math.min(a.start, b.start);
  const end = Math.max(a.end, b.end);
  return { start, end, kind: 'multi', text: source.slice(start, end) };
}

/**
 * Mirror `walkSubBlocks` in render-asciidoc.ts: walk ulist/olist items
 * in document order and map their content-hash IDs back to source
 * ranges. IDs use `computeSubBlockId('listItem', text, counts)` with a
 * fresh counts Map, matching the renderer's state exactly.
 */
function walkSubBlocks(block: Any, source: string, out: Map<string, BlockSourceRange>): void {
  const counts = new Map<string, number>();
  visit(block);

  function visit(b: Any): void {
    const ctx = (b as { getContext?: () => string | undefined }).getContext?.();
    if (ctx === 'ulist' || ctx === 'olist') {
      const items = (b as { getItems?: () => Any[] | undefined }).getItems?.() ?? [];
      for (const item of items) {
        recordSubBlockRange(item, source, counts, out);
        visit(item);
      }
      return;
    }
    for (const child of getChildren(b)) {
      if (!child || typeof (child as { getContext?: unknown }).getContext !== 'function') continue;
      visit(child);
    }
  }
}

function recordSubBlockRange(
  item: Any,
  source: string,
  counts: Map<string, number>,
  out: Map<string, BlockSourceRange>,
): void {
  // Mirror the renderer: pull the item's own text from getText()
  // (getContent() yields nested-block HTML and is empty for leaf items).
  const fn = (item as { getText?: () => string | undefined }).getText;
  const raw = typeof fn === 'function' ? (fn.call(item) ?? '') : '';
  const text = normalizeBlockText(stripTags(raw));
  if (!text) return;
  const id = computeSubBlockId('listItem', text, counts);
  const range = listItemSourceRange(item, source);
  if (!range) return;
  // Every occurrence gets its own entry — counts suffixes duplicates
  // with `#2`, `#3`, …, so ids remain unique.
  out.set(id, { ...range, kind: 'listItem', text });
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

type Any = unknown;

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

function walkTopLevel(block: Any, source: string, out: Map<string, BlockSourceRange>): void {
  const ctx = (block as { getContext(): string }).getContext?.();
  if (ctx === 'document' || ctx === 'preamble') {
    for (const child of getChildren(block)) walkTopLevel(child, source, out);
    return;
  }
  if (ctx === 'section') {
    recordHeading(block, source, out);
    for (const child of getChildren(block)) walkTopLevel(child, source, out);
    return;
  }
  recordLeaf(block, ctx ?? '', source, out);
}

function recordHeading(block: Any, source: string, out: Map<string, BlockSourceRange>): void {
  const title = getTitle(block) ?? '';
  const text = normalizeBlockText(title);
  const range = sourceRange(block, source, /* titleOnly */ true);
  const id = hashBlock('heading', text);
  if (!out.has(id) && range) out.set(id, { ...range, kind: 'heading', text });
}

function recordLeaf(
  block: Any,
  ctx: string,
  source: string,
  out: Map<string, BlockSourceRange>,
): void {
  const text = normalizeBlockText(extractBlockText(block));
  if (!text && ctx !== 'thematic_break' && ctx !== 'page_break') return;
  const range = sourceRange(block, source, false);
  if (!range) return;
  const id = hashBlock(ctx, text);
  if (!out.has(id)) out.set(id, { ...range, kind: ctx, text });
}

function getChildren(block: Any): Any[] {
  const fn = (block as { getBlocks?: () => Any[] }).getBlocks;
  if (typeof fn !== 'function') return [];
  return fn.call(block) ?? [];
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
