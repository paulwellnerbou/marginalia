import * as git from 'isomorphic-git';
import fs from 'node:fs';
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';

/**
 * Thin wrapper around isomorphic-git that stores every document as a file
 * at the repo root with name `<uid>.md`. Every write is a commit authored
 * by the display name (+ client ID in the trailer).
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

  docPath(uid: string): string {
    return `${uid}.md`;
  }

  absPath(uid: string): string {
    return join(this.repoDir, this.docPath(uid));
  }

  read(uid: string): string {
    return readFileSync(this.absPath(uid), 'utf8');
  }

  async write(
    uid: string,
    content: string,
    author: { displayName: string; clientId: string },
    action: 'upload' | 'update' | 'restore' | 'accept-proposal',
  ): Promise<{ oid: string }> {
    writeFileSync(this.absPath(uid), content);
    await git.add({ fs, dir: this.repoDir, filepath: this.docPath(uid) });
    const oid = await git.commit({
      fs,
      dir: this.repoDir,
      message: `${action}: ${uid}\n\nX-Marginalia-Client-ID: ${author.clientId}\n`,
      author: {
        name: author.displayName,
        email: `${author.clientId}@marginalia.local`,
      },
    });
    return { oid };
  }

  async history(uid: string): Promise<HistoryEntry[]> {
    const entries = await git.log({
      fs,
      dir: this.repoDir,
      filepath: this.docPath(uid),
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

  async readAt(uid: string, oid: string): Promise<string> {
    const { blob } = await git.readBlob({
      fs,
      dir: this.repoDir,
      oid,
      filepath: this.docPath(uid),
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
