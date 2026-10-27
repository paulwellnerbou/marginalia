import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DocLocator, GitStore } from '../src/git-store.js';

/**
 * `openFileVersionReader` answers the same reads as the store itself,
 * through one `git cat-file --batch`. Its fallback answers them too, so
 * a test that only compares results can't tell which path ran: the
 * native one is pinned by making the store's own reads fail.
 */
describe('GitStore file version reader', () => {
  let dir: string;
  let store: GitStore;
  const doc: DocLocator = { uid: 'reader-doc', format: 'markdown' };
  const alice = { displayName: 'Alice', clientId: 'alice' };

  // Bigger than one pipe read, with multi-byte characters that a chunk
  // boundary can split.
  const long = `# Long\n\n${'Grüße aus Köln — 🌍 und weiter. '.repeat(12_000)}\n`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-versions-'));
    store = new GitStore(dir);
    await store.init();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seed() {
    const versions = ['# One\n', long, '# Three\n\nÄnderung.\n'];
    const oids: string[] = [];
    for (const text of versions) oids.push((await store.write(doc, text, alice, 'update')).oid);
    await store.createProposalBranch(doc, oids[1]!, 'p-long', `${long}Mehr.\n`, alice);
    await store.createProposalBranch(doc, oids[2]!, 'p-short', '# Three\n\nVorschlag.\n', alice);
    return { versions, oids };
  }

  test('reads revisions and proposal tips through native git', async () => {
    const { versions, oids } = await seed();
    const reader = store.openFileVersionReader(doc);
    const fail = () => Promise.reject(new Error('fell back to isomorphic-git'));
    store.readAt = fail;
    store.readProposalTip = fail;
    try {
      // Concurrent callers, answered in order by one subprocess.
      const read = await Promise.all([
        ...oids.map((oid) => reader.readAt(doc, oid)),
        reader.readProposalTip(doc, 'p-long'),
        reader.readProposalTip(doc, 'p-short'),
      ]);
      expect(read).toEqual([...versions, `${long}Mehr.\n`, '# Three\n\nVorschlag.\n']);
    } finally {
      reader.close();
    }
  });

  test('misses behave like the store: readAt rejects, a missing tip is null', async () => {
    const { oids } = await seed();
    const reader = store.openFileVersionReader(doc);
    try {
      await expect(reader.readAt(doc, '0'.repeat(40))).rejects.toThrow();
      expect(await reader.readProposalTip(doc, 'no-such-proposal')).toBeNull();
      // The subprocess is still in step after the misses.
      expect(await reader.readAt(doc, oids[0]!)).toBe('# One\n');
    } finally {
      reader.close();
    }
  });

  test('falls back to the store without native git', async () => {
    const { versions, oids } = await seed();
    const realPath = process.env.PATH;
    process.env.PATH = join(dir, 'no-binaries-here');
    const reader = store.openFileVersionReader(doc);
    try {
      expect(await reader.readAt(doc, oids[1]!)).toBe(versions[1]!);
      expect(await reader.readProposalTip(doc, 'p-short')).toBe('# Three\n\nVorschlag.\n');
    } finally {
      reader.close();
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
    }
  });
});
