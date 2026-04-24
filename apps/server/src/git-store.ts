import * as git from 'isomorphic-git';
import fs from 'node:fs';
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import type { DocumentFormat } from './db.js';

/**
 * Thin wrapper around isomorphic-git that stores every document as a file
 * at the repo root with a name derived from uid + format
 * (`<uid>.md` or `<uid>.adoc`). Every write is a commit authored by the
 * stable client ID (+ extra Marginalia trailers when needed).
 *
 * `read()`, `history()`, `readAt()`, `deleteDoc()` take a relative `path`
 * — typically the value already stored in `documents.path`, so callers
 * don't have to re-derive it. `write()` is the outlier: it still takes
 * `uid` + `format` and derives the filename via `docPath()` itself,
 * since an upload is the moment the `path` column gets populated in the
 * first place. The class has both APIs on purpose.
 */
export class GitStore {
  constructor(private readonly repoDir: string) {}

  async init(): Promise<void> {
    mkdirSync(this.repoDir, { recursive: true });
    const gitDir = join(this.repoDir, '.git');
    if (!existsSync(gitDir)) {
      await git.init({ fs, dir: this.repoDir, defaultBranch: 'main' });
      // Seed with an initial empty commit so log() always works.
      writeFileSync(join(this.repoDir, '.marginalia-root'), 'marginalia repo\n');
      await git.add({ fs, dir: this.repoDir, filepath: '.marginalia-root' });
      await git.commit({
        fs,
        dir: this.repoDir,
        message: 'init',
        author: { name: 'marginalia', email: 'system@marginalia.local' },
      });
    }
  }

  docPath(uid: string, format: DocumentFormat = 'markdown'): string {
    return format === 'asciidoc' ? `${uid}.adoc` : `${uid}.md`;
  }

  absPath(path: string): string {
    return join(this.repoDir, path);
  }

  read(path: string): string {
    return readFileSync(this.absPath(path), 'utf8');
  }

  async write(
    uid: string,
    format: DocumentFormat,
    content: string,
    author: { displayName: string; clientId: string },
    action: 'upload' | 'update' | 'restore' | 'accept-proposal',
    meta: { proposalId?: string; restoredFromOid?: string; commitMessage?: string } = {},
  ): Promise<{ oid: string; path: string }> {
    const path = this.docPath(uid, format);
    writeFileSync(this.absPath(path), content);
    await git.add({ fs, dir: this.repoDir, filepath: path });
    const subject =
      action === 'accept-proposal' ? `${action}: ${meta.proposalId ?? uid}` : `${action}: ${uid}`;
    const trailers = [
      `X-Marginalia-Client-ID: ${author.clientId}`,
      meta.proposalId ? `X-Marginalia-Proposal-ID: ${meta.proposalId}` : null,
      meta.restoredFromOid ? `X-Marginalia-Restored-From: ${meta.restoredFromOid}` : null,
    ].filter((line): line is string => Boolean(line));
    const sanitizedCommitMessage = meta.commitMessage
      ? meta.commitMessage
          .split('\n')
          .filter((line) => !line.startsWith('X-Marginalia-'))
          .join('\n')
          .trim() || undefined
      : undefined;
    const bodyParts = sanitizedCommitMessage ? [sanitizedCommitMessage, trailers.join('\n')] : [trailers.join('\n')];
    const oid = await git.commit({
      fs,
      dir: this.repoDir,
      message: `${subject}\n\n${bodyParts.join('\n\n')}\n`,
      author: {
        name: author.clientId,
        email: `${author.clientId}@marginalia.local`,
      },
    });
    return { oid, path };
  }

  /**
   * Permanently remove a document's file and commit the deletion. NOTE:
   * old commit blobs still hold the previous content in the git object
   * database (not exposed via any API). If "no trace" needs to extend to
   * the on-disk blobs too, follow up with a `git gc --prune=now` after
   * history rewriting — deliberately left out for now.
   */
  async deleteDoc(
    path: string,
    uid: string,
    author: { displayName: string; clientId: string },
  ): Promise<void> {
    const absPath = this.absPath(path);
    if (existsSync(absPath)) {
      rmSync(absPath, { force: true });
    }
    await git.remove({ fs, dir: this.repoDir, filepath: path });
    await git.commit({
      fs,
      dir: this.repoDir,
      message: `delete: ${uid}\n\nX-Marginalia-Client-ID: ${author.clientId}\n`,
      author: {
        name: author.clientId,
        email: `${author.clientId}@marginalia.local`,
      },
    });
  }

  async history(path: string): Promise<HistoryEntry[]> {
    const entries = await git.log({
      fs,
      dir: this.repoDir,
      filepath: path,
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

  async diffAt(path: string, oid: string): Promise<{ before: string; after: string } | null> {
    const after = await this.tryReadAt(path, oid);
    if (after === null) return null;

    let parentOid: string | undefined;
    try {
      const { commit } = await git.readCommit({ fs, dir: this.repoDir, oid });
      parentOid = commit.parent[0];
    } catch {
      return null;
    }

    const before = parentOid ? (await this.tryReadAt(path, parentOid)) ?? '' : '';
    return { before, after };
  }

  async readAt(path: string, oid: string): Promise<string> {
    const { blob } = await git.readBlob({
      fs,
      dir: this.repoDir,
      oid,
      filepath: path,
    });
    return new TextDecoder().decode(blob);
  }

  private async tryReadAt(path: string, oid: string): Promise<string | null> {
    try {
      return await this.readAt(path, oid);
    } catch {
      return null;
    }
  }
}

export interface HistoryEntry {
  oid: string;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
}
