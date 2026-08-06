/**
 * Shared resolution of "where does this comment anchor live in the
 * rendered document" — used both to scroll to a thread and to predict
 * where such a scroll would land (toolbar next/prev), so the two can
 * never disagree.
 */

export function resolveAnchorElement(
  root: HTMLElement,
  blockId: string,
  quote?: string | null,
): HTMLElement | null {
  const escaped = CSS.escape(blockId);
  const target = root.querySelector<HTMLElement>(
    `[data-block="${escaped}"], [data-subblock="${escaped}"]`,
  );
  if (!target) return null;
  if (!target.dataset.block || !quote) return target;

  // Recovery for comments anchored before sub-block-aware capture
  // landed: their stored block_id points at the enclosing top-level
  // block. If the quote uniquely identifies one sub-block, use that
  // instead of the whole container.
  const subEls = target.querySelectorAll<HTMLElement>('[data-subblock]');
  let narrowed: HTMLElement | null = null;
  let unique = true;
  for (const sub of subEls) {
    const text = (sub.textContent ?? '').replace(/\s+/gu, ' ').trim();
    if (!text.includes(quote)) continue;
    if (narrowed) {
      unique = false;
      break;
    }
    narrowed = sub;
  }
  return unique && narrowed ? narrowed : target;
}

/**
 * The element a thread jump scrolls to: the thread's highlight mark
 * when one exists, else the anchor block. Marks list every thread of
 * a merged range in `data-comment-thread-ids`, so threads sharing the
 * same quoted text still resolve to their (shared) mark.
 */
export function resolveThreadScrollTarget(
  root: HTMLElement,
  blockId: string,
  quote?: string | null,
  threadId?: string | null,
): HTMLElement | null {
  if (threadId) {
    const mark = root.querySelector<HTMLElement>(
      `mark[data-comment-thread-ids~="${CSS.escape(threadId)}"]`,
    );
    if (mark) return mark;
  }
  return resolveAnchorElement(root, blockId, quote);
}
