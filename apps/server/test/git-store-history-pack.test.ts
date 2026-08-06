import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DocLocator, GitStore } from '../src/git-store.js';

/**
 * Packfile round-trip primitives behind history-preserving bundles.
 * The contract that matters: object ids survive the transplant, so oids
 * recorded elsewhere (accepted_oid, restored-from trailers) stay valid.
 */
describe('GitStore history packs', () => {
  let dir: string;
  let store: GitStore;
  const source: DocLocator = { uid: 'src-doc', format: 'markdown' };
  const target: DocLocator = { uid: 'dst-doc', format: 'markdown' };
  const alice = { displayName: 'Alice', clientId: 'alice' };
  const bob = { displayName: 'Bob', clientId: 'bob' };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-histpack-'));
    store = new GitStore(dir);
    await store.init();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('round-trips a multi-commit history with identical oids', async () => {
    await store.write(source, '# One\n', alice, 'upload');
    await store.write(source, '# One\n\nTwo.\n', bob, 'update');
    const { oid: thirdOid } = await store.write(
      source,
      '# One\n\nTwo.\n\nThree.\n',
      alice,
      'update',
    );

    const exported = await store.exportHistoryPack(source);
    expect(exported).not.toBeNull();
    expect(exported!.headOid).toBe(thirdOid);
    // Three writes plus the repo's seed commit, which carries no doc file
    // and so never shows up in `history()`.
    expect(exported!.commits).toBe(4);

    const imported = await store.importHistoryPack(target, exported!.pack, exported!.headOid);
    expect(imported).toEqual({ oid: thirdOid });

    // Working tree restored, and every commit kept its identity.
    expect(store.read(target)).toBe('# One\n\nTwo.\n\nThree.\n');
    const before = await store.history(source);
    const after = await store.history(target);
    expect(after.map((e) => e.oid)).toEqual(before.map((e) => e.oid));
    expect(after.map((e) => e.author.name)).toEqual(['alice', 'bob', 'alice']);
    expect(after.map((e) => e.timestamp)).toEqual(before.map((e) => e.timestamp));

    // Content at an intermediate oid is readable in the new repo.
    expect(await store.readAt(target, before[1]!.oid)).toBe('# One\n\nTwo.\n');
  });

  test('exportHistoryPack returns null for a doc with no repo', async () => {
    expect(await store.exportHistoryPack({ uid: 'never-written', format: 'markdown' })).toBeNull();
  });

  test('importHistoryPack leaves no repo behind when the pack is corrupt', async () => {
    await store.write(source, '# One\n', alice, 'upload');
    const exported = await store.exportHistoryPack(source);
    expect(exported).not.toBeNull();

    const corrupt = exported!.pack.slice(0, Math.floor(exported!.pack.length / 2));
    expect(await store.importHistoryPack(target, corrupt, exported!.headOid)).toBeNull();
    expect(await store.exportHistoryPack(target)).toBeNull();
  });

  test('importHistoryPack rejects a pack that lacks the claimed head', async () => {
    await store.write(source, '# One\n', alice, 'upload');
    const exported = await store.exportHistoryPack(source);
    const absentOid = '0'.repeat(40);
    expect(await store.importHistoryPack(target, exported!.pack, absentOid)).toBeNull();
  });
});
