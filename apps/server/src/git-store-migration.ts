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

  // Track per-doc failures separately from per-doc successes so we
  // don't archive the legacy repo while any doc still needs a retry.
  // A failed doc's `targetDir` was already cleaned up by `migrateOneDoc`,
  // so the next boot will see no `.git` there and re-attempt cleanly.
  const failures: Array<{ uid: string; reason: string }> = [];
  for (const doc of docs) {
    const targetDir = join(reposBaseDir, doc.uid);
    if (existsSync(join(targetDir, '.git'))) continue;
    try {
      await migrateOneDoc(legacyRepoDir, targetDir, doc);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failures.push({ uid: doc.uid, reason });
      console.error(
        `[marginalia] per-doc migration failed for ${doc.uid}: ${reason}`,
      );
    }
  }

  if (failures.length > 0) {
    console.error(
      `[marginalia] ${failures.length} doc(s) did not migrate; ` +
        `legacy repo kept at ${legacyRepoDir} for retry on next boot.`,
    );
    return;
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
  // a stub `.git` from a partial init would lock in a broken migration
  // (subsequent boots skip uids whose target repo already exists).
  //
  // Discriminate `NotFoundError` (no history for this filepath — a
  // benign "skip and lazy-init on first write" signal) from real
  // errors like repo corruption or permission issues, which must
  // surface so the caller keeps the legacy repo around for retry.
  let entries: Awaited<ReturnType<typeof git.log>>;
  try {
    entries = await git.log({
      fs,
      dir: legacyRepoDir,
      filepath: legacyFilename,
      force: true,
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'NotFoundError') return;
    throw err;
  }
  if (entries.length === 0) return;
  // git.log returns newest-first; replay oldest-first.
  entries.reverse();

  // Wrap the materialize-and-replay block so any failure (a corrupt
  // legacy blob, a write error, etc) doesn't leave a half-built repo
  // behind. The idempotency check at the call site uses `.git`
  // existence as its resume marker, so a stub directory would
  // otherwise lock in a partial migration.
  try {
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
      // readBlob throws NotFoundError when the file was deleted at this
      // commit — that's a legitimate "replay as deletion" signal. Any
      // other error means corruption / IO trouble; rethrow so the
      // caller cleans up rather than silently turning a bad commit
      // into a deletion in the new history.
      let blob: Uint8Array | null;
      try {
        const res = await git.readBlob({
          fs,
          dir: legacyRepoDir,
          oid: entry.oid,
          filepath: legacyFilename,
        });
        blob = res.blob;
      } catch (err) {
        if ((err as { code?: string }).code === 'NotFoundError') {
          blob = null;
        } else {
          throw err;
        }
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
      // If blob is null and the file was never present in the new
      // repo, skip — there's nothing to delete and the original commit
      // was a no-op for this filepath.
    }
  } catch (err) {
    // Tear down the partial repo so the next boot retries cleanly.
    rmSync(targetDir, { recursive: true, force: true });
    throw err;
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
