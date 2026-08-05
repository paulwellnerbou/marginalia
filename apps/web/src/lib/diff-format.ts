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
  return ['--- before', '+++ after', `@@ -1,${oldCount} +1,${newCount} @@`, ...body].join('\n');
}
