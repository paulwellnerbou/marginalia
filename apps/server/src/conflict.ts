import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Three-way merging, and the structure a human needs to resolve what
 * the merge could not.
 *
 * Sides are named for what they mean here rather than for git's
 * ours/base/theirs: `current` is the document as it stands, `proposed`
 * is what an edit proposal asks for, `base` is the source both were
 * written against.
 */
export interface ThreeWaySides {
  current: string;
  base: string;
  proposed: string;
}

/** A run of text the merge agreed on, or one it could not. */
export type ConflictSegment =
  | { kind: 'stable'; text: string }
  | {
      kind: 'conflict';
      current: string;
      base: string;
      proposed: string;
      /**
       * The side a resolver can take without a human deciding, or null
       * when the two edits genuinely disagree. Only set for hunks whose
       * sides differ by something that carries no meaning (trailing
       * whitespace) or where one side never moved off `base`.
       */
      auto: ConflictChoice | null;
    };

export type ConflictChoice = 'current' | 'proposed' | 'both';

export type ThreeWayMerge =
  | { ok: true; text: string }
  | { ok: false; reason: 'conflict'; marked: string; segments: ConflictSegment[] }
  | { ok: false; reason: 'unavailable' };

/**
 * Long markers instead of git's default seven characters. The sides of
 * a conflict are document text, and in Markdown a line of exactly seven
 * `=` is a setext heading underline, not a separator — parsing that as
 * one splits a hunk in the wrong place. Twenty-one is past anything
 * prose produces by accident.
 */
const MARKER_SIZE = 21;
const MARKER = (char: string) => char.repeat(MARKER_SIZE);
const OPEN_MARKER = MARKER('<');
const BASE_MARKER = MARKER('|');
const SEPARATOR = MARKER('=');
const CLOSE_MARKER = MARKER('>');

/**
 * Only warn once per process. A missing `git` makes every proposal in
 * every document take this path, and one line per accept attempt would
 * bury the signal it exists to give.
 */
let warnedMergeToolUnavailable = false;

/**
 * Three-way merge via `git merge-file`.
 *
 * `unavailable` (the binary is missing, unrunnable, or its output blew
 * the buffer) is kept apart from `conflict` because the two mean
 * opposite things to a user: a conflict is theirs to resolve, an
 * unavailable merge tool is the deployment's. Collapsing them makes a
 * server without git report every non-trivial proposal as unresolvable.
 */
export async function mergeThreeWay(sides: ThreeWaySides): Promise<ThreeWayMerge> {
  // A marker has to start its own line, so git terminates the last line
  // of a conflict region whether or not the input had a terminator.
  // Block ranges don't carry one, and that invented newline would ride
  // along into whatever the resolver splices back. Add it deliberately
  // and take it off again.
  const padded = needsTerminator(sides);
  const merged = await runMergeFile(padded ? terminate(sides) : sides);
  return padded ? stripInventedTerminator(merged) : merged;
}

async function runMergeFile(sides: ThreeWaySides): Promise<ThreeWayMerge> {
  const dir = mkdtempSync(join(tmpdir(), 'marginalia-merge-'));
  try {
    const currentPath = join(dir, 'current');
    const basePath = join(dir, 'base');
    const proposedPath = join(dir, 'proposed');
    writeFileSync(currentPath, sides.current);
    writeFileSync(basePath, sides.base);
    writeFileSync(proposedPath, sides.proposed);
    const { stdout } = await execFileAsync(
      'git',
      [
        'merge-file',
        '-p',
        '--diff3',
        `--marker-size=${MARKER_SIZE}`,
        '-L',
        'current',
        '-L',
        'base',
        '-L',
        'proposed',
        currentPath,
        basePath,
        proposedPath,
      ],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
    );
    // A clean exit means git merged everything; markers left in the
    // output came in with the inputs, and passing those through would
    // hand a caller text it will read back as a conflict forever.
    if (stdout.includes(OPEN_MARKER)) return conflictResult(stdout);
    return { ok: true, text: stdout };
  } catch (err) {
    // merge-file exits with the number of conflicts, capped at 127; a
    // negative status (255 here) or a non-numeric code means it failed
    // to run at all rather than finding conflicting hunks.
    const code = (err as { code?: string | number }).code;
    if (typeof code === 'number' && code >= 1 && code <= 127) {
      const stdout = (err as { stdout?: string }).stdout;
      if (typeof stdout === 'string') return conflictResult(stdout);
      return { ok: false, reason: 'conflict', marked: '', segments: [] };
    }
    if (!warnedMergeToolUnavailable) {
      warnedMergeToolUnavailable = true;
      // Message only — a spawn failure's stack points at node internals
      // and buries the one line that says what to fix.
      console.error(
        '[marginalia] `git merge-file` is unavailable, so proposals needing a three-way merge cannot be accepted. Install git in the runtime image. Cause:',
        err instanceof Error ? err.message : err,
      );
    }
    return { ok: false, reason: 'unavailable' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function conflictResult(marked: string): ThreeWayMerge {
  return { ok: false, reason: 'conflict', marked, segments: parseConflictSegments(marked) };
}

/** True when some non-empty side would have to be terminated to merge. */
function needsTerminator(sides: ThreeWaySides): boolean {
  return [sides.current, sides.base, sides.proposed].some(
    (side) => side !== '' && !side.endsWith('\n'),
  );
}

function terminate(sides: ThreeWaySides): ThreeWaySides {
  const pad = (side: string) => (side === '' || side.endsWith('\n') ? side : `${side}\n`);
  return { current: pad(sides.current), base: pad(sides.base), proposed: pad(sides.proposed) };
}

/**
 * Undo `terminate` on the merge's tail, so reassembling the segments
 * gives back text that ends the way the inputs did. Only the last
 * segment can carry the added newline; terminators inside the document
 * were always real.
 */
function stripInventedTerminator(merged: ThreeWayMerge): ThreeWayMerge {
  const chop = (text: string) => (text.endsWith('\n') ? text.slice(0, -1) : text);
  if (merged.ok) return { ok: true, text: chop(merged.text) };
  if (merged.reason !== 'conflict') return merged;

  const segments = [...merged.segments];
  const last = segments.at(-1);
  if (last?.kind === 'stable') {
    segments[segments.length - 1] = { ...last, text: chop(last.text) };
  } else if (last?.kind === 'conflict') {
    segments[segments.length - 1] = {
      ...last,
      current: chop(last.current),
      base: chop(last.base),
      proposed: chop(last.proposed),
    };
  }
  return { ok: false, reason: 'conflict', marked: chop(merged.marked), segments };
}

/**
 * Split `git merge-file --diff3` output into the runs it merged and the
 * hunks it left marked.
 *
 * Concatenating every `stable` segment with one chosen side per
 * `conflict` segment reproduces a complete document — that identity is
 * what the resolver UI is built on, so segments keep their own line
 * terminators rather than being re-joined later.
 */
export function parseConflictSegments(marked: string): ConflictSegment[] {
  const lines = splitLines(marked);
  const segments: ConflictSegment[] = [];
  let stable: string[] = [];

  const flushStable = () => {
    if (stable.length === 0) return;
    segments.push({ kind: 'stable', text: stable.join('') });
    stable = [];
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!startsWith(line, OPEN_MARKER)) {
      stable.push(line);
      continue;
    }
    const hunk = readHunk(lines, i);
    // An opener with no closer is truncated output, not a hunk. Treat
    // the rest as stable text so the segments still reassemble into the
    // document instead of silently dropping its tail.
    if (!hunk) {
      stable.push(line);
      continue;
    }
    flushStable();
    segments.push(hunk.segment);
    i = hunk.nextIndex - 1;
  }
  flushStable();
  return segments;
}

function readHunk(
  lines: string[],
  start: number,
): { segment: ConflictSegment; nextIndex: number } | null {
  const current: string[] = [];
  const base: string[] = [];
  const proposed: string[] = [];
  let section: 'current' | 'base' | 'proposed' = 'current';

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (startsWith(line, BASE_MARKER)) {
      section = 'base';
      continue;
    }
    if (startsWith(line, SEPARATOR)) {
      section = 'proposed';
      continue;
    }
    if (startsWith(line, CLOSE_MARKER)) {
      const sides = {
        current: current.join(''),
        base: base.join(''),
        proposed: proposed.join(''),
      };
      return {
        segment: { kind: 'conflict', ...sides, auto: autoResolution(sides) },
        nextIndex: i + 1,
      };
    }
    if (section === 'current') current.push(line);
    else if (section === 'base') base.push(line);
    else proposed.push(line);
  }
  return null;
}

/**
 * Whether a hunk can be settled without asking. git conflicts on
 * *adjacent* edits, not only contradictory ones, so a hunk where one
 * side never moved — or where both arrived at the same text modulo
 * trailing whitespace — has an answer that loses nothing.
 */
export function autoResolution(sides: ThreeWaySides): ConflictChoice | null {
  if (sides.current === sides.proposed) return 'current';
  const current = normalize(sides.current);
  const base = normalize(sides.base);
  const proposed = normalize(sides.proposed);
  if (current === proposed) return 'current';
  if (current === base) return 'proposed';
  if (proposed === base) return 'current';
  return null;
}

/** Text of a hunk under one choice. `both` keeps the document's first. */
export function applyChoice(
  segment: Extract<ConflictSegment, { kind: 'conflict' }>,
  choice: ConflictChoice,
): string {
  if (choice === 'current') return segment.current;
  if (choice === 'proposed') return segment.proposed;
  return joinSides(segment.current, segment.proposed);
}

/**
 * Reassemble a document from its segments and one choice per conflict,
 * indexed by the conflict's position among conflicts (not among all
 * segments) — the resolver UI numbers hunks the same way.
 */
export function resolveSegments(
  segments: ConflictSegment[],
  choices: ReadonlyArray<ConflictChoice | string>,
): string {
  let conflictIndex = 0;
  let out = '';
  for (const segment of segments) {
    if (segment.kind === 'stable') {
      out += segment.text;
      continue;
    }
    const choice = choices[conflictIndex];
    conflictIndex += 1;
    out += isChoice(choice) ? applyChoice(segment, choice) : (choice ?? segment.current);
  }
  return out;
}

function isChoice(value: unknown): value is ConflictChoice {
  return value === 'current' || value === 'proposed' || value === 'both';
}

/**
 * Concatenate both sides, guaranteeing the seam falls on a line break —
 * without it a document side that lost its trailing newline would weld
 * its last line onto the proposal's first.
 */
function joinSides(current: string, proposed: string): string {
  if (current === '') return proposed;
  if (proposed === '') return current;
  return current.endsWith('\n') ? current + proposed : `${current}\n${proposed}`;
}

/** Trailing whitespace only — indentation is meaningful in both formats. */
function normalize(text: string): string {
  return text.replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
}

function startsWith(line: string, marker: string): boolean {
  if (!line.startsWith(marker)) return false;
  const rest = line.slice(marker.length).replace(/\r?\n$/, '');
  // Markers carry an optional ` <label>`; a longer run of the same
  // character is document text that happens to open the same way.
  return rest === '' || rest.startsWith(' ');
}

/** Split keeping each line's terminator, so joins are lossless. */
function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
