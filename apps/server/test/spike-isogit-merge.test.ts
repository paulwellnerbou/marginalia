import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';

/**
 * Spike: does isomorphic-git's `merge` give us what branch-per-proposal
 * (issue #25) needs?
 *
 * The branch model treats each proposal as a single commit on
 * `refs/proposals/<pid>`, parented on main at create time. Accepting a
 * proposal merges that ref into main. We need to know:
 *
 *   1. Does FF work for the lone-pending case?
 *   2. Does 3-way merge cleanly combine two proposals on different
 *      paragraphs (the load-bearing case — without this, we drop to
 *      FF-or-rebase semantics)?
 *   3. Same as 2 but adjacent paragraphs (informs UX copy).
 *   4. What does iso-git surface when two proposals overlap on the same
 *      paragraph? Determines the wire shape of the conflict info.
 *
 * Each case logs the outcome. Assertions are intentionally loose — the
 * point is discovery, not regression. Read the printed summary.
 */

const FILENAME = 'document.md';

const INITIAL = `# Title

Para A baseline.

Para B baseline.

Para C baseline.
`;

interface CaseResult {
  name: string;
  outcome: 'ff' | 'merged' | 'already' | 'threw' | 'unknown';
  error?: string;
  fileAfter?: string;
  raw?: unknown;
}

const results: CaseResult[] = [];

describe('spike: isomorphic-git merge for branch-per-proposal', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-spike-'));
    await git.init({ fs, dir, defaultBranch: 'main' });
    writeFileSync(join(dir, FILENAME), INITIAL);
    await git.add({ fs, dir, filepath: FILENAME });
    await git.commit({
      fs,
      dir,
      message: 'init',
      author: { name: 'seed', email: 'seed@local' },
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Build a one-commit proposal branch with `parent = baseOid`, file
   * content = `content`, ref = `refName`. Uses plumbing so we don't
   * thrash the working tree.
   */
  async function createProposalBranch(
    refName: string,
    baseOid: string,
    content: string,
  ): Promise<string> {
    const { commit: base } = await git.readCommit({ fs, dir, oid: baseOid });
    const { tree } = await git.readTree({ fs, dir, oid: base.tree });
    const blobOid = await git.writeBlob({
      fs,
      dir,
      blob: new TextEncoder().encode(content),
    });
    const newTree = tree.map((e) => (e.path === FILENAME ? { ...e, oid: blobOid } : e));
    const newTreeOid = await git.writeTree({ fs, dir, tree: newTree });
    const ts = Math.floor(Date.now() / 1000);
    const commitOid = await git.writeCommit({
      fs,
      dir,
      commit: {
        tree: newTreeOid,
        parent: [baseOid],
        author: { name: 'proposer', email: 'p@local', timestamp: ts, timezoneOffset: 0 },
        committer: { name: 'proposer', email: 'p@local', timestamp: ts, timezoneOffset: 0 },
        message: `proposal: ${refName}\n`,
      },
    });
    await git.writeRef({ fs, dir, ref: refName, value: commitOid, force: true });
    return commitOid;
  }

  async function readMainFile(): Promise<string> {
    const headOid = await git.resolveRef({ fs, dir, ref: 'main' });
    const { commit } = await git.readCommit({ fs, dir, oid: headOid });
    const { blob } = await git.readBlob({
      fs,
      dir,
      oid: commit.tree,
      filepath: FILENAME,
    });
    return new TextDecoder().decode(blob);
  }

  async function attemptMerge(name: string, theirsRef: string): Promise<CaseResult> {
    const ts = Math.floor(Date.now() / 1000);
    let outcome: CaseResult['outcome'] = 'unknown';
    let error: string | undefined;
    let raw: unknown;
    let fileAfter: string | undefined;
    try {
      raw = await git.merge({
        fs,
        dir,
        ours: 'main',
        theirs: theirsRef,
        author: { name: 'merger', email: 'm@local', timestamp: ts, timezoneOffset: 0 },
      });
      const r = raw as {
        alreadyMerged?: boolean;
        fastForward?: boolean;
        mergeCommit?: boolean;
      };
      if (r.alreadyMerged) outcome = 'already';
      else if (r.fastForward) outcome = 'ff';
      else if (r.mergeCommit) outcome = 'merged';
      else outcome = 'unknown';
      try {
        fileAfter = await readMainFile();
      } catch {
        // fallthrough — we still record the merge outcome
      }
    } catch (err) {
      outcome = 'threw';
      const e = err as Error & {
        code?: string;
        data?: unknown;
        caller?: string;
      };
      error = `${e.code ?? e.name}: ${e.message}`;
      raw = { code: e.code, data: e.data, caller: e.caller, name: e.name };
    }
    const result: CaseResult = { name, outcome, error, fileAfter, raw };
    results.push(result);
    console.log(`[spike] ${name}:`, JSON.stringify({ outcome, error, raw }, null, 2));
    if (fileAfter) {
      console.log(`[spike] ${name} file after:\n${fileAfter}`);
    }
    return result;
  }

  test('case 1: FF accept of a lone proposal', async () => {
    const baseOid = await git.resolveRef({ fs, dir, ref: 'main' });
    const edited = INITIAL.replace('Para B baseline.', 'Para B edited by A.');
    await createProposalBranch('refs/proposals/A', baseOid, edited);
    const r = await attemptMerge('case1-ff', 'refs/proposals/A');
    expect(r.outcome).toBe('ff');
    expect(r.fileAfter).toContain('Para B edited by A.');
  });

  test('case 2: 3-way merge of two proposals on far-apart paragraphs', async () => {
    const baseOid = await git.resolveRef({ fs, dir, ref: 'main' });
    const aEdit = INITIAL.replace('Para A baseline.', 'Para A edited by A.');
    const cEdit = INITIAL.replace('Para C baseline.', 'Para C edited by C.');
    await createProposalBranch('refs/proposals/A', baseOid, aEdit);
    await createProposalBranch('refs/proposals/C', baseOid, cEdit);
    // Accept A first (FF since main hasn't moved).
    const r1 = await attemptMerge('case2-accept-A', 'refs/proposals/A');
    expect(r1.outcome).toBe('ff');
    // Now main is ahead. Try to merge C — its parent is the original
    // baseOid, so this needs a real 3-way merge.
    await attemptMerge('case2-merge-C', 'refs/proposals/C');
  });

  test('case 3: 3-way merge of two proposals on adjacent paragraphs', async () => {
    const baseOid = await git.resolveRef({ fs, dir, ref: 'main' });
    const aEdit = INITIAL.replace('Para A baseline.', 'Para A edited.');
    const bEdit = INITIAL.replace('Para B baseline.', 'Para B edited.');
    await createProposalBranch('refs/proposals/A', baseOid, aEdit);
    await createProposalBranch('refs/proposals/B', baseOid, bEdit);
    const r1 = await attemptMerge('case3-accept-A', 'refs/proposals/A');
    expect(r1.outcome).toBe('ff');
    await attemptMerge('case3-merge-B-adjacent', 'refs/proposals/B');
  });

  test('case 4: overlapping edits should surface a conflict', async () => {
    const baseOid = await git.resolveRef({ fs, dir, ref: 'main' });
    const aEdit = INITIAL.replace('Para B baseline.', 'Para B edited by A.');
    const bEdit = INITIAL.replace('Para B baseline.', 'Para B edited by B.');
    await createProposalBranch('refs/proposals/A', baseOid, aEdit);
    await createProposalBranch('refs/proposals/B', baseOid, bEdit);
    const r1 = await attemptMerge('case4-accept-A', 'refs/proposals/A');
    expect(r1.outcome).toBe('ff');
    const r2 = await attemptMerge('case4-merge-B-conflict', 'refs/proposals/B');
    // We expect *something* other than a clean ff/merged here.
    expect(r2.outcome === 'threw' || r2.outcome === 'unknown').toBe(true);
  });

  test('case 5: delete-vs-modify on the same paragraph', async () => {
    const baseOid = await git.resolveRef({ fs, dir, ref: 'main' });
    // A deletes Para B (and its surrounding blank line).
    const aEdit = INITIAL.replace('Para B baseline.\n\n', '');
    // B edits Para B in place.
    const bEdit = INITIAL.replace('Para B baseline.', 'Para B edited by B.');
    await createProposalBranch('refs/proposals/A', baseOid, aEdit);
    await createProposalBranch('refs/proposals/B', baseOid, bEdit);
    const r1 = await attemptMerge('case5-accept-delete-A', 'refs/proposals/A');
    expect(r1.outcome).toBe('ff');
    // Now main has Para B removed. Try to merge B's edit of that
    // (now-vanished) paragraph. We want to know whether iso-git surfaces
    // this as a normal MergeConflictError, a separate code, or auto-
    // resolves it (which would be wrong for our UX).
    await attemptMerge('case5-merge-edit-B', 'refs/proposals/B');
  });

  test('summary', () => {
    console.log('\n[spike] === summary ===');
    for (const r of results) {
      console.log(
        `  ${r.name.padEnd(28)} → ${r.outcome}${r.error ? ` (${r.error})` : ''}`,
      );
    }
    const merged = results.filter((r) => r.outcome === 'merged').length;
    const threw = results.filter((r) => r.outcome === 'threw').length;
    console.log(`[spike] 3-way auto-resolves: ${merged}, threw: ${threw}`);
    console.log(
      '[spike] If case2-merge-C did NOT reach outcome=merged, drop to FF-or-rebase semantics.',
    );
  });
});
