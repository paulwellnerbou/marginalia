/**
 * Line-level diff for the diff view. jsdiff does the sequence matching — the
 * same library packages/renderer uses for DOCX tracked changes — and this
 * module adds the part it has no opinion on: which removed line each added
 * line is a rewrite of, so that pair can be highlighted word by word.
 */

import { Diff, diffArrays } from 'diff';

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

/** Edit distance past which we stop looking for a minimal diff and render the
 *  whole thing as one block replacement. jsdiff searches without a bound by
 *  default, and two wholly different documents then take tens of seconds with
 *  the tab frozen. The bail-out costs ~270ms whatever the document size, and
 *  2000 still covers rewording half the lines of a 2000-line document. */
const MAX_LINE_EDIT_DISTANCE = 2_000;
/** Same guard one level down, and lower because it is paid per paired line.
 *  Only lines that already passed PAIRING_MIN_SIMILARITY get here, so reaching
 *  1000 token edits takes a pair of enormous near-identical lines. */
const MAX_INLINE_EDIT_DISTANCE = 1_000;
/** Max cells in the remove/add pairing table before we fall back to pairing by
 *  position. */
const PAIRING_MAX_CELLS = 10_000;
/** Token overlap below which two lines count as unrelated and stay unpaired,
 *  so a rewritten line renders as a whole-line change instead of a scattering
 *  of coincidental word matches. */
const PAIRING_MIN_SIMILARITY = 0.3;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const changes = diffArrays(a, b, { maxEditLength: MAX_LINE_EDIT_DISTANCE });

  const out: DiffLine[] = [];
  if (changes) {
    for (const change of changes) {
      const op: DiffOp = change.added ? 'add' : change.removed ? 'remove' : 'equal';
      for (const text of change.value) out.push({ op, text });
    }
  } else {
    for (const text of a) out.push({ op: 'remove', text });
    for (const text of b) out.push({ op: 'add', text });
  }

  annotateInlineDiffs(out);
  return out;
}

function annotateInlineDiffs(lines: DiffLine[]): void {
  let blockStart = 0;
  while (blockStart < lines.length) {
    while (blockStart < lines.length && lines[blockStart]!.op === 'equal') blockStart++;
    if (blockStart >= lines.length) return;

    // A blank line that survived unchanged is a paragraph break, not the end of
    // an edit. Where it lands between a removed paragraph and its rewrite is a
    // coin toss between equally minimal diffs, so spanning it is what keeps the
    // two recognizable as a pair.
    let scan = blockStart;
    let blockEnd = blockStart;
    while (scan < lines.length) {
      const line = lines[scan]!;
      if (line.op !== 'equal') blockEnd = ++scan;
      else if (!line.text.trim()) scan++;
      else break;
    }

    const removes: DiffLine[] = [];
    const adds: DiffLine[] = [];
    for (let i = blockStart; i < blockEnd; i++) {
      const line = lines[i]!;
      if (line.op === 'remove') removes.push(line);
      else if (line.op === 'add') adds.push(line);
    }

    for (const [removeLine, addLine] of pairLines(removes, adds)) {
      const inline = diffInline(removeLine.text, addLine.text);
      removeLine.segments = inline.before;
      addLine.segments = inline.after;
    }

    blockStart = blockEnd;
  }
}

/**
 * Picks which removed line each added line is the rewrite of, as the
 * order-preserving assignment with the highest total token overlap. Pairing by
 * position instead would word-diff unrelated lines whenever a block mixes an
 * insertion with an edit — e.g. a new paragraph in front of a lightly reworded
 * one, where the reworded pair sits at different offsets on the two sides.
 */
function pairLines(removes: DiffLine[], adds: DiffLine[]): Array<[DiffLine, DiffLine]> {
  const n = removes.length;
  const m = adds.length;
  if (n === 0 || m === 0) return [];

  const removeTokens = removes.map((line) => tokenBag(line.text));
  const addTokens = adds.map((line) => tokenBag(line.text));
  const pairScore = (i: number, j: number): number => {
    const sim = similarity(removeTokens[i]!, addTokens[j]!);
    return sim >= PAIRING_MIN_SIMILARITY ? sim : Number.NEGATIVE_INFINITY;
  };

  if ((n + 1) * (m + 1) > PAIRING_MAX_CELLS) {
    const byPosition: Array<[DiffLine, DiffLine]> = [];
    for (let i = 0; i < Math.min(n, m); i++) {
      // The floor matters more here than in the DP: pairing by position lines
      // up whatever happens to sit at the same offset, which for a block of
      // wholly new text is a different line every time.
      if (pairScore(i, i) > Number.NEGATIVE_INFINITY) byPosition.push([removes[i]!, adds[i]!]);
    }
    return byPosition;
  }

  // best[i][j] = highest total similarity reachable from removes[i..]/adds[j..].
  const best: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      best[i]![j] = Math.max(
        pairScore(i, j) + best[i + 1]![j + 1]!,
        best[i + 1]![j]!,
        best[i]![j + 1]!,
      );
    }
  }

  const pairs: Array<[DiffLine, DiffLine]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (pairScore(i, j) + best[i + 1]![j + 1]! >= best[i]![j]!) {
      pairs.push([removes[i]!, adds[j]!]);
      i++;
      j++;
    } else if (best[i + 1]![j]! >= best[i]![j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

interface TokenBag {
  counts: Map<string, number>;
  size: number;
}

function tokenBag(text: string): TokenBag {
  const counts = new Map<string, number>();
  let size = 0;
  for (const token of tokenizeInline(text)) {
    if (!token.trim()) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
    size++;
  }
  return { counts, size };
}

/** Sørensen–Dice over the two token multisets: 1 for equal, 0 for disjoint. */
function similarity(a: TokenBag, b: TokenBag): number {
  if (a.size === 0 || b.size === 0) return a.size === b.size ? 1 : 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const [token, count] of small.counts) {
    shared += Math.min(count, large.counts.get(token) ?? 0);
  }
  return (2 * shared) / (a.size + b.size);
}

/**
 * Splits words from the punctuation and whitespace around them, so a reworded
 * sentence highlights the words that changed rather than the run of text
 * between the nearest shared spaces.
 */
function tokenizeInline(text: string): string[] {
  return text.match(/(\s+|[\p{L}\p{N}\p{M}_]+|[^\s\p{L}\p{N}\p{M}_])/gu) ?? [text];
}

/** jsdiff's matcher over our own tokens; its own word diff keeps whitespace
 *  attached to words, which blurs exactly the boundaries we want to show. */
class InlineTokenDiff extends Diff<string, string> {
  override tokenize(value: string): string[] {
    return tokenizeInline(value);
  }
  override join(tokens: string[]): string {
    return tokens.join('');
  }
}

const inlineTokenDiff = new InlineTokenDiff();

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

  const changes = inlineTokenDiff.diff(before, after, {
    maxEditLength: MAX_INLINE_EDIT_DISTANCE,
  });
  if (!changes) return diffInlineByEdges(before, after);

  const beforeSegments: DiffSegment[] = [];
  const afterSegments: DiffSegment[] = [];
  for (const change of changes) {
    if (!change.added) pushSegment(beforeSegments, Boolean(change.removed), change.value);
    if (!change.removed) pushSegment(afterSegments, Boolean(change.added), change.value);
  }

  return { before: beforeSegments, after: afterSegments };
}

/** Coarse stand-in for a line too long to word-diff: keep the shared ends and
 *  mark everything between them as changed. */
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
