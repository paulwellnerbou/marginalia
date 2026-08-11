import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
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
    expect(imported).toEqual({ ok: true, oid: thirdOid });

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
    const declined = await store.importHistoryPack(target, corrupt, exported!.headOid);
    expect(declined.ok).toBe(false);
    // The decline has to say what was wrong with the pack: a truncated
    // one and a head-less one both land here, and an operator reading
    // the import log can only tell them apart by this.
    expect(declined.ok === false && declined.reason).toBeTruthy();
    expect(await store.exportHistoryPack(target)).toBeNull();
  });

  test('importHistoryPack rejects a pack that lacks the claimed head', async () => {
    await store.write(source, '# One\n', alice, 'upload');
    const exported = await store.exportHistoryPack(source);
    const absentOid = '0'.repeat(40);
    const declined = await store.importHistoryPack(target, exported!.pack, absentOid);
    expect(declined.ok).toBe(false);
    // Names the oid it went looking for, which is the whole diagnosis.
    expect(declined.ok === false && declined.reason).toContain(absentOid);
  });

  /**
   * The streamed pack comes from native `git pack-objects`, which
   * deltifies; the buffered one comes from isomorphic-git, which writes
   * every object out whole. Both have to land in an importable repo, and
   * this is the only place that difference is exercised — a silent
   * fallback to the buffered path would leave the streaming code
   * untested while every bundle test stayed green.
   */
  test('streams a native-git pack that imports to the same history', async () => {
    await store.write(source, '# One\n', alice, 'upload');
    await store.write(source, '# One\n\nTwo.\n', bob, 'update');
    const { oid: thirdOid } = await store.write(
      source,
      '# One\n\nTwo.\n\nThree.\n',
      alice,
      'update',
    );

    const streamed = await store.openHistoryPackStream(source);
    expect(streamed).not.toBeNull();
    expect(streamed!.headOid).toBe(thirdOid);
    expect(streamed!.commits).toBe(4);

    const chunks: Uint8Array[] = [];
    for await (const chunk of streamed!.chunks) chunks.push(chunk);
    expect(chunks.length).toBeGreaterThan(0);
    const pack = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const chunk of chunks) {
      pack.set(chunk, at);
      at += chunk.length;
    }
    expect(new TextDecoder().decode(pack.subarray(0, 4))).toBe('PACK');

    expect(await store.importHistoryPack(target, pack, streamed!.headOid)).toEqual({
      ok: true,
      oid: thirdOid,
    });
    expect(store.read(target)).toBe('# One\n\nTwo.\n\nThree.\n');
    const before = await store.history(source);
    const after = await store.history(target);
    expect(after.map((e) => e.oid)).toEqual(before.map((e) => e.oid));
    expect(after.map((e) => e.timestamp)).toEqual(before.map((e) => e.timestamp));
    expect(await store.readAt(target, before[1]!.oid)).toBe('# One\n\nTwo.\n');
  });

  /**
   * The export's consumer is a client reading over a network, so git
   * keeps writing while nothing is pulling from the stream. Everything
   * it writes in that window has to survive: a pack that loses its tail
   * still looks like a pack — right magic, right object count — and the
   * loss only surfaces at import, as a bundle that restores without its
   * history.
   *
   * Needs a pack bigger than one pipe read to be worth anything; the
   * size assertion below pins that premise, since a small pack arrives
   * whole in the first chunk and would pass either way.
   *
   * The pause is deliberately far longer than it needs to be on any one
   * platform: how long stdout can sit unattended before its buffer is
   * lost varies by an order of magnitude between macOS and Linux, and a
   * pause tuned to a dev laptop would let this regress on CI.
   */
  test('streams a whole pack when the consumer drains late', async () => {
    await store.write(source, '# One\n', alice, 'upload');
    // Deltas of near-random text stay large, so the pack clears one
    // pipe read on a handful of revisions rather than compressing back
    // under it.
    for (let i = 0; i < 40; i++) {
      const body = Array.from({ length: 1200 }, (_, j) =>
        String.fromCharCode(33 + ((i * 7919 + j * 104729) % 94)),
      ).join('');
      await store.write(source, `# One\n\n${body}\n`, alice, 'update');
    }

    const streamed = await store.openHistoryPackStream(source);
    expect(streamed).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 400));

    const parts: Uint8Array[] = [];
    for await (const chunk of streamed!.chunks) parts.push(chunk);
    const pack = Buffer.concat(parts);

    expect(pack.length).toBeGreaterThan(8192);
    // A pack closes with the SHA-1 of everything ahead of it, so this
    // fails on a pack missing any bytes at all.
    expect(pack.subarray(-20)).toEqual(createHash('sha1').update(pack.subarray(0, -20)).digest());

    const restored = await store.importHistoryPack(target, pack, streamed!.headOid);
    expect(restored.ok).toBe(true);
    expect((await store.history(target)).map((e) => e.oid)).toEqual(
      (await store.history(source)).map((e) => e.oid),
    );
  });

  test('openHistoryPackStream returns null for a doc with no repo', async () => {
    expect(
      await store.openHistoryPackStream({ uid: 'never-written', format: 'markdown' }),
    ).toBeNull();
  });

  // The buffered path has to stay reachable: it is what a runtime with
  // no git in it falls back to, and the export must not simply lose its
  // history there.
  test('openHistoryPackStream declines when native git is unavailable', async () => {
    await store.write(source, '# One\n', alice, 'upload');
    const realPath = process.env.PATH;
    process.env.PATH = join(dir, 'no-binaries-here');
    try {
      expect(await store.openHistoryPackStream(source)).toBeNull();
      expect(await store.exportHistoryPack(source)).not.toBeNull();
    } finally {
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
    }
  });
});
