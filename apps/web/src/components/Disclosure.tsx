import { ChevronDownIcon } from '@radix-ui/react-icons';
import { type ReactNode, useId } from 'react';

interface Props {
  summary: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** Extra class on the wrapper, for spacing at the call site. */
  className?: string;
}

/**
 * A labelled section that expands and collapses under its own heading.
 *
 * Controlled rather than a `<details>` element: the height animation
 * needs the body laid out while closed, and a closed `<details>` does
 * not render its content at all. Keeping it mounted also lets callers
 * gate work on `open` — a collapsed body measures zero, which is worse
 * than not measuring.
 *
 * The choreography (height, then a staggered cross-fade behind it) is
 * the same one the document-view section collapse and the TOC subtree
 * use; the class names are the third copy of it, so they are generic.
 */
export function Disclosure({ summary, open, onOpenChange, children, className }: Props) {
  const bodyId = useId();
  return (
    <div className={className ? `disclosure ${className}` : 'disclosure'}>
      <button
        type="button"
        className="disclosure-summary"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => onOpenChange(!open)}
      >
        {/* One icon rotated in CSS so the chevron turns in lockstep with
            the height rather than swapping glyphs halfway through. */}
        <ChevronDownIcon className="disclosure-chevron" aria-hidden="true" />
        <span>{summary}</span>
      </button>
      {/* Always rendered so the body animates in and out rather than
          popping; `inert` keeps a closed body out of the focus order and
          the accessibility tree. */}
      <div className={open ? 'disclosure-body' : 'disclosure-body is-collapsed'}>
        <div className="disclosure-body-inner" id={bodyId} inert={!open}>
          {children}
        </div>
      </div>
    </div>
  );
}
