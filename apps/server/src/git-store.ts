import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import type { DocumentFormat } from './db.js';

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
      const newTree = tree.map((e) => (e.path === filename ? { ...e, oid: blobOid } : e));
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
      const message =
        `accept-proposal: ${proposalId}\n\n` +
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
      if (e.code === 'MergeConflictError') return 'conflict';
      throw err;
    }
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
