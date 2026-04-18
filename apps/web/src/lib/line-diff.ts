/**
 * Minimal line-level diff. Returns a list of hunks marking equal / added /
 * removed segments. Uses the classic LCS algorithm — good enough for small
 * paragraph-sized inputs; larger inputs short-circuit to a naive diff to
 * keep memory bounded.
 */

export type DiffOp = 'equal' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  text: string;
}

/** Max cells in the DP table before we fall back. 500k ≈ 4MB at 8B/number,
 *  well within budget even on modest devices; beyond that the LCS walk
 *  gets noticeably slow so we hand back a simple line-by-line diff. */
const LCS_MAX_CELLS = 500_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;

  if ((n + 1) * (m + 1) > LCS_MAX_CELLS) return naiveDiff(a, b);

  // LCS DP table
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
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
  return out;
}

/**
 * Fallback when the DP table would be too large. Walks both sides in
 * lockstep, marking matching lines as equal and differing positions as
 * remove+add pairs. Not minimal, but O(n+m) time & memory and readable
 * enough that the diff is still useful.
 */
function naiveDiff(a: string[], b: string[]): DiffLine[] {
  const out: DiffLine[] = [];
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
  return out;
}
