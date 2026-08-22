import { splitSpanQuote } from '@marginalia/renderer/anchor-span';
import type { RenderResult } from '@marginalia/renderer/types';
import { type RefObject, useEffect, useRef, useState } from 'react';
import type { ThreadState } from '../lib/api.js';
import { spanElements } from '../lib/block-span.js';
import { isInjectedChromeText } from '../lib/block-text.js';
import { expandAncestors, installHeadingCollapse } from '../lib/heading-collapse.js';
import { renderMermaidIn } from '../lib/mermaid.js';
import { revealElement } from '../lib/paged-reading.js';
import { collectTopLevelBlocks } from '../lib/selection.js';
import { isAppleWebKit } from '../lib/webkit.js';
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

export interface DocumentSearchOptions {
  caseSensitive: boolean;
  wholeWords: boolean;
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
    scope?: 'range' | 'block';
    threadId?: string;
    blockId: string;
    quote: string;
    startOffset: number;
    endOffset: number;
  }>;
  /** Plain-text query to highlight inside the rendered document. */
  searchQuery?: string;
  /** Matching rules for document search. */
  searchOptions?: DocumentSearchOptions;
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
  searchOptions = { caseSensitive: false, wholeWords: false },
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
  // Gates the deferred scrolls launched by hashchange / anchor /
  // search handlers — a stale `expandAncestors().then(scroll)` whose
  // seq doesn't match the latest request bails out so it can't yank
  // the viewport back to a previously-selected target.
  const scrollSeq = useRef(0);
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

    // Most source changes — accepting an edit proposal above all — rewrite
    // a handful of adjacent blocks and leave the rest of the document
    // identical. Replacing innerHTML for those throws away every node:
    // the element-keyed highlight cache misses on all of them, mermaid
    // re-renders, the collapse install is redone, and every comment card
    // re-measures. Splice the changed run in instead and the untouched
    // DOM — and everything keyed to it — simply stays.
    const patched = lastHtml.current !== null ? patchChangedBlocks(el, rendered.html) : null;

    if (patched) {
      markChangedBlocks(patched);
    } else {
      el.innerHTML = rendered.html;
      // innerHTML replaces children but leaves the article's own
      // attributes intact — clear the marker so a doc swap re-installs.
      el.removeAttribute('data-collapse-installed');
    }
    lastHtml.current = rendered.html;
    void renderMermaidIn(el);
    replaceMissingAssetMarkers(el, canUploadMissing, uploadCbRef);
    installHeadingCollapse(el);
    // Replay the current hash after the article is populated. Opening
    // a deep link directly (`/d/...#section`) lets the browser fire
    // its initial fragment jump *before* React renders, so without
    // this the target stays unscrolled-to (and unrevealed if it sits
    // inside a folded section). hashchange doesn't fire on its own
    // here either — the hash isn't changing.
    //
    // Only after a full swap: a patch leaves the reader's target on
    // screen where it was, and re-running this would scroll away from
    // whatever they were reading when the edit landed.
    if (patched) return;
    const initialHash = window.location.hash.slice(1);
    if (initialHash) {
      let id = initialHash;
      try {
        id = decodeURIComponent(initialHash);
      } catch {
        id = initialHash;
      }
      const target = el.querySelector(`[id="${CSS.escape(id)}"]`);
      if (target) {
        const seq = ++scrollSeq.current;
        void expandAncestors(target).then(() => {
          if (seq !== scrollSeq.current) return;
          revealElement(target, { behavior: 'smooth', block: 'start' });
        });
      }
    }
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

  /**
   * What each block's highlights currently look like in the DOM, so a
   * threads refresh only re-wraps the blocks that actually changed.
   * Rebuilding the whole layer instead costs a teardown and a re-wrap of
   * every highlight in the document — on a long, heavily commented one
   * that is hundreds of milliseconds of DOM surgery and a full relayout
   * every time anyone posts a comment, which reads as the highlights
   * blinking out and the reader losing their place.
   *
   * Keyed by element, so an innerHTML rewrite invalidates it for free:
   * the new blocks are different objects and match nothing.
   */
  const highlightedBlocks = useRef<BlockHighlightState>(new Map());

  // biome-ignore lint/correctness/useExhaustiveDependencies: rendered.html is the re-attach trigger — when innerHTML is rewritten the previous text nodes are gone and highlights must be re-applied to the fresh DOM.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    highlightedBlocks.current = syncCommentHighlights(el, highlights, highlightedBlocks.current);
  }, [highlights, rendered.html, ref]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rendered.html re-runs after innerHTML rewrites; highlights re-runs so search highlights are re-applied after comment highlights swap mark elements in/out.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    clearDocumentSearchHighlights(el);

    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) {
      onSearchResultsChange?.([]);
      return;
    }

    const results = applyDocumentSearchHighlights(el, trimmedQuery, searchOptions);
    onSearchResultsChange?.(results);
    return () => clearDocumentSearchHighlights(el);
  }, [highlights, onSearchResultsChange, ref, rendered.html, searchOptions, searchQuery]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSearchVersion is the explicit re-trigger so re-clicking the same active result still scrolls to it.
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

    // `cancelled` handles deps-change; `scrollSeq` handles a TOC /
    // anchor click landing during the expand window — those don't
    // change this effect's deps but do bump the seq.
    let cancelled = false;
    const seq = ++scrollSeq.current;
    void expandAncestors(activeMark).then(() => {
      if (cancelled || seq !== scrollSeq.current) return;
      revealElement(activeMark, { behavior: 'smooth', block: 'center' });
    });
    return () => {
      cancelled = true;
    };
  }, [activeSearchResultId, activeSearchVersion, ref]);

  // Reveal targets reached via in-app navigation: `hashchange`
  // (back/forward, fresh anchor clicks) plus document clicks on
  // hash links — the latter catches re-clicks where the link's hash
  // already matches the current one (the browser doesn't fire
  // `hashchange` then).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const revealHash = (rawHash: string) => {
      if (!rawHash) return;
      let id = rawHash;
      try {
        id = decodeURIComponent(rawHash);
      } catch {
        id = rawHash;
      }
      const target = el.querySelector(`[id="${CSS.escape(id)}"]`);
      if (!target) return;
      const seq = ++scrollSeq.current;
      void expandAncestors(target).then(() => {
        if (seq !== scrollSeq.current) return;
        revealElement(target, { behavior: 'smooth', block: 'start' });
      });
    };
    const onHashChange = () => revealHash(window.location.hash.slice(1));
    const onDocumentClick = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      // Let the browser handle modifier / non-primary clicks so
      // Cmd/Ctrl/Shift-click and middle-click can still open the
      // anchor in a new tab or window.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.('a[href^="#"]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (!href || href.length <= 1) return;
      const linkHash = href.slice(1);
      // Resolve the target locally — if it isn't in our article we
      // let the browser handle the link normally.
      let id = linkHash;
      try {
        id = decodeURIComponent(linkHash);
      } catch {
        id = linkHash;
      }
      if (!el.querySelector(`[id="${CSS.escape(id)}"]`)) return;
      // Intercept BOTH same-hash and different-hash clicks. Letting
      // the browser's default fragment navigation run would jump
      // instantly to the (still-folded) target before our
      // `hashchange` handler gets a chance to expand and smooth-
      // scroll, producing a visible "wrong-spot then snap" jolt.
      e.preventDefault();
      const current = window.location.hash.slice(1);
      if (linkHash !== current) {
        const next = new URL(window.location.href);
        next.hash = linkHash;
        window.history.pushState(null, '', next);
      }
      revealHash(linkHash);
    };
    window.addEventListener('hashchange', onHashChange);
    document.addEventListener('click', onDocumentClick);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      document.removeEventListener('click', onDocumentClick);
    };
  }, [ref]);

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

      const highlight = target.closest<HTMLElement>('[data-comment-thread-id]');
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
            const seq = ++scrollSeq.current;
            void expandAncestors(targetEl).then(() => {
              if (seq !== scrollSeq.current) return;
              revealElement(targetEl, { behavior: 'smooth', block: 'start' });
            });
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
      const highlight = target?.closest<HTMLElement>('[data-comment-thread-id]');
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
  const existing = root.querySelectorAll<HTMLElement>('.missing-asset[data-missing-asset-ref]');
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
  // Use phrasing-content elements (span) rather than flow content
  // (div). Markdown renders `![alt](foo.png)` as `<p><img></p>`, and a
  // <div> inside a <p> is not valid HTML — browsers auto-close the
  // paragraph and reparent the div, which disrupts layout. <span>s
  // with `display: flex` via CSS work inside <p> and outside.
  const placeholder = document.createElement('span');
  placeholder.className = `missing-asset ${canUpload ? 'missing-asset--editable' : 'missing-asset--readonly'}`;
  placeholder.dataset.missingAssetRef = refName;

  const label = document.createElement('span');
  label.className = 'missing-asset__label';
  label.textContent = canUpload
    ? `Missing image: ${refName} — drop a file or click to upload`
    : `Image unavailable: ${refName}`;
  placeholder.appendChild(label);

  if (altText) {
    const alt = document.createElement('span');
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
  // Pointer users click the card; keyboard + assistive-tech users
  // reach the native <input type="file"> directly (it's already
  // focusable and announced as "Choose file, Upload <refName>" via
  // its aria-label). Giving the container its own role="button" +
  // tabindex would create two tab stops for a single logical
  // control — confusing to screen readers.
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

/** Marks a changed block so CSS can animate it in. Cleared on animation end. */
const CHANGED_BLOCK_CLASS = 'block-changed';

function markChangedBlocks(blocks: HTMLElement[]): void {
  for (const block of blocks) {
    block.classList.add(CHANGED_BLOCK_CLASS);
    const clear = () => block.classList.remove(CHANGED_BLOCK_CLASS);
    block.addEventListener('animationend', clear, { once: true });
    // Under reduced motion the animation never runs, so `animationend`
    // never fires — drop the class on a timer as well.
    window.setTimeout(clear, 1500);
  }
}

/** True if `el` is, or contains, a heading. */
function hasHeading(el: HTMLElement): boolean {
  return /^H[1-6]$/.test(el.tagName) || el.querySelector('h1,h2,h3,h4,h5,h6') !== null;
}

/**
 * Splice the run of blocks that changed into the live article, leaving every
 * other element — and so every highlight, mermaid render and measured card
 * position keyed to it — untouched. Returns the newly inserted elements, or
 * null when the change is not one this can safely express, in which case the
 * caller falls back to replacing innerHTML.
 *
 * The changed run is derived by matching block ids inward from both ends, so
 * it needs nothing from the server and copes with a replacement that changes
 * the number of blocks.
 */
function patchChangedBlocks(root: HTMLElement, nextHtml: string): HTMLElement[] | null {
  const staging = document.createElement('div');
  staging.innerHTML = nextHtml;

  const live = collectTopLevelBlocks(root);
  const fresh = collectTopLevelBlocks(staging);
  if (live.length === 0 || fresh.length === 0) return null;

  // Block ids are content hashes, so an untouched paragraph keeps its id.
  // Comparing the DOM to the parsed replacement needs no server metadata.
  const prevIds = live.map((el) => el.getAttribute('data-block'));
  const nextIds = fresh.map((el) => el.getAttribute('data-block'));
  if (prevIds.some((id) => id === null) || nextIds.some((id) => id === null)) return null;

  let start = 0;
  while (start < prevIds.length && start < nextIds.length && prevIds[start] === nextIds[start]) {
    start++;
  }
  let tail = 0;
  while (
    tail < prevIds.length - start &&
    tail < nextIds.length - start &&
    prevIds[prevIds.length - 1 - tail] === nextIds[nextIds.length - 1 - tail]
  ) {
    tail++;
  }

  const removed = live.slice(start, live.length - tail);
  const insertCount = nextIds.length - tail - start;
  // Identical block lists — the html differs somewhere a block diff cannot
  // see (theme chrome, an attribute). Let the full swap handle it.
  if (removed.length === 0 && insertCount === 0) return null;

  // Headings own the collapse wrappers this splices into, so moving one
  // means rebuilding that structure — not worth expressing here.
  if (removed.some(hasHeading)) return null;

  // Anchor the insert: before the first removed element, or before the
  // first surviving block after the run when this is a pure insertion.
  const anchor = removed[0] ?? live[start] ?? null;
  if (!anchor) return null;
  const parent = anchor.parentNode;
  if (!parent) return null;
  // A run spanning several parents means it crosses a section boundary.
  if (removed.some((el) => el.parentNode !== parent)) return null;

  const inserted = fresh.slice(start, start + insertCount);
  if (inserted.some(hasHeading)) return null;
  // Mermaid blocks are rendered in place by an async pass keyed to the whole
  // article; re-running it over a partially patched tree is not worth the risk.
  if (inserted.some((el) => el.querySelector('.mermaid') || el.classList.contains('mermaid'))) {
    return null;
  }

  const frag = document.createDocumentFragment();
  for (const el of inserted) frag.appendChild(el);
  parent.insertBefore(frag, anchor);
  for (const el of removed) el.remove();
  return inserted;
}

/** How one block's highlights are painted, and the signature that says so. */
interface BlockHighlightPlan {
  ranges: HighlightRange[];
  /** Block-scope marking (whole-block comment), or null for range scope. */
  blockScope: { threadId: string | null; interactive: boolean } | null;
  signature: string;
}

/** Signature of every block currently carrying highlights, keyed by element. */
type BlockHighlightState = Map<HTMLElement, string>;

/**
 * Bring the painted highlights in line with `highlights`, touching only
 * the blocks whose result actually changed. Returns the new state to
 * hand back on the next pass.
 */
function syncCommentHighlights(
  root: HTMLElement,
  highlights: Parameters<typeof planCommentHighlights>[1],
  previous: BlockHighlightState,
): BlockHighlightState {
  const plans = planCommentHighlights(root, highlights);
  const touched: HTMLElement[] = [];

  for (const block of previous.keys()) {
    if (!plans.has(block)) {
      clearBlockHighlights(block);
      touched.push(block);
    }
  }

  const next: BlockHighlightState = new Map();
  for (const [block, plan] of plans) {
    next.set(block, plan.signature);
    if (previous.get(block) === plan.signature) continue;
    clearBlockHighlights(block);
    paintBlockHighlights(block, plan);
    touched.push(block);
  }
  relayoutIndent(touched);
  return next;
}

/**
 * Lay the touched blocks out again from the top.
 *
 * WebKit puts `text-indent` on the wrong line after inline content is
 * spliced into a paragraph it has already laid out: the indent moves to
 * whichever line the new inline box landed on, so highlighting a phrase
 * on a paragraph's second line shunts that whole line across by the
 * indent. It survives until something invalidates the block, which in a
 * long document may be never — the reader is left with a paragraph that
 * looks mis-set until they scroll far enough away and back.
 *
 * Changing the property and flushing is enough to make WebKit resolve it
 * against the first line again. Batched deliberately: one flush covers
 * however many blocks the pass touched, so the initial application over a
 * heavily annotated document stays two layouts rather than two per block.
 *
 * Detached blocks are dropped first. A pass that follows an innerHTML
 * rewrite carries the whole previous document in its list — every one of
 * those elements is orphaned, and flushing against an orphan measures
 * nothing and leaves the live blocks uncorrected.
 */
function relayoutIndent(candidates: readonly HTMLElement[]): void {
  if (!isAppleWebKit()) return;
  const blocks = candidates.filter((block) => block.isConnected);
  const first = blocks[0];
  if (!first) return;
  const overrides = blocks.map((block) => block.style.textIndent);
  for (const block of blocks) block.style.textIndent = '0px';
  void first.offsetHeight;
  blocks.forEach((block, i) => {
    block.style.textIndent = overrides[i] ?? '';
  });
  void first.offsetHeight;
}

function paintBlockHighlights(block: HTMLElement, plan: BlockHighlightPlan): void {
  if (plan.blockScope) {
    block.dataset.commentHighlightBlock = 'true';
    if (plan.blockScope.interactive) block.classList.add('comment-highlight-block');
    // Same rule as the range marks: only an open thread gets the id the
    // click handler reads, so a settled proposal can't turn its whole
    // paragraph into a click target.
    if (plan.blockScope.threadId && plan.blockScope.interactive) {
      block.dataset.commentThreadId = plan.blockScope.threadId;
      block.tabIndex = 0;
      block.setAttribute('role', 'button');
      block.setAttribute('aria-label', 'Open comment thread');
    }
  }
  if (plan.ranges.length === 0) return;
  // Same filter as buildBlockTextMap — the merged ranges index this list.
  const textNodes = collectTextNodes(block, isInjectedChromeText);
  for (let i = plan.ranges.length - 1; i >= 0; i--) {
    const range = plan.ranges[i]!;
    wrapRangeAcrossTextNodes(textNodes, range.rawStart, range.rawEnd, range.threads);
  }
}

function planCommentHighlights(
  root: HTMLElement,
  highlights: ReadonlyArray<{
    scope?: 'range' | 'block';
    threadId?: string;
    blockId: string;
    /** Last block of a multi-block span; the blocks in between are
     *  re-derived from the DOM rather than stored on the anchor. */
    endBlockId?: string | null;
    quote: string;
    startOffset: number;
    endOffset: number;
    state?: ThreadState;
  }>,
): Map<HTMLElement, BlockHighlightPlan> {
  const rangesByBlock = new Map<HTMLElement, HighlightRange[]>();
  const blockScopeByBlock = new Map<
    HTMLElement,
    { threadId: string | null; interactive: boolean }
  >();

  for (const highlight of highlights) {
    // A span quote holds one fragment per covered block. Only the first
    // and last are positioned by the stored offsets; blocks in between
    // are highlighted whole, so a fragment list that drifted from the
    // live DOM (content inserted inside the span) still paints sanely.
    const fragments = splitSpanQuote(highlight.quote);
    const head = fragments[0] ?? '';
    const tail = fragments[fragments.length - 1] ?? '';

    const startBlock = findHighlightBlock(root, highlight.blockId, head);
    if (!startBlock) continue;
    const endBlock = highlight.endBlockId
      ? findHighlightBlock(root, highlight.endBlockId, tail)
      : null;
    // A span whose far end no longer resolves degrades to its first
    // block rather than dropping the highlight entirely.
    const blocks =
      endBlock && endBlock !== startBlock ? spanElements(root, startBlock, endBlock) : [];
    if (blocks.length === 0) blocks.push(startBlock);

    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]!;
      const isFirst = i === 0;
      const isLast = i === blocks.length - 1;

      const map = buildBlockTextMap(block);
      let rawStart: number | undefined;
      let rawEnd: number | undefined;

      if (highlight.scope === 'block') {
        if (map.rawLength <= 0) continue;
        const hasOpen = highlight.state === 'open';
        // Several threads can mark the same block, and one open thread is
        // enough to keep it clickable. The id is what that click opens, so
        // an open thread claims it over a settled one; among equals the
        // last still wins.
        const previous = blockScopeByBlock.get(block);
        blockScopeByBlock.set(block, {
          threadId: hasOpen
            ? (highlight.threadId ?? previous?.threadId ?? null)
            : (previous?.threadId ?? highlight.threadId ?? null),
          interactive: hasOpen || previous?.interactive === true,
        });
        // Wrapping a settled proposal's whole block in transparent
        // <mark>s adds DOM bloat with no visible effect, and it is not a
        // click target either way. Flash falls back to [data-block].
        if (!hasOpen) continue;
        rawStart = 0;
        rawEnd = map.rawLength;
      } else if (isFirst || isLast) {
        // Endpoints keep their exact sub-block-text range; the stored
        // offsets index the first block from its start and the last
        // block up to its end.
        const fragment = isFirst ? head : tail;
        const start = isFirst ? highlight.startOffset : highlight.endOffset - fragment.length;
        const end = isFirst ? highlight.startOffset + fragment.length : highlight.endOffset;
        if (!fragment || end <= start) continue;

        const resolved = resolveNormalizedRange(map.normalizedText, fragment, start, end);
        if (!resolved) continue;

        rawStart = map.normalizedToRaw[resolved.start];
        const rawEndChar = map.normalizedToRaw[resolved.end - 1];
        if (rawStart === undefined || rawEndChar === undefined) continue;
        rawEnd = rawEndChar + 1;
      } else {
        if (map.rawLength <= 0) continue;
        rawStart = 0;
        rawEnd = map.rawLength;
      }

      const blockRanges = rangesByBlock.get(block) ?? [];
      blockRanges.push({
        rawStart,
        rawEnd,
        threads:
          highlight.threadId && highlight.state
            ? [{ id: highlight.threadId, state: highlight.state }]
            : [],
      });
      rangesByBlock.set(block, blockRanges);
    }
  }

  const plans = new Map<HTMLElement, BlockHighlightPlan>();
  for (const block of new Set([...rangesByBlock.keys(), ...blockScopeByBlock.keys()])) {
    const ranges = mergeRanges(rangesByBlock.get(block) ?? []);
    const blockScope = blockScopeByBlock.get(block) ?? null;
    if (ranges.length === 0 && !blockScope) continue;
    plans.set(block, { ranges, blockScope, signature: planSignature(ranges, blockScope) });
  }
  return plans;
}

function planSignature(
  ranges: HighlightRange[],
  blockScope: { threadId: string | null; interactive: boolean } | null,
): string {
  const parts = ranges.map(
    (r) => `${r.rawStart}-${r.rawEnd}:${r.threads.map((t) => `${t.id}/${t.state}`).join(',')}`,
  );
  if (blockScope) parts.push(`block:${blockScope.threadId ?? ''}/${blockScope.interactive}`);
  return parts.join('|');
}

/** Undo every comment highlight painted inside (or onto) one block. */
function clearBlockHighlights(block: HTMLElement): void {
  const marks = block.querySelectorAll<HTMLElement>('mark[data-comment-highlight="true"]');
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }

  if (block.dataset.commentHighlightBlock !== 'true') return;
  block.classList.remove('comment-highlight-block');
  delete block.dataset.commentHighlightBlock;
  delete block.dataset.commentThreadId;
  block.removeAttribute('tabindex');
  block.removeAttribute('role');
  block.removeAttribute('aria-label');
}

function applyDocumentSearchHighlights(
  root: HTMLElement,
  query: string,
  options: DocumentSearchOptions,
): DocumentSearchResult[] {
  if (!query) return [];

  // Mermaid diagram blocks contain their source as text until the client-side
  // renderer swaps it for SVG; exclude that text (and any SVG internals after
  // rendering) so search only matches what the reader can actually see.
  const textNodes = collectTextNodes(
    root,
    (node) => node.parentElement?.closest('[data-block-kind="mermaid"]') != null,
  );
  if (textNodes.length === 0) return [];

  let rawText = '';
  for (const entry of textNodes) rawText += entry.node.data;

  const haystack = options.caseSensitive ? rawText : rawText.toLocaleLowerCase();
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  const results: DocumentSearchResult[] = [];
  const ranges: Array<{ rawStart: number; rawEnd: number; resultId: string }> = [];

  let searchFrom = 0;
  let index = 0;
  while (searchFrom <= haystack.length - needle.length) {
    const found = haystack.indexOf(needle, searchFrom);
    if (found < 0) break;
    const rawEnd = found + query.length;
    if (options.wholeWords && !isWholeWordMatch(rawText, found, rawEnd)) {
      searchFrom = found + 1;
      continue;
    }

    const resultId = `doc-search-${found}-${index}`;
    const matchText = rawText.slice(found, rawEnd);
    const startEntry = findTextNodeEntry(textNodes, found);
    const blockId =
      startEntry?.node.parentElement?.closest<HTMLElement>('[data-block]')?.dataset.block ?? null;
    const headingId =
      startEntry?.node.parentElement?.closest<HTMLElement>(
        'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]',
      )?.id ?? null;

    results.push({
      id: resultId,
      index,
      text: matchText,
      contextBefore: formatContext(rawText.slice(Math.max(0, found - 36), found), true),
      contextAfter: formatContext(
        rawText.slice(rawEnd, Math.min(rawText.length, rawEnd + 52)),
        false,
      ),
      blockId,
      headingId,
    });
    ranges.push({ rawStart: found, rawEnd, resultId });

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
  rawLength: number;
} {
  const textNodes = collectTextNodes(block, isInjectedChromeText);
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

  return { normalizedText, normalizedToRaw, rawLength: rawText.length };
}

function findHighlightBlock(
  root: HTMLElement,
  blockId: string,
  quote?: string | null,
): HTMLElement | null {
  const escaped = CSS.escape(blockId);
  const block = root.querySelector<HTMLElement>(
    `[data-block="${escaped}"], [data-subblock="${escaped}"]`,
  );
  if (!block || !quote || block.dataset.subblock) return block;
  // Recovery for comments anchored before sub-block-aware capture
  // landed: their stored block_id points at the enclosing top-level
  // block (a list, table, …) rather than the specific sub-block they
  // were on. If the quote uniquely identifies one descendant
  // sub-block, narrow to it so the highlight + click-flash hit the
  // right element instead of the whole container.
  const subEls = block.querySelectorAll<HTMLElement>('[data-subblock]');
  let narrowed: HTMLElement | null = null;
  for (const sub of subEls) {
    const text = (sub.textContent ?? '').replace(/\s+/gu, ' ').trim();
    if (text.includes(quote)) {
      if (narrowed) return block; // quote appears in multiple sub-blocks — leave on the parent
      narrowed = sub;
    }
  }
  return narrowed ?? block;
}

function collectTextNodes(
  root: HTMLElement,
  skip?: (node: Text) => boolean,
): Array<{ node: Text; start: number; end: number }> {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    skip
      ? {
          acceptNode(node) {
            return skip(node as Text) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
          },
        }
      : null,
  );
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

type RangeThread = { id: string; state: ThreadState };
type HighlightRange = { rawStart: number; rawEnd: number; threads: RangeThread[] };

function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.rawStart - b.rawStart || a.rawEnd - b.rawEnd);
  const merged: HighlightRange[] = [{ ...sorted[0]!, threads: [...sorted[0]!.threads] }];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    const prev = merged[merged.length - 1]!;
    if (next.rawStart <= prev.rawEnd) {
      prev.rawEnd = Math.max(prev.rawEnd, next.rawEnd);
      const seen = new Set(prev.threads.map((t) => t.id));
      for (const t of next.threads) {
        if (!seen.has(t.id)) {
          prev.threads.push(t);
          seen.add(t.id);
        }
      }
      continue;
    }
    merged.push({ ...next, threads: [...next.threads] });
  }

  return merged;
}

function wrapRangeAcrossTextNodes(
  textNodes: Array<{ node: Text; start: number; end: number }>,
  rawStart: number,
  rawEnd: number,
  threads: RangeThread[],
): void {
  for (let i = textNodes.length - 1; i >= 0; i--) {
    const entry = textNodes[i]!;
    const segmentStart = Math.max(rawStart, entry.start);
    const segmentEnd = Math.min(rawEnd, entry.end);
    if (segmentEnd <= segmentStart) continue;

    wrapTextSlice(entry.node, segmentStart - entry.start, segmentEnd - entry.start, threads);
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
  threads: RangeThread[],
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
  const openThread = threads.find((t) => t.state === 'open');
  // No threads = a pending/transient highlight (e.g. a fresh selection):
  // treat as visible "open" so it isn't styled transparent.
  const isVisuallyOpen = threads.length === 0 || openThread !== undefined;
  mark.className = isVisuallyOpen ? 'comment-highlight' : 'comment-highlight-resolved';
  if (threads.length > 0) {
    // Overlapping ranges merge into one mark; every covered thread must
    // stay findable for scroll-to-thread, not just the click target.
    mark.dataset.commentThreadIds = threads.map((t) => t.id).join(' ');
  }
  // The singular id is what the document's click and keydown handlers
  // open, so it only ever names an open thread. A resolved mark paints
  // no marker at all, so making it a click target turns ordinary-looking
  // words into a trap: it opens a settled card and lifts whatever
  // filters were hiding it. Resolved threads are opened from the Threads
  // tab and Activities, which list them on purpose.
  if (openThread) {
    mark.dataset.commentThreadId = openThread.id;
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

function isWholeWordMatch(text: string, start: number, end: number): boolean {
  const before = start > 0 ? (text[start - 1] ?? '') : '';
  const after = end < text.length ? (text[end] ?? '') : '';
  return !isWordChar(before) && !isWordChar(after);
}

function isWordChar(char: string): boolean {
  return char ? /[\p{L}\p{N}\p{M}_]/u.test(char) : false;
}
