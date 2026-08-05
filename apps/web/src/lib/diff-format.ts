import type { DiffLine } from './line-diff.js';

/**
 * Formats diff lines as a unified diff with full context (a single hunk),
 * suitable for pasting into bug reports or applying with `patch`.
 */
export function formatUnifiedDiff(lines: DiffLine[]): string {
  const oldCount = lines.filter((line) => line.op !== 'add').length;
  const newCount = lines.filter((line) => line.op !== 'remove').length;
  const body = lines.map(
    (line) => (line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' ') + line.text,
  );
  // A side with no lines starts at 0, not 1 — what `diff -u` emits, and
  // what patch(1) expects.
  const range = (count: number) => `${count === 0 ? 0 : 1},${count}`;
  const hunk = `@@ -${range(oldCount)} +${range(newCount)} @@`;
  return ['--- before', '+++ after', hunk, ...body].join('\n');
}
