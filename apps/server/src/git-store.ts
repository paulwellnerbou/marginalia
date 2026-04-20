import * as git from 'isomorphic-git';
import fs from 'node:fs';
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import type { DocumentFormat } from './db.js';

/**
 * Thin wrapper around isomorphic-git that stores every document as a file
 * at the repo root with a name derived from uid + format
 * (`<uid>.md` or `<uid>.adoc`). Every write is a commit authored by the
 * display name (+ client ID in the trailer).
 *
 * Methods below take `path` (the relative filename already stored in
 * `documents.path`) rather than re-deriving it from uid + format on
 * every call — the row's `path` column is authoritative and saves us
 * from having to pass two arguments everywhere.
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
  ): Promise<{ oid: string; path: string }> {
    const path = this.docPath(uid, format);
    writeFileSync(this.absPath(path), content);
    await git.add({ fs, dir: this.repoDir, filepath: path });
    const oid = await git.commit({
      fs,
      dir: this.repoDir,
      message: `${action}: ${uid}\n\nX-Marginalia-Client-ID: ${author.clientId}\n`,
      author: {
        name: author.displayName,
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
        name: author.displayName,
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

  async readAt(path: string, oid: string): Promise<string> {
    const { blob } = await git.readBlob({
      fs,
      dir: this.repoDir,
      oid,
      filepath: path,
    });
    return new TextDecoder().decode(blob);
  }
}

export interface HistoryEntry {
  oid: string;
  message: string;
  author: { name: string; email: string };
  timestamp: number;
}
