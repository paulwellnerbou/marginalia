import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs, {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as git from 'isomorphic-git';
import { mergeThreeWay } from './conflict.js';
import type { DocumentFormat } from './db.js';

const execFileAsync = promisify(execFile);

/**
 * Per-document git storage. Each document lives in its own repo at
 * `<reposBaseDir>/<uid>/`, with the source pinned to a fixed in-repo
 * filename (`document.md` for markdown, `document.adoc` for asciidoc).
 *
 * Operations take a `DocLocator` ({ uid, format }) so callers can pass
 * a `DocumentRow` directly. All writes for a given uid serialize through
 * a per-doc async mutex. Reads stay outside the lock because writes are
 * atomic at the filesystem level: we stage to a sibling `.tmp` file and
 * `rename()` it over the target, so a concurrent reader sees either the
 * old inode or the fully-written new one — never a 0-byte or partially
 * filled file. Same precedent as `FsBlobStore.put()`.
 *
 * The class is a thin facade over isomorphic-git. New per-doc repos are
 * lazily initialized on first write; subsequent writes reuse the same
 * directory without re-initing.
 */
export class GitStore {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly initialized = new Set<string>();

  constructor(private readonly reposBaseDir: string) {}

  /**
   * Ensure the base directory exists. Per-doc repos are created lazily
   * on first write; nothing else happens here.
   */
  async init(): Promise<void> {
    mkdirSync(this.reposBaseDir, { recursive: true });
  }

  /** Absolute path of a doc's repo dir. Public for migration helpers. */
  repoDir(uid: string): string {
    return join(this.reposBaseDir, uid);
  }

  /** Fixed in-repo filename for the given format. */
  private filename(format: DocumentFormat): string {
    return format === 'asciidoc' ? 'document.adoc' : 'document.md';
  }

  private filepath(doc: DocLocator): string {
    return join(this.repoDir(doc.uid), this.filename(doc.format));
  }

  /**
   * Serialize work for a single doc. Concurrent writes / accepts on the
   * same uid wait their turn; different uids run in parallel.
   */
  private async withLock<T>(uid: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(uid) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Track a swallowed version so a thrown error doesn't poison
    // subsequent calls in the chain.
    const tracker = next.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(uid, tracker);
    try {
      return await next;
    } finally {
      if (this.chains.get(uid) === tracker) {
        this.chains.delete(uid);
      }
    }
  }

  private async ensureDocRepo(uid: string): Promise<void> {
    if (this.initialized.has(uid)) return;
    const dir = this.repoDir(uid);
    mkdirSync(dir, { recursive: true });
    const gitDir = join(dir, '.git');
    if (!existsSync(gitDir)) {
      await git.init({ fs, dir, defaultBranch: 'main' });
      // Seed with an empty marker commit so log() works before the
      // first real write.
      writeFileSync(join(dir, '.marginalia-root'), 'marginalia repo\n');
      await git.add({ fs, dir, filepath: '.marginalia-root' });
      await git.commit({
        fs,
        dir,
        message: 'init',
        author: { name: 'marginalia', email: 'system@marginalia.local' },
      });
    }
    this.initialized.add(uid);
  }

  private async restoreMainAfterFailedRevert(dir: string, originalError?: unknown): Promise<void> {
    try {
      await execFileAsync('git', ['reset', '--hard', 'main'], { cwd: dir });
    } catch (cleanupError) {
      const errors = originalError === undefined ? [cleanupError] : [originalError, cleanupError];
      throw new AggregateError(
        errors,
        'Git revert failed and the document repository could not be restored to main',
      );
    }
  }

  read(doc: DocLocator): string {
    return readFileSync(this.filepath(doc), 'utf8');
  }

  async write(
    doc: DocLocator,
    content: string,
    author: { displayName: string; clientId: string },
    action: 'upload' | 'update' | 'restore' | 'accept-proposal',
    meta: { proposalId?: string; restoredFromOid?: string; commitMessage?: string } = {},
  ): Promise<{ oid: string }> {
    return this.withLock(doc.uid, async () => {
      return this.writeUnlocked(doc, content, author, action, meta);
    });
  }

  /**
   * Write only when the document still has the source the caller read.
   * The compare and commit share the document mutex, closing the small
   * read-then-PUT race for scoped editors that merge their change into the
   * latest source before saving.
   */
  async writeIfCurrent(
    doc: DocLocator,
    expectedContent: string,
    content: string,
    author: { displayName: string; clientId: string },
    action: 'update' | 'restore',
    meta: { restoredFromOid?: string; commitMessage?: string } = {},
  ): Promise<{ oid: string } | null> {
    return this.withLock(doc.uid, async () => {
      let current = '';
      try {
        current = this.read(doc);
      } catch {
        return null;
      }
      if (current !== expectedContent) return null;
      return this.writeUnlocked(doc, content, author, action, meta);
    });
  }

  private async writeUnlocked(
    doc: DocLocator,
    content: string,
    author: { displayName: string; clientId: string },
    action: 'upload' | 'update' | 'restore' | 'accept-proposal',
    meta: { proposalId?: string; restoredFromOid?: string; commitMessage?: string },
  ): Promise<{ oid: string }> {
    await this.ensureDocRepo(doc.uid);
    const dir = this.repoDir(doc.uid);
    const filename = this.filename(doc.format);
    atomicWrite(join(dir, filename), content);
    await git.add({ fs, dir, filepath: filename });
    const subject =
      action === 'accept-proposal'
        ? `${action}: ${meta.proposalId ?? doc.uid}`
        : `${action}: ${doc.uid}`;
    const trailers = [
      `X-Marginalia-Client-ID: ${author.clientId}`,
      meta.proposalId ? `X-Marginalia-Proposal-ID: ${meta.proposalId}` : null,
      meta.restoredFromOid ? `X-Marginalia-Restored-From: ${meta.restoredFromOid}` : null,
    ].filter((line): line is string => Boolean(line));
    const sanitizedCommitMessage = meta.commitMessage
      ? meta.commitMessage
          .split('\n')
          .filter((line) => !line.trim().startsWith('X-Marginalia-'))
          .join('\n')
          .trim() || undefined
      : undefined;
    const bodyParts = sanitizedCommitMessage
      ? [sanitizedCommitMessage, trailers.join('\n')]
      : [trailers.join('\n')];
    const oid = await git.commit({
      fs,
      dir,
      message: `${subject}\n\n${bodyParts.join('\n\n')}\n`,
      author: {
        name: author.clientId,
        email: `${author.clientId}@marginalia.local`,
      },
    });
    return { oid };
  }

  /**
   * Delete a doc's repo entirely. Called when the document itself is
   * deleted — the repo *is* the document's history, so dropping the
   * directory drops the history with it. No commit is made; no readers
   * remain.
   */
  async destroyDocRepo(uid: string): Promise<void> {
    return this.withLock(uid, async () => {
      const dir = this.repoDir(uid);
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
      }
      this.initialized.delete(uid);
    });
  }

  /**
   * Copy a document's whole repository into another document's slot —
   * every commit, every branch, every proposal ref.
   *
   * Proposal refs are named after the comment that owns them, and a
   * copy re-mints comment ids (the column is a global primary key), so
   * each live one is rewritten to its new name. The
   * `refs/proposals-original/*` backups are deliberately left under
   * their old names: nothing ever reads them back, they exist only to
   * keep superseded commits from being collected, and that job does not
   * depend on what they are called.
   *
   * Runs under the source's lock so it cannot copy a half-written tree.
   * The destination needs no lock — its uid is not in the database yet,
   * so nothing else can reach it.
   */
  async forkDocRepo(
    srcUid: string,
    destUid: string,
    proposalIds: ReadonlyMap<string, string>,
  ): Promise<void> {
    return this.withLock(srcUid, async () => {
      const src = this.repoDir(srcUid);
      if (!existsSync(src)) throw new Error(`no repository for ${srcUid}`);
      const dir = this.repoDir(destUid);
      rmSync(dir, { recursive: true, force: true });
      cpSync(src, dir, { recursive: true });

      for (const [oldId, newId] of proposalIds) {
        let oid: string;
        try {
          oid = await git.resolveRef({ fs, dir, ref: proposalRef(oldId) });
        } catch {
          // Accepted and rejected proposals keep no branch. Their rows
          // still copy; there is just no ref to carry across.
          continue;
        }
        await git.writeRef({ fs, dir, ref: proposalRef(newId), value: oid, force: true });
        await git.deleteRef({ fs, dir, ref: proposalRef(oldId) });
      }
      this.initialized.add(destUid);
    });
  }

  /**
   * Commits that changed the doc file, newest first.
   *
   * `depth` bounds the walk for callers that only want the newest few
   * entries. It counts *emitted* entries, not commits visited, so a run
   * of commits that left the file untouched doesn't consume it — the
   * walk keeps going until `depth` file-changing commits are found, then
   * emits the boundary commit as one extra entry. That makes
   * `history(doc, { depth: n })[i]` identical to the unbounded
   * `history(doc)[i]` for every `i < n`, which is what the callers that
   * compare against the tip rely on.
   *
   * Worth bounding: unbounded, this inflates every commit and tree in
   * the repo, which on a doc with hundreds of revisions costs more than
   * the rest of the request put together.
   */
  async history(doc: DocLocator, opts?: { depth?: number }): Promise<HistoryEntry[]> {
    const dir = this.repoDir(doc.uid);
    if (!existsSync(join(dir, '.git'))) return [];
    const entries = await git.log({
      fs,
      dir,
      filepath: this.filename(doc.format),
      force: true, // include even if file was deleted in later commits
      depth: opts?.depth,
    });
    return entries.map((e) => ({
      oid: e.oid,
      message: e.commit.message,
      author: {
        name: e.commit.author.name,
        email: e.commit.author.email,
      },
      timestamp: e.commit.author.timestamp * 1000,
    }));
  }

  async diffAt(doc: DocLocator, oid: string): Promise<{ before: string; after: string } | null> {
    const after = await this.tryReadAt(doc, oid);
    if (after === null) return null;

    let parentOid: string | undefined;
    try {
      const { commit } = await git.readCommit({ fs, dir: this.repoDir(doc.uid), oid });
      parentOid = commit.parent[0];
    } catch {
      return null;
    }

    const before = parentOid ? ((await this.tryReadAt(doc, parentOid)) ?? '') : '';
    return { before, after };
  }

  /**
   * Revert one document commit on top of the current main branch.
   *
   * This deliberately delegates patch inversion to native Git instead of
   * replacing the document with the target commit's parent snapshot. That
   * means an older plain edit can be undone without discarding unrelated
   * changes committed after it. A conflicting inverse patch leaves main and
   * the working tree untouched.
   */
  async revertCommit(
    doc: DocLocator,
    targetOid: string,
    identity: { displayName: string; clientId: string },
  ): Promise<RevertCommitResult> {
    return this.withLock(doc.uid, async () => {
      await this.ensureDocRepo(doc.uid);
      const dir = this.repoDir(doc.uid);
      const mainOid = await git.resolveRef({ fs, dir, ref: 'main' });
      const isReachable =
        mainOid === targetOid ||
        (await git.isDescendent({ fs, dir, oid: mainOid, ancestor: targetOid }));
      if (!isReachable) return { ok: false, reason: 'absent' };

      const before = this.read(doc);
      try {
        await execFileAsync('git', ['revert', '--no-commit', targetOid], { cwd: dir });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ok: false, reason: 'unavailable' };
        }
        // A failed revert can leave conflict stages and a partly written
        // working tree. This repo contains only Marginalia-managed document
        // state, and the per-document lock prevents a concurrent save, so
        // restoring main here is both safe and necessary before returning.
        await this.restoreMainAfterFailedRevert(dir, err);
        return { ok: false, reason: 'conflict' };
      }

      const after = this.read(doc);
      if (after === before) {
        await this.restoreMainAfterFailedRevert(dir);
        return { ok: false, reason: 'empty' };
      }

      const message =
        `revert: ${targetOid}\n\n` +
        `X-Marginalia-Client-ID: ${identity.clientId}\n` +
        `X-Marginalia-Reverted-Oid: ${targetOid}\n`;
      const commitEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: identity.clientId,
        GIT_AUTHOR_EMAIL: `${identity.clientId}@marginalia.local`,
        GIT_COMMITTER_NAME: identity.clientId,
        GIT_COMMITTER_EMAIL: `${identity.clientId}@marginalia.local`,
      };
      try {
        await execFileAsync('git', ['commit', '-m', message], { cwd: dir, env: commitEnv });
      } catch (err) {
        await this.restoreMainAfterFailedRevert(dir, err);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ok: false, reason: 'unavailable' };
        }
        throw err;
      }

      const oid = await git.resolveRef({ fs, dir, ref: 'main' });
      return { ok: true, oid, before, after };
    });
  }

  /** Main's current tip oid for this doc. Throws if the repo isn't initialized. */
  async mainOid(doc: DocLocator): Promise<string> {
    return git.resolveRef({ fs, dir: this.repoDir(doc.uid), ref: 'main' });
  }

  /**
   * Serialize main's full commit history as a git packfile, for embedding
   * in an export bundle. Returns null when the doc has no repo yet.
   *
   * Only objects reachable from main are packed — proposal branches are
   * deliberately excluded, because `refs/proposals/<id>` is keyed by a
   * comment id that import regenerates, and open proposals are rebuilt
   * from their bundled `proposed_text` anyway.
   *
   * `packObjects` packs exactly the oids it is handed (no reachability
   * walk of its own), so the caller-side walk below has to enumerate
   * every commit, tree, and blob itself.
   *
   * `commits` counts everything on main, including the seed commit that
   * `history()` filters out — it describes the pack, not the timeline.
   */
  async exportHistoryPack(
    doc: DocLocator,
  ): Promise<{ pack: Uint8Array; headOid: string; commits: number } | null> {
    const dir = this.repoDir(doc.uid);
    if (!existsSync(join(dir, '.git'))) return null;
    let headOid: string;
    try {
      headOid = await git.resolveRef({ fs, dir, ref: 'main' });
    } catch {
      return null;
    }

    const commits = await git.log({ fs, dir, ref: 'main' });
    const oids = new Set<string>();
    for (const entry of commits) {
      oids.add(entry.oid);
      await this.collectTreeObjects(dir, entry.commit.tree, oids);
    }

    const { packfile } = await git.packObjects({ fs, dir, oids: [...oids], write: false });
    if (!packfile) return null;
    return { pack: packfile, headOid, commits: commits.length };
  }

  /**
   * Same pack as `exportHistoryPack`, delivered as a stream from native
   * `git pack-objects` instead of a buffer.
   *
   * Worth the second implementation because the buffered one is not
   * merely slower: `isomorphic-git` inflates every object, deflates it
   * again, and holds all of them plus the concatenated result in memory.
   * Measured on a 309-commit document that costs ~136 MB to produce a
   * 12.7 MB pack, which is most of the way to the deploy's 512 MB
   * container limit before the bundle around it is even serialized.
   * Native git streams the pack out as it builds it, and deltifies it,
   * so the export's memory stops scaling with document history.
   *
   * Returns null when there's no repo, no main ref, or no usable native
   * git — callers fall back to `exportHistoryPack`. Deliberately no
   * warning on that path: unlike a failed merge it costs the caller
   * nothing but memory, and `mergeThreeWay` in `conflict.js` already
   * says the one useful thing about a runtime with no git in it.
   */
  async openHistoryPackStream(doc: DocLocator): Promise<HistoryPackStream | null> {
    const dir = this.repoDir(doc.uid);
    if (!existsSync(join(dir, '.git'))) return null;
    let headOid: string;
    try {
      headOid = await git.resolveRef({ fs, dir, ref: 'main' });
    } catch {
      return null;
    }

    let commits: number;
    try {
      const { stdout } = await execFileAsync('git', ['rev-list', '--count', 'main'], { cwd: dir });
      commits = Number.parseInt(stdout.trim(), 10);
      if (!Number.isInteger(commits)) return null;
    } catch {
      return null;
    }

    // `--revs` takes the rev to pack from stdin; `--stdout` writes the
    // pack to ours. Reachability is git's own walk, which is what makes
    // this cheap — no oid enumeration on our side.
    const child = spawn('git', ['pack-objects', '--stdout', '--revs'], {
      cwd: dir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Committed to a streamed response from here on, so a failure that
    // surfaces later can only tear the stream down. Wait for the pack
    // header before returning: a missing binary or a rejected rev shows
    // up in that window, while the caller can still choose the buffered
    // path instead of emitting a truncated bundle.
    try {
      const chunks = await stdoutAfterFirstChunk(child, 'main\n');
      return { headOid, commits, chunks };
    } catch {
      child.kill();
      return null;
    }
  }

  /** Add a tree and everything under it to `oids`, skipping already-seen subtrees. */
  private async collectTreeObjects(dir: string, treeOid: string, oids: Set<string>): Promise<void> {
    if (oids.has(treeOid)) return;
    oids.add(treeOid);
    const { tree } = await git.readTree({ fs, dir, oid: treeOid });
    for (const entry of tree) {
      if (entry.type === 'tree') await this.collectTreeObjects(dir, entry.oid, oids);
      else oids.add(entry.oid);
    }
  }

  /**
   * Rebuild a doc repo from a packfile produced by `exportHistoryPack`,
   * with main pointed at `headOid`. Object ids are preserved exactly, so
   * oids recorded in SQLite (`accepted_oid`) and in commit trailers
   * (`X-Marginalia-Restored-From`) stay valid across the transplant.
   *
   * Declines — leaving no repo behind — if the pack is unusable, so the
   * caller can fall back to seeding a fresh single-commit repo. A
   * corrupt or truncated bundle must not cost the user the import.
   *
   * The decline carries the underlying error rather than collapsing to
   * a bare null: a pack truncated in transit, one whose bytes are
   * corrupt, and one simply missing the head commit all fail here, and
   * only that message tells an operator which of the three happened.
   */
  async importHistoryPack(
    doc: DocLocator,
    pack: Uint8Array,
    headOid: string,
  ): Promise<ImportHistoryPackResult> {
    return this.withLock(doc.uid, async () => {
      const dir = this.repoDir(doc.uid);
      try {
        mkdirSync(dir, { recursive: true });
        await git.init({ fs, dir, defaultBranch: 'main' });

        // indexPack reads the pack from inside the repo and writes the
        // sibling .idx that makes its objects readable.
        const packRelPath = join(
          '.git',
          'objects',
          'pack',
          `marginalia-import-${randomBytes(8).toString('hex')}.pack`,
        );
        mkdirSync(join(dir, '.git', 'objects', 'pack'), { recursive: true });
        writeFileSync(join(dir, packRelPath), pack);
        await git.indexPack({ fs, dir, filepath: packRelPath });

        // Prove the head is actually present before adopting it: a pack
        // that indexes cleanly can still be missing the commit we need.
        await git.readCommit({ fs, dir, oid: headOid });
        await git.writeRef({ fs, dir, ref: 'refs/heads/main', value: headOid, force: true });
        await git.checkout({ fs, dir, ref: 'main', force: true });
        this.initialized.add(doc.uid);
        return { ok: true, oid: headOid };
      } catch (err) {
        rmSync(dir, { recursive: true, force: true });
        this.initialized.delete(doc.uid);
        return { ok: false, reason: packFailureReason(err) };
      }
    });
  }

  async readAt(doc: DocLocator, oid: string): Promise<string> {
    const { blob } = await git.readBlob({
      fs,
      dir: this.repoDir(doc.uid),
      oid,
      filepath: this.filename(doc.format),
    });
    return new TextDecoder().decode(blob);
  }

  private async tryReadAt(doc: DocLocator, oid: string): Promise<string | null> {
    try {
      return await this.readAt(doc, oid);
    } catch {
      return null;
    }
  }

  /**
   * Build a one-commit branch on `refs/proposals/<proposalId>` parented at
   * `baseOid`, with the doc file replaced by `nextSource`. Uses plumbing
   * so main's working tree isn't touched.
   *
   * Re-pointing an existing ref (a proposal-content update) keeps the
   * previous tip under `refs/proposals-original/<id>/<old-tip>` — same
   * convention as repair's branch rewrite — so no authored version is
   * ever dropped.
   */
  async createProposalBranch(
    doc: DocLocator,
    baseOid: string,
    proposalId: string,
    nextSource: string,
    identity: { displayName: string; clientId: string },
    rationale?: string | null,
  ): Promise<{ commitOid: string; refName: string }> {
    return this.withLock(doc.uid, async () => {
      await this.ensureDocRepo(doc.uid);
      const dir = this.repoDir(doc.uid);
      const filename = this.filename(doc.format);

      const { commit: baseCommit } = await git.readCommit({ fs, dir, oid: baseOid });
      const { tree } = await git.readTree({ fs, dir, oid: baseCommit.tree });
      const blobOid = await git.writeBlob({
        fs,
        dir,
        blob: new TextEncoder().encode(nextSource),
      });
      // If the base tree doesn't carry the doc file yet (e.g. the only
      // commit so far is the seed `.marginalia-root`), insert a new
      // entry. `tree.map` on its own would silently keep the old tree.
      const hasEntry = tree.some((e) => e.path === filename);
      const newTree = hasEntry
        ? tree.map((e) => (e.path === filename ? { ...e, oid: blobOid } : e))
        : [...tree, { path: filename, mode: '100644', type: 'blob' as const, oid: blobOid }];
      const newTreeOid = await git.writeTree({ fs, dir, tree: newTree });

      const ts = Math.floor(Date.now() / 1000);
      const author = {
        name: identity.clientId,
        email: `${identity.clientId}@marginalia.local`,
        timestamp: ts,
        timezoneOffset: 0,
      };
      // Subject is pre-styled as `accept-proposal:` so a FF accept lands
      // a commit `parseHistoryAction` (routes/documents.ts) recognizes.
      // The rationale (proposal opener body) is embedded in the commit
      // body so accepted proposals leave a self-describing entry in the
      // git log — and so editing the rationale after accept/reject would
      // diverge from the historical record.
      const trimmedRationale = rationale?.trim() ?? '';
      const message =
        `accept-proposal: ${proposalId}\n\n` +
        (trimmedRationale.length > 0 ? `${trimmedRationale}\n\n` : '') +
        `X-Marginalia-Client-ID: ${identity.clientId}\n` +
        `X-Marginalia-Proposal-ID: ${proposalId}\n`;
      const commitOid = await git.writeCommit({
        fs,
        dir,
        commit: {
          tree: newTreeOid,
          parent: [baseOid],
          author,
          committer: author,
          message,
        },
      });

      const refName = proposalRef(proposalId);
      let previousTip: string | null = null;
      try {
        previousTip = await git.resolveRef({ fs, dir, ref: refName });
      } catch {
        // No existing ref — a plain create.
      }
      if (previousTip && previousTip !== commitOid) {
        await git.writeRef({
          fs,
          dir,
          ref: `refs/proposals-original/${proposalId}/${previousTip}`,
          value: previousTip,
          force: true,
        });
      }
      await git.writeRef({ fs, dir, ref: refName, value: commitOid, force: true });
      return { commitOid, refName };
    });
  }

  /** Merge the proposal branch into main. FF when possible, 3-way otherwise. */
  async mergeProposalBranch(
    doc: DocLocator,
    proposalId: string,
    identity: { displayName: string; clientId: string },
  ): Promise<MergeProposalResult> {
    return this.withLock(doc.uid, async () => {
      await this.ensureDocRepo(doc.uid);
      const dir = this.repoDir(doc.uid);
      const refName = proposalRef(proposalId);
      const ts = Math.floor(Date.now() / 1000);
      const author = {
        name: identity.clientId,
        email: `${identity.clientId}@marginalia.local`,
        timestamp: ts,
        timezoneOffset: 0,
      };
      const message =
        `accept-proposal: ${proposalId}\n\n` +
        `X-Marginalia-Client-ID: ${identity.clientId}\n` +
        `X-Marginalia-Proposal-ID: ${proposalId}\n`;
      try {
        // FF default. `fastForward: false` would let the merge commit
        // carry a fresh subject, but iso-git's recursive merge isn't
        // implemented — a forced merge commit creates the multi-base
        // history that breaks the next accept with MergeNotSupportedError.
        const result = (await git.merge({
          fs,
          dir,
          ours: 'main',
          theirs: refName,
          author,
          message,
        })) as { oid?: string; alreadyMerged?: boolean; fastForward?: boolean };
        const oid = result.oid ?? (await git.resolveRef({ fs, dir, ref: 'main' }));
        // iso-git's 3-way merge advances the ref without updating the
        // working tree; checkout so `read()` reflects the merged file.
        await git.checkout({ fs, dir, ref: 'main', force: true });
        return { ok: true, oid };
      } catch (err) {
        const e = err as Error & {
          code?: string;
          data?: {
            filepaths?: string[];
            bothModified?: string[];
            deleteByUs?: string[];
            deleteByTheirs?: string[];
          };
        };
        // MergeNotSupportedError: multiple merge bases (criss-cross accept
        // history) — iso-git can't 3-way merge these, native git can.
        if (e.code === 'MergeConflictError' || e.code === 'MergeNotSupportedError') {
          const nativeMerge = await this.previewProposalMergeWithGitUnlocked(doc, proposalId);
          if (nativeMerge.ok) {
            if (nativeMerge.after === nativeMerge.before) {
              const oid = await git.resolveRef({ fs, dir, ref: 'main' });
              return { ok: true, oid };
            }
            atomicWrite(join(dir, this.filename(doc.format)), nativeMerge.after);
            await git.add({ fs, dir, filepath: this.filename(doc.format) });
            const oid = await git.commit({ fs, dir, message, author });
            await git.checkout({ fs, dir, ref: 'main', force: true });
            return { ok: true, oid };
          }
          if (nativeMerge.reason === 'unavailable') return { ok: false, reason: 'unavailable' };
          return {
            ok: false,
            reason: 'conflict',
            conflict: {
              filepaths: e.data?.filepaths ?? [],
              bothModified: e.data?.bothModified ?? [],
              deleteByUs: e.data?.deleteByUs ?? [],
              deleteByTheirs: e.data?.deleteByTheirs ?? [],
            },
          };
        }
        if (e.code === 'NotFoundError') {
          return { ok: false, reason: 'absent' };
        }
        throw err;
      }
    });
  }

  /** Delete the proposal's ref. No-op if it's already gone. */
  async deleteProposalBranch(doc: DocLocator, proposalId: string): Promise<void> {
    return this.withLock(doc.uid, async () => {
      const dir = this.repoDir(doc.uid);
      if (!existsSync(join(dir, '.git'))) return;
      try {
        await git.deleteRef({ fs, dir, ref: proposalRef(proposalId) });
      } catch {
        // Ref absent or already deleted.
      }
    });
  }

  /** Read the file content at the proposal branch's tip. */
  async readProposalTip(doc: DocLocator, proposalId: string): Promise<string | null> {
    const dir = this.repoDir(doc.uid);
    if (!existsSync(join(dir, '.git'))) return null;
    try {
      const tipOid = await git.resolveRef({ fs, dir, ref: proposalRef(proposalId) });
      const { blob } = await git.readBlob({
        fs,
        dir,
        oid: tipOid,
        filepath: this.filename(doc.format),
      });
      return new TextDecoder().decode(blob);
    } catch {
      return null;
    }
  }

  /** Dry-run merge precheck used to gate accept and detect conflicts. */
  async proposalMergeStatus(
    doc: DocLocator,
    proposalId: string,
  ): Promise<'clean' | 'conflict' | 'merged' | 'absent' | 'unavailable'> {
    // Even with `dryRun: true`, iso-git's merge touches index/working-tree
    // state — serialize through the per-doc lock alongside writes/merges.
    return this.withLock(doc.uid, async () => {
      const dir = this.repoDir(doc.uid);
      if (!existsSync(join(dir, '.git'))) return 'absent';
      const refName = proposalRef(proposalId);
      let tipOid: string;
      try {
        tipOid = await git.resolveRef({ fs, dir, ref: refName });
      } catch {
        return 'absent';
      }
      const mainOid = await git.resolveRef({ fs, dir, ref: 'main' });
      if (tipOid === mainOid) return 'merged';
      try {
        await git.merge({
          fs,
          dir,
          ours: 'main',
          theirs: refName,
          dryRun: true,
          author: { name: 'check', email: 'check@local', timestamp: 0, timezoneOffset: 0 },
        });
        return 'clean';
      } catch (err) {
        const e = err as { code?: string };
        // MergeNotSupportedError: iso-git lacks the recursive strategy, so
        // it bails when the accept-merge web yields multiple merge bases.
        // Native git resolves those, so it gets the same fallback as
        // conflicts.
        if (e.code === 'MergeConflictError' || e.code === 'MergeNotSupportedError') {
          const nativeMerge = await this.previewProposalMergeWithGitUnlocked(doc, proposalId);
          return nativeMerge.ok ? 'clean' : nativeMerge.reason;
        }
        throw err;
      }
    });
  }

  /**
   * Run repair's merge preview and optional branch rewrite under the same
   * per-document lock as document writes. The callback runs before the
   * lock is released, so callers can commit DB anchor updates against the
   * exact main oid used for the preview.
   */
  async withProposalRepair<T>(
    doc: DocLocator,
    proposalId: string,
    identity: { displayName: string; clientId: string },
    apply: (result: ProposalRepairBranchResult) => Promise<T>,
  ): Promise<T> {
    return this.withLock(doc.uid, async () => {
      const preview = await this.previewProposalMergeWithGitUnlocked(doc, proposalId);
      let rewrite: RewriteProposalBranchResult | null = null;
      if (preview.ok && preview.before !== preview.after) {
        rewrite = await this.rewriteProposalBranchToMergedSourceUnlocked(
          doc,
          proposalId,
          preview.after,
          identity,
          preview.mainOid,
        );
      }
      return apply({ preview, rewrite });
    });
  }

  /**
   * Replace a proposal ref with a new one-commit proposal parented at
   * current main. Used after native Git has cleanly auto-resolved the
   * proposal against current source during repair, so later accept can
   * use the normal branch mechanism. The previous tip is retained under
   * `refs/proposals-original/<id>/<old-tip>`.
   */
  async rewriteProposalBranchToMergedSource(
    doc: DocLocator,
    proposalId: string,
    mergedSource: string,
    identity: { displayName: string; clientId: string },
    expectedMainOid?: string,
  ): Promise<RewriteProposalBranchResult> {
    return this.withLock(doc.uid, async () =>
      this.rewriteProposalBranchToMergedSourceUnlocked(
        doc,
        proposalId,
        mergedSource,
        identity,
        expectedMainOid,
      ),
    );
  }

  private async rewriteProposalBranchToMergedSourceUnlocked(
    doc: DocLocator,
    proposalId: string,
    mergedSource: string,
    identity: { displayName: string; clientId: string },
    expectedMainOid?: string,
  ): Promise<RewriteProposalBranchResult> {
    await this.ensureDocRepo(doc.uid);
    const dir = this.repoDir(doc.uid);
    const filename = this.filename(doc.format);
    const refName = proposalRef(proposalId);

    let mainOid: string;
    let tipOid: string;
    try {
      mainOid = await git.resolveRef({ fs, dir, ref: 'main' });
      tipOid = await git.resolveRef({ fs, dir, ref: refName });
    } catch {
      return { ok: false, reason: 'absent' };
    }
    if (expectedMainOid && mainOid !== expectedMainOid) {
      return { ok: false, reason: 'stale' };
    }

    const { commit: tipCommit } = await git.readCommit({ fs, dir, oid: tipOid });
    const { commit: mainCommit } = await git.readCommit({ fs, dir, oid: mainOid });
    const { tree } = await git.readTree({ fs, dir, oid: mainCommit.tree });
    const blobOid = await git.writeBlob({
      fs,
      dir,
      blob: new TextEncoder().encode(mergedSource),
    });
    const hasEntry = tree.some((e) => e.path === filename);
    const newTree = hasEntry
      ? tree.map((e) => (e.path === filename ? { ...e, oid: blobOid } : e))
      : [...tree, { path: filename, mode: '100644', type: 'blob' as const, oid: blobOid }];
    const newTreeOid = await git.writeTree({ fs, dir, tree: newTree });

    const ts = Math.floor(Date.now() / 1000);
    const committer = {
      name: identity.clientId,
      email: `${identity.clientId}@marginalia.local`,
      timestamp: ts,
      timezoneOffset: 0,
    };
    const commitOid = await git.writeCommit({
      fs,
      dir,
      commit: {
        tree: newTreeOid,
        parent: [mainOid],
        author: tipCommit.author,
        committer,
        message: tipCommit.message,
      },
    });

    const backupRef = `refs/proposals-original/${proposalId}/${tipOid}`;
    await git.writeRef({ fs, dir, ref: backupRef, value: tipOid, force: true });
    await git.writeRef({ fs, dir, ref: refName, value: commitOid, force: true });
    return { ok: true, commitOid, baseOid: mainOid, backupRef };
  }

  /**
   * Native Git's merge-file sometimes handles textual merges more
   * capably than iso-git's recursive merge. This is a pure preview:
   * it reads main/base/proposal blobs and never mutates refs or the
   * working tree.
   */
  async previewProposalMergeWithGit(
    doc: DocLocator,
    proposalId: string,
  ): Promise<PreviewProposalMergeResult> {
    return this.withLock(doc.uid, async () =>
      this.previewProposalMergeWithGitUnlocked(doc, proposalId),
    );
  }

  /**
   * Materialize the result of applying one proposal branch onto an
   * arbitrary source string without mutating refs or the working tree.
   * Export flows use this to build a temporary "all proposals accepted"
   * snapshot by folding open proposal branches into an in-memory source.
   */
  async previewProposalMergeIntoSource(
    doc: DocLocator,
    proposalId: string,
    source: string,
  ): Promise<PreviewProposalMergeIntoSourceResult> {
    return this.withLock(doc.uid, async () => {
      const dir = this.repoDir(doc.uid);
      if (!existsSync(join(dir, '.git'))) return { ok: false, reason: 'absent' };
      const refName = proposalRef(proposalId);
      let tipOid: string;
      try {
        tipOid = await git.resolveRef({ fs, dir, ref: refName });
      } catch {
        return { ok: false, reason: 'absent' };
      }

      let baseOid: string | undefined;
      try {
        const { commit } = await git.readCommit({ fs, dir, oid: tipOid });
        baseOid = commit.parent[0];
      } catch {
        return { ok: false, reason: 'absent' };
      }
      if (!baseOid) return { ok: false, reason: 'absent' };

      const base = await this.readAt(doc, baseOid);
      const proposed = await this.readAt(doc, tipOid);
      const merged = await mergeThreeWay({ current: source, base, proposed });
      return merged.ok ? { ok: true, after: merged.text } : { ok: false, reason: merged.reason };
    });
  }

  private async previewProposalMergeWithGitUnlocked(
    doc: DocLocator,
    proposalId: string,
  ): Promise<PreviewProposalMergeResult> {
    const dir = this.repoDir(doc.uid);
    if (!existsSync(join(dir, '.git'))) return { ok: false, reason: 'absent' };
    const refName = proposalRef(proposalId);
    let mainOid: string;
    let tipOid: string;
    try {
      mainOid = await git.resolveRef({ fs, dir, ref: 'main' });
      tipOid = await git.resolveRef({ fs, dir, ref: refName });
    } catch {
      return { ok: false, reason: 'absent' };
    }
    if (tipOid === mainOid) return { ok: false, reason: 'merged' };

    let baseOid: string | undefined;
    try {
      const { commit } = await git.readCommit({ fs, dir, oid: tipOid });
      baseOid = commit.parent[0];
    } catch {
      return { ok: false, reason: 'absent' };
    }
    if (!baseOid) return { ok: false, reason: 'absent' };

    const before = await this.readAt(doc, mainOid);
    const base = await this.readAt(doc, baseOid);
    const proposed = await this.readAt(doc, tipOid);
    const merged = await mergeThreeWay({ current: before, base, proposed });
    return merged.ok
      ? { ok: true, before, after: merged.text, mainOid }
      : { ok: false, reason: merged.reason };
  }
}

function proposalRef(proposalId: string): string {
  return `refs/proposals/${proposalId}`;
}

export type MergeProposalResult =
  | { ok: true; oid: string }
  | {
      ok: false;
      reason: 'conflict';
      conflict: {
        filepaths: string[];
        bothModified: string[];
        deleteByUs: string[];
        deleteByTheirs: string[];
      };
    }
  | { ok: false; reason: 'absent' | 'unavailable' };

export type PreviewProposalMergeResult =
  | { ok: true; before: string; after: string; mainOid: string }
  | { ok: false; reason: 'conflict' | 'absent' | 'merged' | 'unavailable' };

export type PreviewProposalMergeIntoSourceResult =
  | { ok: true; after: string }
  | { ok: false; reason: 'conflict' | 'absent' | 'unavailable' };

export type RewriteProposalBranchResult =
  | { ok: true; commitOid: string; baseOid: string; backupRef: string }
  | { ok: false; reason: 'absent' | 'stale' };

export type RevertCommitResult =
  | { ok: true; oid: string; before: string; after: string }
  | { ok: false; reason: 'absent' | 'conflict' | 'empty' | 'unavailable' };

/**
 * `reason` is an operator diagnostic, not user-facing prose — it carries
 * whatever git said, so it belongs in a log rather than in a response.
 */
export type ImportHistoryPackResult = { ok: true; oid: string } | { ok: false; reason: string };

export interface ProposalRepairBranchResult {
  preview: PreviewProposalMergeResult;
  rewrite: RewriteProposalBranchResult | null;
}

/** A packfile being produced by a subprocess, plus what describes it. */
export interface HistoryPackStream {
  headOid: string;
  commits: number;
  /**
   * Pack bytes in arrival order. Throws if git fails partway, rather
   * than ending early — a short pack is indistinguishable from a
   * complete one to anything downstream, and silently exporting a
   * truncated history is worse than failing the download.
   */
  chunks: AsyncIterable<Uint8Array>;
}

/**
 * Turn a spawned process into an async iterable of its stdout, but only
 * after the first bytes have arrived.
 *
 * That wait is the point. Spawn failures (no git on the runtime) and
 * argument failures (an unresolvable rev) both surface before any
 * output, and the caller can still fall back to a buffered path while
 * nothing has been written to the response. Once bytes are flowing the
 * status line is long gone, so every later failure can do nothing but
 * tear the stream down.
 *
 * stdout must stay attached to one reader for the whole read, and in
 * paused mode: a `data` listener would put it in flowing mode and drop
 * everything arriving between here and the consumer's first `next()`,
 * and so would leaving it with no reader at all.
 */
async function stdoutAfterFirstChunk(
  child: ChildProcessWithoutNullStreams,
  stdinPayload: string,
): Promise<AsyncIterable<Uint8Array>> {
  const { stdout } = child;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    // Diagnostics only, and this process outlives the read — bound it.
    if (stderr.length < 4096) stderr += text;
  });
  // A child that exits before draining stdin makes this write EPIPE,
  // which is a diagnosis we already get from the exit code.
  child.stdin.on('error', () => {});
  child.stdin.end(stdinPayload);

  const failure = (detail: string) =>
    new Error(`git ${child.spawnargs[1] ?? ''} ${detail}: ${stderr.trim()}`.replace(/\s+/g, ' '));

  // One iterator over stdout, attached before the first pull and reused
  // for the rest of the read. Taking the first chunk through a separate
  // `readable`/`read()` handler and handing the stream to `for await`
  // afterwards leaves it unattended in between, and whatever the child
  // writes in that window is dropped: for `git pack-objects` that is the
  // trailing checksum, written after the body, so the export silently
  // ships a truncated pack that only fails much later, on import.
  const chunks = stdout[Symbol.asyncIterator]();

  const firstPull = chunks.next();
  // Spawn failures (no git on the runtime) and argument failures (an
  // unresolvable rev) both surface before any output. Exit 0 is not one
  // of them even when it beats the first read: the pipe closes at EOF,
  // not when we get around to draining what git already buffered there.
  const failed = new Promise<never>((_, reject) => {
    child.once('error', reject);
    child.once('close', (code: number | null) => {
      if (code !== 0) reject(failure(`exited ${code}`));
    });
  });
  // Whichever loses the race stays pending and may settle later; mark
  // both handled so the loser can't surface as an unhandled rejection.
  // A non-zero exit that lands after the first chunk is still caught, by
  // the exit check once the stream drains.
  firstPull.catch(() => {});
  failed.catch(() => {});

  const first = await Promise.race([firstPull, failed]);
  if (first.done) throw failure('produced no output');

  return (async function* () {
    try {
      yield first.value as Uint8Array;
      for (;;) {
        const next = await chunks.next();
        if (next.done) break;
        yield next.value as Uint8Array;
      }
      const code = await exitCode(child);
      if (code !== 0) throw failure(`exited ${code}`);
    } finally {
      // Reached on the consumer's early `return()` too — a client that
      // hangs up mid-download must not leave git packing into a pipe
      // nobody is reading.
      if (child.exitCode === null) child.kill();
    }
  })();
}

/**
 * The one useful line out of a failed pack read.
 *
 * isomorphic-git wraps its actual diagnosis in a multi-paragraph "please
 * file a bug report" template and keeps the readable sentence in
 * `data.message`, so logging `err.message` buries the only part an
 * operator wants — which pack was bad and how — under boilerplate.
 */
function packFailureReason(err: unknown): string {
  const data = (err as { data?: { message?: unknown } } | null)?.data;
  const detail =
    typeof data?.message === 'string'
      ? data.message
      : err instanceof Error
        ? err.message
        : String(err);
  return detail.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function exitCode(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => child.once('close', (code) => resolve(code)));
}

/**
 * Stage to a sibling temp file in the same directory, then `rename()`
 * over the target. `rename()` is atomic on the same filesystem, so a
 * concurrent `readFileSync` always sees either the previous inode or
 * the fully-written new one — never the truncate-then-fill window that
 * a plain `writeFileSync` exposes. Same precedent as `FsBlobStore.put`.
 */
function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* best effort — leave the temp file for a later sweeper */
    }
    throw err;
  }
}

/** What the store needs to identify a doc. `DocumentRow` is a superset. */
export interface DocLocator {
  uid: string;
  format: DocumentFormat;
}

export interface HistoryEntry {
  oid: string;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
}
