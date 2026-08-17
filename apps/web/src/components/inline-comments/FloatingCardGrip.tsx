import { DragHandleDots2Icon } from '@radix-ui/react-icons';
import type { FloatingCardDrag } from './useFloatingCardDrag.js';

/**
 * The grab area of a floating card, mirroring its close button in the
 * opposite corner. A handle rather than a draggable card body: text
 * inside the card stays selectable, and so does the document text the
 * card was pushed aside to uncover.
 */
export function FloatingCardGrip({ drag, label }: { drag: FloatingCardDrag; label: string }) {
  return (
    <button
      type="button"
      className="ic-float-grip"
      aria-label={drag.moved ? `${label} (activate to send it back)` : label}
      title={
        drag.moved
          ? 'Drag to move · click to send it back to the text'
          : 'Drag to move out of the way'
      }
      {...drag.handleProps}
    >
      <DragHandleDots2Icon aria-hidden="true" />
    </button>
  );
}
