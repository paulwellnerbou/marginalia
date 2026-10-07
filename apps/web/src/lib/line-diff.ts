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
/** Consecutive tokens a neighbouring line must share verbatim with a pair to
 *  join it as the other half of a split or merged paragraph. A run, not an
 *  overlap ratio, because the half that kept its sentence is often mostly new
 *  text, and common words alone match just as often by chance. */
const SPLIT_MIN_SHARED_RUN = 5;

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

    for (const group of growPairs(removes, adds, pairLines(removes, adds))) {
      const inline = diffInline(
        group.removes.map((line) => line.text).join('\n'),
        group.adds.map((line) => line.text).join('\n'),
      );
      assignSegments(group.removes, inline.before);
      assignSegments(group.adds, inline.after);
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

  if ((n + 1) * (m + 1) > PAIRING_MAX_CELLS) {
    const byPosition: Array<[DiffLine, DiffLine]> = [];
    for (let i = 0; i < Math.min(n, m); i++) {
      // The floor matters more here than in the table below: pairing by
      // position lines up whatever happens to sit at the same offset, which
      // for a block of wholly new text is a different line every time. Only
      // the pairs on the diagonal are ever considered, so only they are worth
      // tokenizing — the block that got here may be a whole document long.
      if (isRewriteOf(removes[i]!, adds[i]!)) byPosition.push([removes[i]!, adds[i]!]);
    }
    return byPosition;
  }

  const removeTokens = removes.map((line) => tokenBag(line.text));
  const addTokens = adds.map((line) => tokenBag(line.text));
  const pairScore = (i: number, j: number): number => {
    const sim = similarity(removeTokens[i]!, addTokens[j]!);
    return sim >= PAIRING_MIN_SIMILARITY ? sim : Number.NEGATIVE_INFINITY;
  };

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

interface RewriteGroup {
  removes: DiffLine[];
  adds: DiffLine[];
}

/**
 * Widens each pair to the unpaired lines beside it that carry part of its text,
 * so a paragraph split in two — or two merged into one — is word-diffed against
 * all of where its words went. Paired one-to-one, the sentence that moved to
 * the other half shows as deleted, and that half shows as wholly new.
 */
function growPairs(
  removes: DiffLine[],
  adds: DiffLine[],
  pairs: Array<[DiffLine, DiffLine]>,
): RewriteGroup[] {
  const claimed = new Set<DiffLine>(pairs.flat());
  return pairs.map(([removeLine, addLine]) => {
    const group: RewriteGroup = { removes: [removeLine], adds: [addLine] };
    absorbNeighbours(group.adds, adds, group.removes, claimed);
    absorbNeighbours(group.removes, removes, group.adds, claimed);
    return group;
  });
}

function absorbNeighbours(
  members: DiffLine[],
  side: DiffLine[],
  partners: DiffLine[],
  claimed: Set<DiffLine>,
): void {
  const partnerRuns = tokenRuns(partners.map((line) => line.text).join('\n'));
  const absorb = (from: number, step: -1 | 1) => {
    for (let i = from + step; i >= 0 && i < side.length; i += step) {
      const line = side[i]!;
      if (!line.text.trim()) continue;
      if (claimed.has(line) || !sharesRun(line.text, partnerRuns)) return;
      claimed.add(line);
      if (step < 0) members.unshift(line);
      else members.push(line);
    }
  };
  absorb(side.indexOf(members[0]!), -1);
  absorb(side.indexOf(members.at(-1)!), 1);
}

function runTokens(text: string): string[] {
  return tokenizeInline(text).filter((token) => token.trim());
}

function tokenRuns(text: string): Set<string> {
  const tokens = runTokens(text);
  const runs = new Set<string>();
  for (let i = 0; i + SPLIT_MIN_SHARED_RUN <= tokens.length; i++) {
    runs.add(tokens.slice(i, i + SPLIT_MIN_SHARED_RUN).join('\0'));
  }
  return runs;
}

function sharesRun(text: string, runs: Set<string>): boolean {
  const tokens = runTokens(text);
  for (let i = 0; i + SPLIT_MIN_SHARED_RUN <= tokens.length; i++) {
    if (runs.has(tokens.slice(i, i + SPLIT_MIN_SHARED_RUN).join('\0'))) return true;
  }
  return false;
}

/** Deals a group's segments back out to its lines, which were joined by "\n". */
function assignSegments(lines: DiffLine[], segments: DiffSegment[]): void {
  const perLine: DiffSegment[][] = [[]];
  for (const segment of segments) {
    segment.text.split('\n').forEach((part, index) => {
      if (index > 0) perLine.push([]);
      pushSegment(perLine.at(-1)!, segment.changed, part);
    });
  }
  lines.forEach((line, index) => {
    line.segments = perLine[index] ?? [];
  });
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

/** Whether two lines share enough tokens to read as a rewrite of each other. */
function isRewriteOf(remove: DiffLine, add: DiffLine): boolean {
  return similarity(tokenBag(remove.text), tokenBag(add.text)) >= PAIRING_MIN_SIMILARITY;
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
