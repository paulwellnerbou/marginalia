/**
 * What a `#fragment` in a document link points at. Element ids first;
 * failing that, `separator-N` names the document's N-th separator, so a
 * run of text the statistics split off at one can be linked like a
 * heading. `separator-0` is the document's start.
 */

const SEPARATOR_PREFIX = 'separator-';
const SEPARATOR_RE = /^separator-(\d+)$/;

export function separatorFragment(n: number): string {
  return `${SEPARATOR_PREFIX}${n}`;
}

export function findFragmentTarget(root: HTMLElement, id: string): Element | null {
  const byId = root.querySelector(`[id="${CSS.escape(id)}"]`);
  if (byId) return byId;
  const match = SEPARATOR_RE.exec(id);
  if (!match) return null;
  const n = Number(match[1]);
  if (n === 0) return root;
  // Only top-level separators carry a block id, and those are what the
  // statistics count.
  return root.querySelectorAll('hr[data-block]')[n - 1] ?? null;
}
