import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as git from 'isomorphic-git';
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
    });
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

  async history(doc: DocLocator): Promise<HistoryEntry[]> {
    const dir = this.repoDir(doc.uid);
    if (!existsSync(join(dir, '.git'))) return [];
    const entries = await git.log({
      fs,
      dir,
      filepath: this.filename(doc.format),
      force: true, // include even if file was deleted in later commits
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

  /** Main's current tip oid for this doc. Throws if the repo isn't initialized. */
  async mainOid(doc: DocLocator): Promise<string> {
    return git.resolveRef({ fs, dir: this.repoDir(doc.uid), ref: 'main' });
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
        if (e.code === 'MergeConflictError') {
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
  ): Promise<'clean' | 'conflict' | 'merged' | 'absent'> {
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
        if (e.code === 'MergeConflictError') {
          const nativeMerge = await this.previewProposalMergeWithGitUnlocked(doc, proposalId);
          return nativeMerge.ok ? 'clean' : nativeMerge.reason;
        }
        throw err;
      }
    });
  }

  /**
   * Materialize the result of merging a proposal branch into current main
   * without mutating refs or the working tree. Used by repair flows that
   * need git's real 3-way placement to discover where an orphaned proposal
   * applies in the current source.
   */
  async previewProposalMerge(
    doc: DocLocator,
    proposalId: string,
  ): Promise<PreviewProposalMergeResult> {
    return this.withLock(doc.uid, async () =>
      this.previewProposalMergeWithGitUnlocked(doc, proposalId),
    );
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
      const after = await mergeTextWithNativeGit(source, base, proposed);
      return after === null ? { ok: false, reason: 'conflict' } : { ok: true, after };
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
    const after = await mergeTextWithNativeGit(before, base, proposed);
    return after === null
      ? { ok: false, reason: 'conflict' }
      : { ok: true, before, after, mainOid, strategy: 'native-git' };
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
  | { ok: false; reason: 'absent' };

export type PreviewProposalMergeResult =
  | {
      ok: true;
      before: string;
      after: string;
      mainOid: string;
      strategy: 'isomorphic-git' | 'native-git';
    }
  | { ok: false; reason: 'conflict' | 'absent' | 'merged' };

export type PreviewProposalMergeIntoSourceResult =
  | { ok: true; after: string }
  | { ok: false; reason: 'conflict' | 'absent' };

export type RewriteProposalBranchResult =
  | { ok: true; commitOid: string; baseOid: string; backupRef: string }
  | { ok: false; reason: 'absent' | 'stale' };

export interface ProposalRepairBranchResult {
  preview: PreviewProposalMergeResult;
  rewrite: RewriteProposalBranchResult | null;
}

async function mergeTextWithNativeGit(
  ours: string,
  base: string,
  theirs: string,
): Promise<string | null> {
  const dir = mkdtempSync(join(tmpdir(), 'marginalia-merge-'));
  try {
    const oursPath = join(dir, 'ours');
    const basePath = join(dir, 'base');
    const theirsPath = join(dir, 'theirs');
    writeFileSync(oursPath, ours);
    writeFileSync(basePath, base);
    writeFileSync(theirsPath, theirs);
    const { stdout } = await execFileAsync(
      'git',
      ['merge-file', '-p', oursPath, basePath, theirsPath],
      {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      },
    );
    if (hasConflictMarkers(stdout)) return null;
    return stdout;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function hasConflictMarkers(source: string): boolean {
  return /^(<<<<<<<|=======|>>>>>>>)(?: .*)?$/m.test(source);
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
