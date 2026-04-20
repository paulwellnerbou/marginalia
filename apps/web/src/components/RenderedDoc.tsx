import { useEffect, useRef, useState, type RefObject } from 'react';
import type { RenderResult } from '@marginalia/renderer';
import { renderMermaidIn } from '../lib/mermaid.js';
import { ImageLightbox, type LightboxImage } from './ImageLightbox.js';

export interface DocumentSearchResult {
  id: string;
  index: number;
  text: string;
  contextBefore: string;
  contextAfter: string;
  blockId: string | null;
  headingId: string | null;
}

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
  /** Plain-text query to highlight inside the rendered document. */
  searchQuery?: string;
  /** Result id currently selected by the document search UI. */
  activeSearchResultId?: string | null;
  /** Bumped when the selected result should scroll into view again. */
  activeSearchVersion?: number;
  /** Called whenever search results are recomputed from the live article DOM. */
  onSearchResultsChange?: (results: DocumentSearchResult[]) => void;
  /** Open the corresponding comment thread for a clicked highlight. */
  onHighlightClick?: (threadId: string) => void;
  /**
   * Supplied by editors: called when a user drops or picks a file on a
   * missing-asset placeholder. When absent, placeholders render read-only
   * (no file picker, no drop target) for readers.
   */
  onMissingAssetUpload?: ((refName: string, file: File) => void | Promise<void>) | undefined;
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
  searchQuery = '',
  activeSearchResultId = null,
  activeSearchVersion = 0,
  onSearchResultsChange,
  onHighlightClick,
  onMissingAssetUpload,
}: RenderedDocProps) {
  const internal = useRef<HTMLElement>(null);
  const ref = elRef ?? internal;
  const lastHtml = useRef<string | null>(null);
  const [lightbox, setLightbox] = useState<LightboxImage | null>(null);
  // Stash the upload callback in a ref so the placeholder post-process
  // can call the latest version without re-running when it changes —
  // the DOM-mutation effect only cares about whether uploads are enabled.
  const uploadCbRef = useRef<typeof onMissingAssetUpload>(onMissingAssetUpload);
  useEffect(() => {
    uploadCbRef.current = onMissingAssetUpload;
  }, [onMissingAssetUpload]);
  const canUploadMissing = Boolean(onMissingAssetUpload);

  // Apply `rendered.html` to the article's innerHTML exactly once per
  // unique html value, then run mermaid + replace missing-asset markers
  // with placeholder cards. React does not own these children.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (lastHtml.current === rendered.html) return;
    el.innerHTML = rendered.html;
    lastHtml.current = rendered.html;
    void renderMermaidIn(el);
    replaceMissingAssetMarkers(el, canUploadMissing, uploadCbRef);
  }, [rendered.html, ref, canUploadMissing]);

  // If canUploadMissing flips while `rendered.html` stays the same
  // (e.g. invite upgraded mid-session so the user gains editor role),
  // the placeholders that were already rendered by the innerHTML
  // effect are stuck in the previous mode. This effect walks the
  // existing `.missing-asset` cards and rebuilds each in place —
  // without re-setting innerHTML, so mermaid-rendered SVG survives.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    refreshMissingAssetPlaceholders(el, canUploadMissing, uploadCbRef);
  }, [canUploadMissing, ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    clearCommentHighlights(el);
    if (highlights.length === 0) return;

    applyCommentHighlights(el, highlights);
    return () => clearCommentHighlights(el);
  }, [highlights, rendered.html, ref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    clearDocumentSearchHighlights(el);

    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) {
      onSearchResultsChange?.([]);
      return;
    }

    const results = applyDocumentSearchHighlights(el, trimmedQuery);
    onSearchResultsChange?.(results);
    return () => clearDocumentSearchHighlights(el);
  }, [highlights, onSearchResultsChange, ref, rendered.html, searchQuery]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const marks = el.querySelectorAll<HTMLElement>('mark[data-doc-search-highlight="true"]');
    for (const mark of marks) {
      mark.classList.toggle('active', mark.dataset.docSearchResultId === activeSearchResultId);
    }

    if (!activeSearchResultId) return;

    const activeMark = el.querySelector<HTMLElement>(
      `mark[data-doc-search-highlight="true"][data-doc-search-result-id="${CSS.escape(activeSearchResultId)}"]`,
    );
    if (!activeMark) return;

    activeMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [activeSearchResultId, activeSearchVersion, ref]);

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

      // Anchor → smooth-scroll to in-doc target AND sync the address bar.
      // Default `<a href="#id">` behaviour updates both, but we preventDefault
      // to override the browser's instant jump with a smooth scroll inside
      // our nested scroll container. Without a matching history.pushState
      // the hash silently disappears — permalink sharing, back/forward, and
      // refresh all break. We add it back manually here.
      const anchor = target.closest('a[href^="#"]');
      if (anchor) {
        const href = anchor.getAttribute('href');
        if (href && href.length > 1) {
          const rawId = href.slice(1);
          // Malformed percent-encoding in the href would make
          // decodeURIComponent throw a URIError here and abort the whole
          // click handler — other handlers (image lightbox, comments)
          // would stop firing until the user clicks a well-formed link.
          // Fall back to the raw id so querySelector still gets a shot.
          let id = rawId;
          try {
            id = decodeURIComponent(rawId);
          } catch {
            id = rawId;
          }
          const targetEl = el.querySelector(`[id="${CSS.escape(id)}"]`);
          if (targetEl) {
            e.preventDefault();
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            // Keep the URL in sync so copy-link / refresh / back-button
            // behaviour matches native anchor clicks. `pushState` rather
            // than `replaceState` because the browser would also push a
            // history entry on a default anchor click.
            //
            // Build `next.hash` from the decoded id first and compare
            // against `window.location.hash` AFTER both have gone
            // through URL's percent-encoding — otherwise an id with
            // reserved chars (colons, spaces, umlauts) would compare
            // decoded-vs-encoded and push a redundant entry on every
            // re-click of the same anchor.
            const next = new URL(window.location.href);
            next.hash = id;
            if (window.location.hash !== next.hash) {
              window.history.pushState(null, '', next);
            }
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

function isImageFile(file: File): boolean {
  // Browsers set the MIME type from the filename extension when reading
  // a drag/dropped file, so this catches both file-picker and drop
  // paths. An empty `type` (rare: unknown extension) is treated as
  // non-image — safer to reject than to upload bytes that will be
  // served with an incorrect Content-Type.
  return file.type.startsWith('image/');
}

type UploadCbRef = {
  current?: ((refName: string, file: File) => void | Promise<void>) | undefined;
};

/**
 * Swap `<img data-missing-asset="name">` markers produced by
 * `rewriteAssetReferences` for a placeholder card. Editors (with an
 * upload callback) get a dropzone + file picker; readers get a muted
 * "not available" note.
 */
function replaceMissingAssetMarkers(
  root: HTMLElement,
  canUpload: boolean,
  cbRef: UploadCbRef,
): void {
  const markers = root.querySelectorAll<HTMLImageElement>('img[data-missing-asset]');
  for (const img of Array.from(markers)) {
    const refName = img.dataset.missingAsset ?? '';
    if (!refName) continue;
    const altText = img.alt && img.alt.trim() ? img.alt : null;
    img.replaceWith(buildMissingAssetPlaceholder(refName, altText, canUpload, cbRef));
  }
}

/**
 * Rebuild every existing `.missing-asset` card in place. Called when
 * `canUploadMissing` flips (role change / invite upgrade) while
 * `rendered.html` stays the same — the innerHTML effect short-circuits
 * in that case, leaving stale placeholders in the previous mode.
 * Uses `replaceWith` so mermaid-rendered SVG elsewhere in the article
 * is untouched.
 */
function refreshMissingAssetPlaceholders(
  root: HTMLElement,
  canUpload: boolean,
  cbRef: UploadCbRef,
): void {
  const existing = root.querySelectorAll<HTMLElement>(
    '.missing-asset[data-missing-asset-ref]',
  );
  for (const old of Array.from(existing)) {
    const refName = old.dataset.missingAssetRef ?? '';
    if (!refName) continue;
    const alt = old.querySelector<HTMLElement>('.missing-asset__alt')?.textContent ?? null;
    old.replaceWith(buildMissingAssetPlaceholder(refName, alt, canUpload, cbRef));
  }
}

function buildMissingAssetPlaceholder(
  refName: string,
  altText: string | null,
  canUpload: boolean,
  cbRef: UploadCbRef,
): HTMLElement {
  const placeholder = document.createElement('div');
  placeholder.className = `missing-asset ${canUpload ? 'missing-asset--editable' : 'missing-asset--readonly'}`;
  placeholder.dataset.missingAssetRef = refName;

  const label = document.createElement('div');
  label.className = 'missing-asset__label';
  label.textContent = canUpload
    ? `Missing image: ${refName} — drop a file or click to upload`
    : `Image unavailable: ${refName}`;
  placeholder.appendChild(label);

  if (altText) {
    const alt = document.createElement('div');
    alt.className = 'missing-asset__alt';
    alt.textContent = altText;
    placeholder.appendChild(alt);
  }

  if (!canUpload) return placeholder;

  const input = document.createElement('input');
  input.type = 'file';
  // Placeholder is attached to an `<img>` marker, so only image bytes
  // make sense here. Without this filter, dropping a PDF onto a
  // `cat.png` slot would store the bytes but serve them as image/png
  // (mime is derived from the ref name) → a permanently broken image.
  input.accept = 'image/*';
  input.className = 'missing-asset__input';
  input.setAttribute('aria-label', `Upload ${refName}`);
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file && isImageFile(file)) cbRef.current?.(refName, file);
    // Clear the value so picking the same file again still fires
    // `change` — needed for retry-after-error UX. Matches the reset
    // already done in AssetsPanel's ReplaceButton.
    input.value = '';
  });
  placeholder.appendChild(input);

  placeholder.addEventListener('dragover', (e) => {
    e.preventDefault();
    placeholder.classList.add('missing-asset--over');
  });
  placeholder.addEventListener('dragleave', () => {
    placeholder.classList.remove('missing-asset--over');
  });
  placeholder.addEventListener('drop', (e) => {
    e.preventDefault();
    placeholder.classList.remove('missing-asset--over');
    const file = e.dataTransfer?.files?.[0];
    if (file && isImageFile(file)) cbRef.current?.(refName, file);
  });
  placeholder.addEventListener('click', (e) => {
    if (e.target === input) return;
    input.click();
  });
  return placeholder;
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

function applyDocumentSearchHighlights(root: HTMLElement, query: string): DocumentSearchResult[] {
  if (!query) return [];

  const textNodes = collectTextNodes(root);
  if (textNodes.length === 0) return [];

  let rawText = '';
  for (const entry of textNodes) rawText += entry.node.data;

  const loweredText = rawText.toLocaleLowerCase();
  const loweredQuery = query.toLocaleLowerCase();
  const results: DocumentSearchResult[] = [];
  const ranges: Array<{ rawStart: number; rawEnd: number; resultId: string }> = [];

  let searchFrom = 0;
  let index = 0;
  while (searchFrom <= loweredText.length - loweredQuery.length) {
    const found = loweredText.indexOf(loweredQuery, searchFrom);
    if (found < 0) break;

    const resultId = `doc-search-${index}`;
    const matchText = rawText.slice(found, found + query.length);
    const startEntry = findTextNodeEntry(textNodes, found);
    const blockId =
      startEntry?.node.parentElement?.closest<HTMLElement>('[data-block]')?.dataset.block ?? null;
    const headingId =
      startEntry?.node.parentElement?.closest<HTMLElement>('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]')
        ?.id ?? null;

    results.push({
      id: resultId,
      index,
      text: matchText,
      contextBefore: formatContext(rawText.slice(Math.max(0, found - 36), found), true),
      contextAfter: formatContext(
        rawText.slice(found + query.length, Math.min(rawText.length, found + query.length + 52)),
        false,
      ),
      blockId,
      headingId,
    });
    ranges.push({ rawStart: found, rawEnd: found + query.length, resultId });

    searchFrom = found + Math.max(query.length, 1);
    index += 1;
  }

  for (let i = ranges.length - 1; i >= 0; i--) {
    const range = ranges[i]!;
    wrapSearchRangeAcrossTextNodes(textNodes, range.rawStart, range.rawEnd, range.resultId);
  }

  return results;
}

function clearDocumentSearchHighlights(root: HTMLElement): void {
  const marks = root.querySelectorAll<HTMLElement>('mark[data-doc-search-highlight="true"]');
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

function findTextNodeEntry(
  textNodes: Array<{ node: Text; start: number; end: number }>,
  offset: number,
): { node: Text; start: number; end: number } | null {
  for (const entry of textNodes) {
    if (offset >= entry.start && offset < entry.end) return entry;
  }
  return textNodes[textNodes.length - 1] ?? null;
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

function wrapSearchRangeAcrossTextNodes(
  textNodes: Array<{ node: Text; start: number; end: number }>,
  rawStart: number,
  rawEnd: number,
  resultId: string,
): void {
  for (let i = textNodes.length - 1; i >= 0; i--) {
    const entry = textNodes[i]!;
    const segmentStart = Math.max(rawStart, entry.start);
    const segmentEnd = Math.min(rawEnd, entry.end);
    if (segmentEnd <= segmentStart) continue;

    wrapSearchTextSlice(entry.node, segmentStart - entry.start, segmentEnd - entry.start, resultId);
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

function wrapSearchTextSlice(
  node: Text,
  startOffset: number,
  endOffset: number,
  resultId: string,
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
  mark.dataset.docSearchHighlight = 'true';
  mark.dataset.docSearchResultId = resultId;
  mark.className = 'doc-search-highlight';
  parent.insertBefore(mark, target);
  mark.appendChild(target);
}

function formatContext(text: string, isPrefix: boolean): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  if (!compact) return '';
  return isPrefix ? `...${compact} ` : ` ${compact}...`;
}
