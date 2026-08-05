import { useId, useLayoutEffect, useRef, useState } from 'react';
import { InlineCommentMarkdown } from './InlineCommentMarkdown.js';

interface Props {
  children: string;
}

/**
 * Sub-pixel slack so a body that fills the clamp exactly — its height
 * rounded a hair over the clamp by the layout engine — doesn't offer a
 * "Show more" that reveals nothing.
 */
const OVERFLOW_EPSILON_PX = 1;

/** Whether clipping the body to the clamp actually hides anything. */
export function isClipped(contentHeight: number, clampHeight: number): boolean {
  if (clampHeight <= 0) return false;
  return contentHeight > clampHeight + OVERFLOW_EPSILON_PX;
}

/**
 * A comment body clamped to the first few lines, with a toggle to see
 * the rest. The clamp height lives in CSS (`--ic-body-clamp-lines`) so
 * the first paint is already clipped; this measures against the clamp
 * the browser applied rather than recomputing it here.
 */
export function CollapsibleCommentBody({ children }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  const clipRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const clipId = useId();

  useLayoutEffect(() => {
    // Only the collapsed box knows the clamp height, and an open body
    // keeps its toggle regardless — so nothing here has to run until it
    // collapses again, at which point this effect re-runs and re-measures.
    if (expanded) return;
    const clip = clipRef.current;
    const content = contentRef.current;
    if (!clip || !content) return;

    const measure = () => setClipped(isClipped(content.scrollHeight, clip.clientHeight));
    measure();

    if (typeof ResizeObserver === 'undefined') return;
    // Everything that changes the body's height after the first paint —
    // an edit, the pane resizing, a markdown image loading, a font
    // swapping in — arrives as a resize of the content box.
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <div className="ic-row-body">
      <div
        ref={clipRef}
        id={clipId}
        className={expanded ? 'ic-body-clip ic-body-clip-open' : 'ic-body-clip'}
        data-clipped={clipped && !expanded ? 'true' : undefined}
      >
        <div ref={contentRef}>
          <InlineCommentMarkdown>{children}</InlineCommentMarkdown>
        </div>
      </div>
      {clipped && (
        <button
          type="button"
          className="ic-btn ic-btn-link ic-body-toggle"
          aria-expanded={expanded}
          aria-controls={clipId}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
