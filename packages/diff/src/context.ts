import type { DiffLine } from './line-diff.js';

/**
 * A run of unchanged lines the sender dropped. Carries the count so the
 * receiver can keep old/new line numbering correct across the gap and render
 * the same "N unchanged lines hidden" row it renders when it trims locally.
 */
export interface DiffSkip {
  op: 'skip';
  skipped: number;
}

/** What goes on the wire: the rendering shape, plus gaps where lines were elided. */
export type WireDiffLine = DiffLine | DiffSkip;

/**
 * Drop unchanged lines further than `contextLines` from any change, replacing
 * each dropped run with a single `skip`. Mirrors the windowing DiffView applies
 * client-side, so trimming here and trimming there produce the same rows.
 */
export function sliceToContext(lines: DiffLine[], contextLines: number): WireDiffLine[] {
  const context = Math.max(0, Math.floor(contextLines));
  const changed: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.op !== 'equal') changed.push(i);
  }
  if (changed.length === 0) return [];

  const windows: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const last = windows.at(-1);
    // Merge windows that touch or overlap: a one-line gap costs more as a
    // "1 line hidden" row than as the line itself.
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else windows.push({ start, end });
  }

  const out: WireDiffLine[] = [];
  let cursor = 0;
  for (const window of windows) {
    if (window.start > cursor) out.push({ op: 'skip', skipped: window.start - cursor });
    out.push(...lines.slice(window.start, window.end + 1));
    cursor = window.end + 1;
  }
  if (cursor < lines.length) out.push({ op: 'skip', skipped: lines.length - cursor });
  return out;
}
