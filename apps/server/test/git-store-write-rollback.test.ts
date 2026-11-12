import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs, { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { type DocLocator, GitStore } from '../src/git-store.js';
import { crissCrossProposal } from './criss-cross.js';

/**
 * A save that fails to commit must leave the working file as it was:
 * `read()` serves that file, so anything else shows readers text git never
 * recorded, and refuses the next `writeIfCurrent` as a concurrent change.
 * Failure is injected through file permissions, which root ignores, hence
 * the skip.
 */
describe.skipIf(process.getuid?.() === 0)('GitStore write rollback', () => {
  let dir: string;
  let store: GitStore;
  const doc: DocLocator = { uid: 'doc-1', format: 'markdown' };
  const author = { displayName: 'Alice', clientId: 'alice' };
  const INITIAL = '# Title\n\nCommitted text.\n';

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-rollback-'));
    store = new GitStore(dir);
    await store.init();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Fails the commit at its last step, moving `main`, after the file is
   * written and staged. A read-only object store would not: the objects an
   * accept writes can already exist, and then nothing new is written.
   */
  async function withReadOnlyMain(run: () => Promise<unknown>): Promise<void> {
    const ref = join(store.repoDir(doc.uid), '.git', 'refs', 'heads', 'main');
    chmodSync(ref, 0o400);
    try {
      await run();
    } finally {
      chmodSync(ref, 0o600);
    }
  }

  async function workingTreeClean(): Promise<boolean> {
    const matrix = await git.statusMatrix({ fs, dir: store.repoDir(doc.uid) });
    return matrix.every(([, head, workdir, stage]) => head === workdir && workdir === stage);
  }

  test('a failed save leaves the source, the index and the next save as they were', async () => {
    await store.write(doc, INITIAL, author, 'upload');
    await withReadOnlyMain(async () => {
      await expect(store.write(doc, '# Title\n\nLost.\n', author, 'update')).rejects.toThrow();
    });
    expect(store.read(doc)).toBe(INITIAL);
    expect(await workingTreeClean()).toBe(true);

    const retried = await store.writeIfCurrent(
      doc,
      INITIAL,
      '# Title\n\nSaved.\n',
      author,
      'update',
    );
    expect(retried).not.toBeNull();
    expect(store.read(doc)).toBe('# Title\n\nSaved.\n');
  });

  test('a failed first save leaves no file behind', async () => {
    // A new document's repo exists, with only its init commit, before the
    // first save commits anything.
    await (store as unknown as { ensureDocRepo(uid: string): Promise<void> }).ensureDocRepo(
      doc.uid,
    );
    await withReadOnlyMain(async () => {
      await expect(store.write(doc, INITIAL, author, 'upload')).rejects.toThrow();
    });
    expect(existsSync(join(store.repoDir(doc.uid), 'document.md'))).toBe(false);
    await store.write(doc, INITIAL, author, 'upload');
    expect(store.read(doc)).toBe(INITIAL);
  });

  test('a failed accept through the native merge leaves the source as it was', async () => {
    const paras = [1, 2, 3, 4, 5, 6].map((n) => `Para ${n} baseline.`);
    const base = `# Title\n\n${paras.join('\n\n')}\n`;
    await store.write(doc, base, author, 'upload');
    const baseOid = await git.resolveRef({ fs, dir: store.repoDir(doc.uid), ref: 'main' });
    for (const n of [1, 2]) {
      const edited = base.replace(`Para ${n} baseline.`, `Para ${n} edited.`);
      await store.createProposalBranch(doc, baseOid, `p${n}`, edited, author);
    }
    expect((await store.mergeProposalBranch(doc, 'p1', author)).ok).toBe(true);
    expect((await store.mergeProposalBranch(doc, 'p2', author)).ok).toBe(true);
    const before = store.read(doc);
    const mainBefore = await git.resolveRef({ fs, dir: store.repoDir(doc.uid), ref: 'main' });
    await store.createProposalBranch(
      doc,
      mainBefore,
      'x',
      before.replace('Para 6 baseline.', 'Para 6 from x.'),
      author,
    );
    // Only a criss-cross reaches the native fallback that writes the file.
    await crissCrossProposal(store, doc, 'x', author);

    await withReadOnlyMain(async () => {
      await expect(store.mergeProposalBranch(doc, 'x', author)).rejects.toThrow();
    });
    expect(store.read(doc)).toBe(before);
    expect(await workingTreeClean()).toBe(true);

    expect((await store.mergeProposalBranch(doc, 'x', author)).ok).toBe(true);
    expect(store.read(doc)).toContain('Para 6 from x.');
  });
});
