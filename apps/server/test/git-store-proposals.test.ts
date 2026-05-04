import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { GitStore, type DocLocator } from '../src/git-store.js';

/**
 * Tests for the proposal-branch primitives on GitStore. The lifecycle:
 *
 *   write() seeds main → createProposalBranch → mergeProposalBranch
 *
 * Branch refs live at `refs/proposals/<pid>`. Merging writes straight to
 * main (FF or 3-way) or returns structured conflict info on overlap.
 */
describe('GitStore proposal branches', () => {
  let dir: string;
  let store: GitStore;
  const doc: DocLocator = { uid: 'doc-1', format: 'markdown' };
  const author = { displayName: 'Alice', clientId: 'alice' };

  const INITIAL = `# Title

Para A baseline.

Para B baseline.

Para C baseline.
`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-proposals-'));
    store = new GitStore(dir);
    await store.init();
    await store.write(doc, INITIAL, author, 'upload');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function mainOid(): Promise<string> {
    return git.resolveRef({ fs, dir: store.repoDir(doc.uid), ref: 'main' });
  }

  test('createProposalBranch points refs/proposals/<pid> at a one-commit branch with the new content', async () => {
    const baseOid = await mainOid();
    const proposed = INITIAL.replace('Para B baseline.', 'Para B from p1.');
    const { commitOid, refName } = await store.createProposalBranch(
      doc,
      baseOid,
      'p1',
      proposed,
      author,
    );

    expect(refName).toBe('refs/proposals/p1');
    const refOid = await git.resolveRef({
      fs,
      dir: store.repoDir(doc.uid),
      ref: refName,
    });
    expect(refOid).toBe(commitOid);

    const { commit } = await git.readCommit({
      fs,
      dir: store.repoDir(doc.uid),
      oid: commitOid,
    });
    expect(commit.parent).toEqual([baseOid]);
    expect(commit.message).toContain('accept-proposal: p1');
    expect(commit.message).toContain('X-Marginalia-Proposal-ID: p1');

    const tip = await store.readProposalTip(doc, 'p1');
    expect(tip).toBe(proposed);

    // Main is unchanged — creating a proposal must never touch main.
    expect(await mainOid()).toBe(baseOid);
    expect(store.read(doc)).toBe(INITIAL);
  });

  test('createProposalBranch embeds the rationale in the commit message body', async () => {
    const baseOid = await mainOid();
    const proposed = INITIAL.replace('Para B baseline.', 'Para B from p2.');
    const rationale = 'Para B was vague — clarify it to mention p2.';
    const { commitOid } = await store.createProposalBranch(
      doc,
      baseOid,
      'p2',
      proposed,
      author,
      rationale,
    );

    const { commit } = await git.readCommit({
      fs,
      dir: store.repoDir(doc.uid),
      oid: commitOid,
    });
    expect(commit.message).toContain('accept-proposal: p2');
    expect(commit.message).toContain(rationale);
    // Trailers must remain at the end so any tooling that reads them works.
    const trailerStart = commit.message.indexOf('X-Marginalia-Client-ID:');
    expect(trailerStart).toBeGreaterThan(commit.message.indexOf(rationale));
  });

  test('createProposalBranch omits an empty rationale (no blank paragraph)', async () => {
    const baseOid = await mainOid();
    const proposed = INITIAL.replace('Para B baseline.', 'Para B from p3.');
    const { commitOid } = await store.createProposalBranch(
      doc,
      baseOid,
      'p3',
      proposed,
      author,
      '   ',
    );

    const { commit } = await git.readCommit({
      fs,
      dir: store.repoDir(doc.uid),
      oid: commitOid,
    });
    expect(commit.message).toBe(
      `accept-proposal: p3\n\nX-Marginalia-Client-ID: ${author.clientId}\nX-Marginalia-Proposal-ID: p3\n`,
    );
  });

  test('mergeProposalBranch fast-forwards when main has not moved', async () => {
    const baseOid = await mainOid();
    const proposed = INITIAL.replace('Para B baseline.', 'Para B accepted.');
    await store.createProposalBranch(doc, baseOid, 'p1', proposed, author);

    const result = await store.mergeProposalBranch(doc, 'p1', author);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(store.read(doc)).toBe(proposed);
    const tipOid = await mainOid();
    expect(tipOid).toBe(result.oid);
    // FF: main now equals the proposal commit, no extra merge commit.
    const branchOid = await git.resolveRef({
      fs,
      dir: store.repoDir(doc.uid),
      ref: 'refs/proposals/p1',
    });
    expect(tipOid).toBe(branchOid);
  });

  test('mergeProposalBranch 3-way merges two non-overlapping proposals', async () => {
    const baseOid = await mainOid();
    const aProposed = INITIAL.replace('Para A baseline.', 'Para A from p1.');
    const cProposed = INITIAL.replace('Para C baseline.', 'Para C from p2.');
    await store.createProposalBranch(doc, baseOid, 'p1', aProposed, author);
    await store.createProposalBranch(doc, baseOid, 'p2', cProposed, author);

    const r1 = await store.mergeProposalBranch(doc, 'p1', author);
    expect(r1.ok).toBe(true);

    // p2's branch is now non-FF: its parent is the original baseOid, but
    // main has advanced. iso-git should 3-way merge.
    const r2 = await store.mergeProposalBranch(doc, 'p2', author);
    expect(r2.ok).toBe(true);
    const after = store.read(doc);
    expect(after).toContain('Para A from p1.');
    expect(after).toContain('Para C from p2.');
    expect(after).toContain('Para B baseline.');
  });

  test('mergeProposalBranch returns structured conflict info on overlapping edits', async () => {
    const baseOid = await mainOid();
    const aProposed = INITIAL.replace('Para B baseline.', 'Para B from p1.');
    const bProposed = INITIAL.replace('Para B baseline.', 'Para B from p2.');
    await store.createProposalBranch(doc, baseOid, 'p1', aProposed, author);
    await store.createProposalBranch(doc, baseOid, 'p2', bProposed, author);

    const r1 = await store.mergeProposalBranch(doc, 'p1', author);
    expect(r1.ok).toBe(true);

    const r2 = await store.mergeProposalBranch(doc, 'p2', author);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.reason).toBe('conflict');
    if (r2.reason !== 'conflict') return;
    expect(r2.conflict.bothModified).toContain('document.md');
    // Main must NOT have moved on a conflicted merge attempt.
    expect(store.read(doc)).toBe(aProposed);
  });

  test('mergeProposalBranch reports `absent` when the ref is gone', async () => {
    // Concurrent reject deletes the branch; a late accept should land on
    // a structured `{ ok: false, reason: 'absent' }` instead of throwing
    // out to the HTTP layer as a 500.
    const result = await store.mergeProposalBranch(doc, 'never-existed', author);
    expect(result).toEqual({ ok: false, reason: 'absent' });
  });

  test('deleteProposalBranch removes the ref; idempotent on a missing ref', async () => {
    const baseOid = await mainOid();
    await store.createProposalBranch(
      doc,
      baseOid,
      'p1',
      INITIAL.replace('Para B baseline.', 'edited'),
      author,
    );
    expect(await store.readProposalTip(doc, 'p1')).not.toBeNull();

    await store.deleteProposalBranch(doc, 'p1');
    expect(await store.readProposalTip(doc, 'p1')).toBeNull();

    // Idempotent: calling again on an absent ref is fine.
    await store.deleteProposalBranch(doc, 'p1');
    await store.deleteProposalBranch(doc, 'never-existed');
  });

  test('proposalMergeStatus reports clean/conflict/merged/absent', async () => {
    const baseOid = await mainOid();
    const cleanProposed = INITIAL.replace('Para A baseline.', 'Para A from p1.');
    const conflictA = INITIAL.replace('Para B baseline.', 'Para B from p2.');
    const conflictB = INITIAL.replace('Para B baseline.', 'Para B from p3.');

    await store.createProposalBranch(doc, baseOid, 'p1', cleanProposed, author);
    await store.createProposalBranch(doc, baseOid, 'p2', conflictA, author);
    await store.createProposalBranch(doc, baseOid, 'p3', conflictB, author);

    expect(await store.proposalMergeStatus(doc, 'p1')).toBe('clean');
    expect(await store.proposalMergeStatus(doc, 'absent-pid')).toBe('absent');

    // Accept p2 — that advances main and turns p3 into a conflict.
    const accepted = await store.mergeProposalBranch(doc, 'p2', author);
    expect(accepted.ok).toBe(true);

    // p2's branch tip is now identical to main's tip (FF).
    expect(await store.proposalMergeStatus(doc, 'p2')).toBe('merged');
    expect(await store.proposalMergeStatus(doc, 'p3')).toBe('conflict');
  });

  test('readProposalTip returns null when the ref is gone', async () => {
    expect(await store.readProposalTip(doc, 'never')).toBeNull();
  });

  test('mergeProposalBranch updates the working tree on a non-FF merge', async () => {
    // Regression: iso-git's `merge` advances the ref but leaves the
    // working tree pointing at the old tree. We force a checkout after
    // a 3-way merge so subsequent `read()` calls see the merged file.
    const baseOid = await mainOid();
    await store.createProposalBranch(
      doc,
      baseOid,
      'p1',
      INITIAL.replace('Para A baseline.', 'A!'),
      author,
    );
    await store.createProposalBranch(
      doc,
      baseOid,
      'p2',
      INITIAL.replace('Para C baseline.', 'C!'),
      author,
    );
    await store.mergeProposalBranch(doc, 'p1', author);
    await store.mergeProposalBranch(doc, 'p2', author);

    // read() reads the working tree directly — must reflect both edits.
    const after = store.read(doc);
    expect(after).toContain('A!');
    expect(after).toContain('C!');
  });
});
