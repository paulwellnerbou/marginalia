import { useEffect, useRef, type RefObject } from 'react';
import type { RenderResult } from '@markdowner/renderer';

interface RenderedDocProps {
  rendered: Pick<RenderResult, 'html'>;
  /** Optional external ref — lets the parent reach the article DOM node. */
  elRef?: RefObject<HTMLElement | null>;
}

/**
 * Drops server- or client-rendered HTML into an `<article class="markdowner">`.
 * The HTML is already sanitized by the renderer pipeline.
 */
export function RenderedDoc({ rendered, elRef }: RenderedDocProps) {
  const internal = useRef<HTMLElement>(null);
  const ref = elRef ?? internal;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Hook: enhance links with scroll behavior so anchor clicks don't
    // trigger router navigation.
    const handler = (e: Event) => {
      const target = e.target as HTMLElement;
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
  }, [rendered.html]);

  return (
    <article
      ref={ref}
      className="markdowner"
      // eslint-disable-next-line react/no-danger -- HTML is produced by our sanitized pipeline
      dangerouslySetInnerHTML={{ __html: rendered.html }}
    />
  );
}
