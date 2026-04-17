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
export function RenderedDoc({ rendered, elRef, maxWidthCh }: RenderedDocProps) {
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
    return () => el.removeEventListener('click', handler);
  }, [ref]);

  const style: React.CSSProperties | undefined = maxWidthCh
    ? { ['--md-max-width' as string]: `${maxWidthCh}ch` }
    : undefined;

  // No `dangerouslySetInnerHTML` — see comment above.
  return (
    <>
      <article ref={ref} className="marginalia" style={style} />
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
