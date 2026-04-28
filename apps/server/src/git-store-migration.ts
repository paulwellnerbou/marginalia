import type { Database } from 'bun:sqlite';
import fs from 'node:fs';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import type { DocumentFormat } from './db.js';

/**
 * Split the legacy shared monorepo at `<dataDir>/repo` into per-doc
 * repos at `<dataDir>/repos/<uid>/`. Idempotent: skips docs whose
 * per-doc repo already exists, and is a no-op if there's no legacy
 * repo to migrate.
 *
 * For each doc, we replay the file's history out of the shared repo
 * into the new per-doc repo, preserving author / timestamp / message
 * (including Marginalia trailers). Once every doc with prior history
 * has been migrated, the legacy repo is renamed to `repo.legacy` so
 * it stays around for a release cycle as a safety net.
 */
export async function migrateSharedRepoToPerDoc(
  db: Database,
  legacyRepoDir: string,
  reposBaseDir: string,
): Promise<void> {
  if (!existsSync(join(legacyRepoDir, '.git'))) return;

  mkdirSync(reposBaseDir, { recursive: true });

  const docs = db.prepare('SELECT uid, format FROM documents').all() as Array<{
    uid: string;
    format: DocumentFormat;
  }>;

  for (const doc of docs) {
    const targetDir = join(reposBaseDir, doc.uid);
    if (existsSync(join(targetDir, '.git'))) continue;
    await migrateOneDoc(legacyRepoDir, targetDir, doc);
  }

  archiveLegacyRepo(legacyRepoDir);
}

async function migrateOneDoc(
  legacyRepoDir: string,
  targetDir: string,
  doc: { uid: string; format: DocumentFormat },
): Promise<void> {
  const legacyFilename = doc.format === 'asciidoc' ? `${doc.uid}.adoc` : `${doc.uid}.md`;
  const newFilename = doc.format === 'asciidoc' ? 'document.adoc' : 'document.md';

  // Validate the legacy history *before* materializing the target repo:
  // if log() throws or returns nothing, leaving a stub `.git` behind
  // would lock in a broken migration (subsequent boots skip uids whose
  // target repo already exists). Skip such docs entirely; they get the
  // normal lazy-init flow on first write instead.
  let entries: Awaited<ReturnType<typeof git.log>>;
  try {
    entries = await git.log({
      fs,
      dir: legacyRepoDir,
      filepath: legacyFilename,
      force: true,
    });
  } catch {
    return;
  }
  if (entries.length === 0) return;
  // git.log returns newest-first; replay oldest-first.
  entries.reverse();

  // Initialize the new repo with the same seed commit pattern as fresh
  // doc repos so log() always works.
  mkdirSync(targetDir, { recursive: true });
  await git.init({ fs, dir: targetDir, defaultBranch: 'main' });
  writeFileSync(join(targetDir, '.marginalia-root'), 'marginalia repo\n');
  await git.add({ fs, dir: targetDir, filepath: '.marginalia-root' });
  await git.commit({
    fs,
    dir: targetDir,
    message: 'init',
    author: { name: 'marginalia', email: 'system@marginalia.local' },
  });

  for (const entry of entries) {
    let blob: Uint8Array | null = null;
    try {
      const res = await git.readBlob({
        fs,
        dir: legacyRepoDir,
        oid: entry.oid,
        filepath: legacyFilename,
      });
      blob = res.blob;
    } catch {
      blob = null;
    }

    const targetFile = join(targetDir, newFilename);
    const author = {
      name: entry.commit.author.name,
      email: entry.commit.author.email,
      timestamp: entry.commit.author.timestamp,
      timezoneOffset: entry.commit.author.timezoneOffset,
    };
    const committer = entry.commit.committer
      ? {
          name: entry.commit.committer.name,
          email: entry.commit.committer.email,
          timestamp: entry.commit.committer.timestamp,
          timezoneOffset: entry.commit.committer.timezoneOffset,
        }
      : author;

    if (blob !== null) {
      writeFileSync(targetFile, blob);
      await git.add({ fs, dir: targetDir, filepath: newFilename });
      await git.commit({
        fs,
        dir: targetDir,
        message: entry.commit.message,
        author,
        committer,
      });
    } else if (existsSync(targetFile)) {
      rmSync(targetFile);
      await git.remove({ fs, dir: targetDir, filepath: newFilename });
      await git.commit({
        fs,
        dir: targetDir,
        message: entry.commit.message,
        author,
        committer,
      });
    }
    // If blob is null and the file was never present in the new repo,
    // skip — there's nothing to delete and the original commit was a
    // no-op for this filepath.
  }
}

/**
 * Move the legacy shared repo aside so it stays available as a backup
 * for a release cycle. Idempotent: if `<dir>.legacy` already exists,
 * leave the (now-stale) original alone — operators can clean up
 * manually.
 */
function archiveLegacyRepo(legacyRepoDir: string): void {
  const archived = `${legacyRepoDir}.legacy`;
  if (existsSync(archived)) return;
  try {
    renameSync(legacyRepoDir, archived);
  } catch {
    // Best-effort: if rename fails (e.g. cross-device), leave the
    // original in place. The migration is idempotent so subsequent
    // boots will re-attempt.
  }
}

/**
 * Test/utility hook: wipe `<reposBaseDir>` so a clean migration can
 * be re-run. Not used by production paths.
 */
export function clearReposBaseDir(reposBaseDir: string): void {
  if (!existsSync(reposBaseDir)) return;
  for (const entry of readdirSync(reposBaseDir)) {
    rmSync(join(reposBaseDir, entry), { recursive: true, force: true });
  }
}
