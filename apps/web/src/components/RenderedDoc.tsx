import { useEffect, useRef, useState, type RefObject } from 'react';
import type { RenderResult } from '@marginalia/renderer';
import { renderMermaidIn } from '../lib/mermaid.js';
import { ImageLightbox, type LightboxImage } from './ImageLightbox.js';

interface RenderedDocProps {
  rendered: Pick<RenderResult, 'html'>;
  /** Optional external ref — lets the parent reach the article DOM node. */
  elRef?: RefObject<HTMLElement | null>;
  /** Max reading column width, in `ch`. Overrides the theme default. */
  maxWidthCh?: number;
  /** Multiplier applied to the active theme's base text size. */
  textZoom?: number;
  /** Exact text ranges to keep visibly highlighted in the rendered document. */
  highlights?: ReadonlyArray<{
    threadId?: string;
    blockId: string;
    quote: string;
    startOffset: number;
    endOffset: number;
  }>;
  /** Open the corresponding comment thread for a clicked highlight. */
  onHighlightClick?: (threadId: string) => void;
}

/**
 * Drops sanitized server/client-rendered HTML into an
 * `<article class="marginalia">`.
 *
 * Why we manage `innerHTML` ourselves instead of using
 * `dangerouslySetInnerHTML`:
 *
 * Mermaid mutates the DOM in place (replacing the source text inside
 * `<div class="mermaid">` with an `<svg>`). If React owns `innerHTML` via
 * the `dangerouslySetInnerHTML` prop, it re-applies the original HTML
 * string on some re-renders (notably whenever the enclosing tree re-renders
 * while React's diff considers the prop changed, e.g. during the second
 * pass of a Strict-Mode double-mount, or subtly across some state updates),
 * which clobbers the SVG mermaid injected. By taking `innerHTML` off the
 * prop system and writing it ourselves in an effect — guarded so we only
 * write when the source string actually changed — React leaves the
 * children alone and mermaid's mutations survive parent re-renders.
 */
export function RenderedDoc({
  rendered,
  elRef,
  maxWidthCh,
  textZoom,
  highlights = [],
  onHighlightClick,
}: RenderedDocProps) {
  const internal = useRef<HTMLElement>(null);
  const ref = elRef ?? internal;
  const lastHtml = useRef<string | null>(null);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);

  // Apply `rendered.html` to the article's innerHTML exactly once per
  // unique html value, then run mermaid. React does not own these children.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (lastHtml.current === rendered.html) return;
    el.innerHTML = rendered.html;
    lastHtml.current = rendered.html;
    void renderMermaidIn(el);
  }, [rendered.html, ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    clearCommentHighlights(el);
    if (highlights.length === 0) return;

    applyCommentHighlights(el, highlights);
    return () => clearCommentHighlights(el);
  }, [highlights, rendered.html, ref]);

  // Anchor-click scroll + image-click lightbox. Both live on a single
  // delegated click handler on the article.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => {
      const target = e.target as HTMLElement;

      // Image → open lightbox. Ignore images that are inside an anchor
      // (the user linked the image intentionally; let the link win).
      if (target.tagName === 'IMG' && !target.closest('a')) {
        const img = target as HTMLImageElement;
        if (!img.src) return;
        e.preventDefault();
        setLightbox({ src: img.src, alt: img.alt });
        return;
      }

      // Mermaid / other inline SVG → serialize the SVG to a data URL and
      // open the same lightbox. Uses the enclosing .mermaid block as the
      // click target so users can click the diagram's body (not only its
      // rendered shapes).
      const mermaidBlock = target.closest<HTMLElement>('div.mermaid[data-processed="true"]');
      if (mermaidBlock) {
        const svg = mermaidBlock.querySelector('svg');
        if (svg) {
          e.preventDefault();
          const src = svgToDataUrl(svg);
          const alt = mermaidBlock.querySelector('title')?.textContent?.trim() || 'Diagram';
          setLightbox({ src, alt });
          return;
        }
      }

      const highlight = target.closest<HTMLElement>('mark[data-comment-thread-id]');
      const threadId = highlight?.dataset.commentThreadId;
      if (threadId && onHighlightClick) {
        e.preventDefault();
        onHighlightClick(threadId);
        return;
      }

      // Anchor → smooth-scroll to in-doc target.
      const anchor = target.closest('a[href^="#"]');
      if (anchor) {
        const href = anchor.getAttribute('href');
        if (href && href.length > 1) {
          const id = href.slice(1);
          const targetEl = el.querySelector(`[id="${CSS.escape(id)}"]`);
          if (targetEl) {
            e.preventDefault();
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        }
      }
    };
    el.addEventListener('click', handler);
    const keydown = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const target = e.target as HTMLElement | null;
      const highlight = target?.closest<HTMLElement>('mark[data-comment-thread-id]');
      const threadId = highlight?.dataset.commentThreadId;
      if (!threadId || !onHighlightClick) return;
      e.preventDefault();
      onHighlightClick(threadId);
    };
    el.addEventListener('keydown', keydown);
    return () => {
      el.removeEventListener('click', handler);
      el.removeEventListener('keydown', keydown);
    };
  }, [onHighlightClick, ref]);

  const style: React.CSSProperties | undefined =
    maxWidthCh || textZoom
      ? {
          ...(maxWidthCh ? { ['--md-max-width' as string]: `${maxWidthCh}ch` } : {}),
          ...(textZoom ? { fontSize: `calc(var(--md-font-size) * ${textZoom})` } : {}),
        }
      : undefined;

  // No `dangerouslySetInnerHTML` — see comment above.
  return (
    <>
      <div className="marginalia-theme">
        <article ref={ref} className="marginalia" style={style} />
      </div>
      <ImageLightbox image={lightbox} onClose={() => setLightbox(null)} />
    </>
  );
}

/**
 * Serialize an SVG element to a `data:image/svg+xml` URL. We ensure the
 * cloned SVG carries explicit width/height + xmlns so it renders correctly
 * when extracted from the document context.
 */
function svgToDataUrl(svg: SVGElement): string {
  const clone = svg.cloneNode(true) as SVGElement;
  if (!clone.getAttribute('xmlns')) {
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  }
  // If only a viewBox is set, the image has no intrinsic size → give it
  // one based on the viewBox so the lightbox's `zoom-fit` sizing works.
  const viewBox = clone.getAttribute('viewBox');
  if (viewBox && (!clone.getAttribute('width') || !clone.getAttribute('height'))) {
    const [, , w, h] = viewBox.split(/\s+/).map(Number);
    if (w && h) {
      clone.setAttribute('width', String(w));
      clone.setAttribute('height', String(h));
    }
  }
  const xml = new XMLSerializer().serializeToString(clone);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

function applyCommentHighlights(
  root: HTMLElement,
  highlights: ReadonlyArray<{
    threadId?: string;
    blockId: string;
    quote: string;
    startOffset: number;
    endOffset: number;
  }>,
): void {
  const rangesByBlock = new Map<
    string,
    Array<{ rawStart: number; rawEnd: number; threadIds: string[] }>
  >();

  for (const highlight of highlights) {
    if (highlight.endOffset <= highlight.startOffset || !highlight.quote) continue;

    const block = root.querySelector<HTMLElement>(
      `[data-block="${CSS.escape(highlight.blockId)}"]`,
    );
    if (!block) continue;

    const map = buildBlockTextMap(block);
    const resolved = resolveNormalizedRange(
      map.normalizedText,
      highlight.quote,
      highlight.startOffset,
      highlight.endOffset,
    );
    if (!resolved) continue;

    const rawStart = map.normalizedToRaw[resolved.start];
    const rawEndChar = map.normalizedToRaw[resolved.end - 1];
    if (rawStart === undefined || rawEndChar === undefined) continue;

    const blockRanges = rangesByBlock.get(highlight.blockId) ?? [];
    blockRanges.push({
      rawStart,
      rawEnd: rawEndChar + 1,
      threadIds: highlight.threadId ? [highlight.threadId] : [],
    });
    rangesByBlock.set(highlight.blockId, blockRanges);
  }

  for (const [blockId, ranges] of rangesByBlock) {
    const block = root.querySelector<HTMLElement>(`[data-block="${CSS.escape(blockId)}"]`);
    if (!block) continue;

    const merged = mergeRanges(ranges);
    if (merged.length === 0) continue;

    const textNodes = collectTextNodes(block);
    for (let i = merged.length - 1; i >= 0; i--) {
      const range = merged[i]!;
      wrapRangeAcrossTextNodes(textNodes, range.rawStart, range.rawEnd, range.threadIds);
    }
  }
}

function clearCommentHighlights(root: HTMLElement): void {
  const marks = root.querySelectorAll<HTMLElement>('mark[data-comment-highlight="true"]');
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

function resolveNormalizedRange(
  normalizedText: string,
  quote: string,
  startOffset: number,
  endOffset: number,
): { start: number; end: number } | null {
  if (startOffset >= 0 && endOffset <= normalizedText.length) {
    const exact = normalizedText.slice(startOffset, endOffset);
    if (exact === quote) {
      return { start: startOffset, end: endOffset };
    }
  }

  const nearStart = Math.max(0, startOffset - 24);
  const near = normalizedText.indexOf(quote, nearStart);
  if (near >= 0) {
    return { start: near, end: near + quote.length };
  }

  const anywhere = normalizedText.indexOf(quote);
  if (anywhere >= 0) {
    return { start: anywhere, end: anywhere + quote.length };
  }

  return null;
}

function buildBlockTextMap(block: HTMLElement): {
  normalizedText: string;
  normalizedToRaw: number[];
} {
  const textNodes = collectTextNodes(block);
  let rawText = '';
  for (const entry of textNodes) rawText += entry.node.data;

  let normalizedText = '';
  const normalizedToRaw: number[] = [];
  let sawContent = false;
  let pendingWhitespaceStart = -1;

  for (let i = 0; i < rawText.length; i++) {
    const char = rawText[i]!;
    if (/\s/u.test(char)) {
      if (!sawContent) continue;
      if (pendingWhitespaceStart < 0) pendingWhitespaceStart = i;
      continue;
    }

    if (pendingWhitespaceStart >= 0) {
      normalizedText += ' ';
      normalizedToRaw.push(pendingWhitespaceStart);
      pendingWhitespaceStart = -1;
    }

    normalizedText += char;
    normalizedToRaw.push(i);
    sawContent = true;
  }

  return { normalizedText, normalizedToRaw };
}

function collectTextNodes(root: HTMLElement): Array<{ node: Text; start: number; end: number }> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Array<{ node: Text; start: number; end: number }> = [];
  let offset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    const length = text.data.length;
    textNodes.push({ node: text, start: offset, end: offset + length });
    offset += length;
  }
  return textNodes;
}

function mergeRanges(
  ranges: Array<{ rawStart: number; rawEnd: number; threadIds: string[] }>,
): Array<{ rawStart: number; rawEnd: number; threadIds: string[] }> {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.rawStart - b.rawStart || a.rawEnd - b.rawEnd);
  const merged: Array<{ rawStart: number; rawEnd: number; threadIds: string[] }> = [
    { ...sorted[0]!, threadIds: [...sorted[0]!.threadIds] },
  ];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    const prev = merged[merged.length - 1]!;
    if (next.rawStart <= prev.rawEnd) {
      prev.rawEnd = Math.max(prev.rawEnd, next.rawEnd);
      prev.threadIds = Array.from(new Set([...prev.threadIds, ...next.threadIds]));
      continue;
    }
    merged.push({ ...next, threadIds: [...next.threadIds] });
  }

  return merged;
}

function wrapRangeAcrossTextNodes(
  textNodes: Array<{ node: Text; start: number; end: number }>,
  rawStart: number,
  rawEnd: number,
  threadIds: string[],
): void {
  for (let i = textNodes.length - 1; i >= 0; i--) {
    const entry = textNodes[i]!;
    const segmentStart = Math.max(rawStart, entry.start);
    const segmentEnd = Math.min(rawEnd, entry.end);
    if (segmentEnd <= segmentStart) continue;

    wrapTextSlice(entry.node, segmentStart - entry.start, segmentEnd - entry.start, threadIds);
  }
}

function wrapTextSlice(
  node: Text,
  startOffset: number,
  endOffset: number,
  threadIds: string[],
): void {
  let target = node;
  if (startOffset > 0) {
    target = target.splitText(startOffset);
  }
  if (endOffset - startOffset < target.data.length) {
    target.splitText(endOffset - startOffset);
  }

  const parent = target.parentNode;
  if (!parent) return;

  const mark = document.createElement('mark');
  mark.dataset.commentHighlight = 'true';
  mark.className = 'comment-highlight';
  if (threadIds.length > 0) {
    mark.dataset.commentThreadId = threadIds[0]!;
    mark.tabIndex = 0;
    mark.setAttribute('role', 'button');
    mark.setAttribute('aria-label', 'Open comment thread');
  }
  parent.insertBefore(mark, target);
  mark.appendChild(target);
}
