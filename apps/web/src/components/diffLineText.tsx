import type { DiffLine } from '../lib/line-diff.js';

/**
 * A diff line's text, with the words that changed marked up.
 *
 * Kept apart from any one view because the same line is drawn twice over:
 * once in the unified diff, and once inside a conflict hunk's side, where
 * the words are all that distinguishes two near-identical paragraphs.
 */
export function renderDiffLineText(line: DiffLine): React.ReactNode {
  if (!line.text) return ' ';
  if (!line.segments?.length) return line.text;

  const occurrences = new Map<string, number>();
  return line.segments.map((segment) => {
    const signature = `${segment.changed ? '1' : '0'}\0${segment.text}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    const key = `${signature}\0${occurrence}`;

    return segment.changed ? (
      <span key={key} className="diff-inline-change">
        {segment.text}
      </span>
    ) : (
      <span key={key}>{segment.text}</span>
    );
  });
}
