import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs, { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { type DocLocator, GitStore } from '../src/git-store.js';

/**
 * Housekeeping on the per-doc repos.
 *
 * isomorphic-git writes only loose objects and loose refs, so without a
 * `gc` these repos grow without bound — one production repo held 158 MB
 * across 4768 loose objects for a document that packs to 3 MB.
 *
 * The risk packing has to clear is reachability: accepting a proposal
 * deliberately keeps its branch, because for a three-way accept that ref
 * is the only thing holding the authored tip. These tests pin that the
 * ref really does keep it alive, and that the app can read a packed repo
 * at all — it reads through isomorphic-git, which has to cope with
 * packfiles and `packed-refs` rather than the loose layout it writes.
 */
describe('GitStore repo maintenance', () => {
  let dir: string;
  let store: GitStore;
  const doc: DocLocator = { uid: 'doc-gc', format: 'markdown' };
  const author = { displayName: 'Alice', clientId: 'alice' };

  const INITIAL = `# Title

Para A baseline.

Para B baseline.

Para C baseline.
`;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-gc-'));
    store = new GitStore(dir);
    await store.init();
    await store.write(doc, INITIAL, author, 'upload');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function countObjects(): Record<string, string> {
    const out = execFileSync('git', ['count-objects', '-v'], {
      cwd: store.repoDir(doc.uid),
      encoding: 'utf8',
    });
    return Object.fromEntries(
      out
        .trim()
        .split('\n')
        .map((line) => line.split(': ').map((s) => s.trim()) as [string, string]),
    );
  }

  test('packNow packs loose objects away', async () => {
    for (let i = 0; i < 5; i++) {
      await store.write(doc, `${INITIAL}\nRevision ${i}.\n`, author, 'update');
    }
    expect(Number(countObjects().count)).toBeGreaterThan(0);

    await store.packNow(doc.uid);

    const after = countObjects();
    expect(Number(after.count)).toBe(0);
    expect(Number(after.packs)).toBeGreaterThan(0);
  });

  test('an accepted proposal is still readable through the store after packing', async () => {
    const baseOid = await store.mainOid(doc);
    const proposed = INITIAL.replace('Para B baseline.', 'Para B accepted.');
    await store.createProposalBranch(doc, baseOid, 'p-accepted', proposed, author);
    const merged = await store.mergeProposalBranch(doc, 'p-accepted', author);
    expect(merged.ok).toBe(true);

    await store.packNow(doc.uid);

    // The document itself, and the proposal's own tip — accept keeps the
    // branch, and the diff endpoint still reads it afterwards.
    expect(store.read(doc)).toContain('Para B accepted.');
    expect(await store.readProposalTip(doc, 'p-accepted')).toContain('Para B accepted.');
  });

  test("the accepted proposal's tip survives even a pruning gc, because its ref holds it", async () => {
    const baseOid = await store.mainOid(doc);
    const proposed = INITIAL.replace('Para C baseline.', 'Para C accepted.');
    await store.createProposalBranch(doc, baseOid, 'p-pruned', proposed, author);
    await store.mergeProposalBranch(doc, 'p-pruned', author);
    const tipOid = await git.resolveRef({
      fs,
      dir: store.repoDir(doc.uid),
      ref: 'refs/proposals/p-pruned',
    });

    // The harshest case, which the shipped path deliberately does NOT
    // run: with no prune grace, only reachability saves an object. If
    // accept ever stopped keeping the branch, this is what would notice.
    execFileSync('git', ['gc', '--prune=now', '--quiet'], { cwd: store.repoDir(doc.uid) });

    expect(
      await git.resolveRef({ fs, dir: store.repoDir(doc.uid), ref: 'refs/proposals/p-pruned' }),
    ).toBe(tipOid);
    expect(await store.readProposalTip(doc, 'p-pruned')).toContain('Para C accepted.');
  });

  test('history and content still read after refs are packed into packed-refs', async () => {
    const baseOid = await store.mainOid(doc);
    for (let i = 0; i < 4; i++) {
      await store.createProposalBranch(
        doc,
        baseOid,
        `p-${i}`,
        `${INITIAL}\nVariant ${i}.\n`,
        author,
      );
    }
    await store.write(doc, `${INITIAL}\nA later edit.\n`, author, 'update');

    await store.packNow(doc.uid);
    expect(fs.existsSync(join(store.repoDir(doc.uid), '.git', 'packed-refs'))).toBe(true);

    // isomorphic-git resolving refs that now live only in packed-refs.
    for (let i = 0; i < 4; i++) {
      expect(await store.readProposalTip(doc, `p-${i}`)).toContain(`Variant ${i}.`);
    }
    const history = await store.history(doc);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(await store.readAt(doc, history[0]!.oid)).toContain('A later edit.');
  });

  test('writes eventually pack the repo without anyone asking', async () => {
    // The whole feature is this wiring: a busy document should end up
    // packed on its own. A threshold that never fires would leave it
    // loose forever and nothing else in the suite would notice. The
    // limits are tuned down so this costs a dozen writes, not hundreds.
    const tuned = new GitStore(dir, { everyWrites: 5, looseObjectLimit: 12 });
    await tuned.init();
    const busy: DocLocator = { uid: 'doc-busy', format: 'markdown' };
    await tuned.write(busy, INITIAL, author, 'upload');
    for (let i = 0; i < 12; i++) {
      await tuned.write(busy, `${INITIAL}\nAuto edit ${i}.\n`, author, 'update');
    }
    await tuned.whenMaintenanceSettled();

    const after = execFileSync('git', ['count-objects', '-v'], {
      cwd: tuned.repoDir(busy.uid),
      encoding: 'utf8',
    });
    expect(after).toMatch(/^packs: [1-9]/m);
    // Still readable, which is the only thing the app actually needs.
    expect(tuned.read(busy)).toContain('Auto edit 11.');
    expect((await tuned.history(busy)).length).toBeGreaterThan(1);
  });

  /**
   * Stand in for `gc` reaping a fanout directory out from under a write.
   *
   * `git gc` packs the loose objects away and then rmdir's every
   * `objects/XX/` it emptied, while isomorphic-git writes an object by
   * writing `objects/XX/<rest>`, creating `objects/XX/` if that fails,
   * and writing again. Reap on the mkdir itself and that interleaving
   * happens every time instead of in the microseconds-wide window a
   * loaded CI runner occasionally finds — which is how this arrived, as
   * an occasional red build rather than a test.
   *
   * Counted per directory, so `times` is what a single object's write
   * has to survive rather than a budget shared across the objects a
   * commit writes.
   */
  function reapFanoutDirs(times: number): () => void {
    const realMkdir = fs.promises.mkdir;
    const remaining = new Map<string, number>();
    fs.promises.mkdir = (async (path: fs.PathLike, options: unknown) => {
      const result = await realMkdir(path, options as Parameters<typeof realMkdir>[1]);
      const created = String(path);
      const left = remaining.get(created) ?? times;
      if (left > 0 && /[/\\]objects[/\\][0-9a-f]{2}$/.test(created)) {
        remaining.set(created, left - 1);
        rmSync(created, { recursive: true, force: true });
      }
      return result;
    }) as typeof fs.promises.mkdir;
    return () => {
      fs.promises.mkdir = realMkdir;
    };
  }

  test('a write finishes even though packing reaped the directory under it', async () => {
    // The CI flake: `autoGc` is fire-and-forget on purpose, so `gc` runs
    // while isomorphic-git is still writing, and the object write failed
    // with ENOENT under `.git/objects/` — a save lost to housekeeping.
    const restore = reapFanoutDirs(1);
    try {
      await store.write(doc, `${INITIAL}\nWritten while packing.\n`, author, 'update');
    } finally {
      restore();
    }

    expect(store.read(doc)).toContain('Written while packing.');
    expect((await store.history(doc))[0]?.oid).toBeTruthy();
  });

  test("and finishes when both of a gc run's sweeps reap the same directory", async () => {
    // One retry would not be enough: a `gc` run walks the fanout
    // directories more than once — `repack -d` prunes the objects it
    // packed, then `prune` goes over them again — so the same directory
    // can be taken twice while one object is trying to land.
    const restore = reapFanoutDirs(2);
    try {
      await store.write(doc, `${INITIAL}\nWritten across both sweeps.\n`, author, 'update');
    } finally {
      restore();
    }

    expect(store.read(doc)).toContain('Written across both sweeps.');
  });

  test('a directory that never stays put fails the write instead of retrying forever', async () => {
    // Retrying is only right because the directory does come back. If it
    // never does, that is a broken repo and not a race, and the write has
    // to say so rather than hang the request that is waiting on it.
    const restore = reapFanoutDirs(Number.POSITIVE_INFINITY);
    try {
      await expect(
        store.write(doc, `${INITIAL}\nNever lands.\n`, author, 'update'),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      restore();
    }
  }, 10_000);

  test('a repo below the loose-object limit is left alone', async () => {
    // Packing on every check would repack an already-tidy repo for
    // nothing. Well under the default limit, so no pack should appear.
    for (let i = 0; i < 55; i++) {
      await store.write(doc, `${INITIAL}\nSmall edit ${i}.\n`, author, 'update');
    }
    await store.whenMaintenanceSettled();

    expect(Number(countObjects().packs)).toBe(0);
    expect(Number(countObjects().count)).toBeGreaterThan(0);
  });

  test('a repo deleted while packing was queued is not mistaken for a broken git', async () => {
    // `destroyDocRepo` can remove the repo between a write and the
    // packing it scheduled. git then fails with "unable to read current
    // working directory", which reads exactly like a missing binary and
    // would tell an operator to go and install one.
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void errors.push(args);
    try {
      const tuned = new GitStore(dir, { everyWrites: 1, looseObjectLimit: 1 });
      await tuned.init();
      const doomed: DocLocator = { uid: 'doc-doomed', format: 'markdown' };
      await tuned.write(doomed, INITIAL, author, 'upload');
      await tuned.destroyDocRepo(doomed.uid);
      await tuned.whenMaintenanceSettled();
    } finally {
      console.error = realError;
    }

    expect(errors).toEqual([]);
  });

  test('destroying a repo forgets its packing counter', async () => {
    // Nothing else prunes the per-uid counter, so a server that churns
    // through documents would hold one entry per uid it ever wrote to.
    const tuned = new GitStore(dir, { everyWrites: 5, looseObjectLimit: 1_000_000 });
    await tuned.init();
    const temp: DocLocator = { uid: 'doc-temp', format: 'markdown' };
    await tuned.write(temp, INITIAL, author, 'upload');
    await tuned.destroyDocRepo(temp.uid);

    const counters = (tuned as unknown as { writesSinceMaintenance: Map<string, number> })
      .writesSinceMaintenance;
    expect(counters.has(temp.uid)).toBe(false);
  });

  test('a missing git binary leaves writes working', async () => {
    const realPath = process.env.PATH;
    process.env.PATH = join(dir, 'no-binaries-here');
    mkdirSync(join(dir, 'no-binaries-here'), { recursive: true });
    try {
      // Enough writes to cross the maintenance check, so the spawn is
      // actually attempted and its failure has to stay swallowed.
      for (let i = 0; i < 55; i++) {
        await store.write(doc, `${INITIAL}\nNo-git edit ${i}.\n`, author, 'update');
      }
      // Settle before restoring PATH, or the packing attempt races the
      // restore and may find a working git after all.
      await store.whenMaintenanceSettled();
      expect(store.read(doc)).toContain('No-git edit 54.');
    } finally {
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
    }
  });
});
