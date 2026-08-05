/**
 * Minimal line-level diff. Returns a list of hunks marking equal / added /
 * removed segments. Trims the common prefix/suffix, then runs the classic
 * LCS algorithm on the changed middle; only when that middle is still huge
 * does it short-circuit to a naive diff to keep memory bounded.
 */

export type DiffOp = 'equal' | 'add' | 'remove';

export interface DiffSegment {
  changed: boolean;
  text: string;
}

export interface DiffLine {
  op: DiffOp;
  text: string;
  segments?: DiffSegment[];
}

/** Max cells in the DP table before we fall back. 500k ≈ 4MB at 8B/number,
 *  well within budget even on modest devices; beyond that the LCS walk
 *  gets noticeably slow so we hand back a simple line-by-line diff. */
const LCS_MAX_CELLS = 500_000;
const INLINE_LCS_MAX_CELLS = 20_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');

  // Trim the common prefix/suffix so the LCS only sees the changed middle.
  // Without this, a localized edit in a long document blows past
  // LCS_MAX_CELLS and degrades to the lockstep fallback, which renders an
  // insertion as remove+add pairs of unrelated lines from there on down.
  let prefix = 0;
  const maxPrefix = Math.min(a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (suffix < maxSuffix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const out: DiffLine[] = [];
  for (let k = 0; k < prefix; k++) out.push({ op: 'equal', text: a[k]! });
  diffTrimmedLines(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix), out);
  for (let k = a.length - suffix; k < a.length; k++) out.push({ op: 'equal', text: a[k]! });
  annotateInlineDiffs(out);
  return out;
}

function diffTrimmedLines(a: string[], b: string[], out: DiffLine[]): void {
  const n = a.length;
  const m = b.length;

  if ((n + 1) * (m + 1) > LCS_MAX_CELLS) {
    naiveDiff(a, b, out);
    return;
  }

  // LCS DP table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'equal', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ op: 'remove', text: a[i]! });
      i++;
    } else {
      out.push({ op: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < n) {
    out.push({ op: 'remove', text: a[i++]! });
  }
  while (j < m) {
    out.push({ op: 'add', text: b[j++]! });
  }
}

/**
 * Fallback when the DP table would be too large even after trimming, i.e.
 * changes span most of a very long document. Walks both sides in lockstep,
 * marking matching lines as equal and differing positions as remove+add
 * pairs. Not minimal, but O(n+m) time & memory.
 */
function naiveDiff(a: string[], b: string[], out: DiffLine[]): void {
  const len = Math.max(a.length, b.length);
  for (let k = 0; k < len; k++) {
    const av = a[k];
    const bv = b[k];
    if (av !== undefined && bv !== undefined && av === bv) {
      out.push({ op: 'equal', text: av });
    } else {
      if (av !== undefined) out.push({ op: 'remove', text: av });
      if (bv !== undefined) out.push({ op: 'add', text: bv });
    }
  }
}

function annotateInlineDiffs(lines: DiffLine[]): void {
  let blockStart = 0;
  while (blockStart < lines.length) {
    while (blockStart < lines.length && lines[blockStart]!.op === 'equal') blockStart++;
    if (blockStart >= lines.length) return;

    let blockEnd = blockStart;
    while (blockEnd < lines.length && lines[blockEnd]!.op !== 'equal') blockEnd++;

    const removes: DiffLine[] = [];
    const adds: DiffLine[] = [];
    for (let i = blockStart; i < blockEnd; i++) {
      const line = lines[i]!;
      if (line.op === 'remove') removes.push(line);
      else if (line.op === 'add') adds.push(line);
    }

    const pairCount = Math.min(removes.length, adds.length);
    for (let i = 0; i < pairCount; i++) {
      const removeLine = removes[i]!;
      const addLine = adds[i]!;
      const inline = diffInline(removeLine.text, addLine.text);
      removeLine.segments = inline.before;
      addLine.segments = inline.after;
    }

    blockStart = blockEnd;
  }
}

function diffInline(
  before: string,
  after: string,
): { before: DiffSegment[]; after: DiffSegment[] } {
  if (before === after) {
    return {
      before: [{ changed: false, text: before }],
      after: [{ changed: false, text: after }],
    };
  }

  const a = tokenizeInline(before);
  const b = tokenizeInline(after);
  if ((a.length + 1) * (b.length + 1) > INLINE_LCS_MAX_CELLS) {
    return diffInlineByEdges(before, after);
  }

  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const beforeSegments: DiffSegment[] = [];
  const afterSegments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pushSegment(beforeSegments, false, a[i]!);
      pushSegment(afterSegments, false, b[j]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      pushSegment(beforeSegments, true, a[i]!);
      i++;
    } else {
      pushSegment(afterSegments, true, b[j]!);
      j++;
    }
  }
  while (i < a.length) pushSegment(beforeSegments, true, a[i++]!);
  while (j < b.length) pushSegment(afterSegments, true, b[j++]!);

  return { before: beforeSegments, after: afterSegments };
}

function diffInlineByEdges(
  before: string,
  after: string,
): { before: DiffSegment[]; after: DiffSegment[] } {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;

  let beforeSuffix = before.length;
  let afterSuffix = after.length;
  while (
    beforeSuffix > prefix &&
    afterSuffix > prefix &&
    before[beforeSuffix - 1] === after[afterSuffix - 1]
  ) {
    beforeSuffix--;
    afterSuffix--;
  }

  return {
    before: compactSegments([
      { changed: false, text: before.slice(0, prefix) },
      { changed: true, text: before.slice(prefix, beforeSuffix) },
      { changed: false, text: before.slice(beforeSuffix) },
    ]),
    after: compactSegments([
      { changed: false, text: after.slice(0, prefix) },
      { changed: true, text: after.slice(prefix, afterSuffix) },
      { changed: false, text: after.slice(afterSuffix) },
    ]),
  };
}

function tokenizeInline(text: string): string[] {
  return text.match(/(\s+|[\p{L}\p{N}\p{M}_]+|[^\s\p{L}\p{N}\p{M}_])/gu) ?? [text];
}

function pushSegment(segments: DiffSegment[], changed: boolean, text: string): void {
  if (!text) return;
  const last = segments.at(-1);
  if (last && last.changed === changed) {
    last.text += text;
    return;
  }
  segments.push({ changed, text });
}

function compactSegments(segments: DiffSegment[]): DiffSegment[] {
  const out: DiffSegment[] = [];
  for (const segment of segments) pushSegment(out, segment.changed, segment.text);
  return out;
}
