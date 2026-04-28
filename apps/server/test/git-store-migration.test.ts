import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { openDatabase } from '../src/db.js';
import { migrateSharedRepoToPerDoc } from '../src/git-store-migration.js';
import { GitStore } from '../src/git-store.js';

/**
 * Phase 1 migration: split a single shared monorepo (everything at the
 * repo root, one file per doc named `<uid>.<ext>`) into one per-doc repo
 * each. Per-doc history must be preserved with original author /
 * timestamp / commit message; the legacy repo is moved aside as a
 * backup; subsequent boots are a no-op.
 */
describe('migrateSharedRepoToPerDoc', () => {
  let dir: string;
  let dbPath: string;
  let legacyRepoDir: string;
  let reposBaseDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-mig-'));
    dbPath = join(dir, 'db.sqlite');
    legacyRepoDir = join(dir, 'repo');
    reposBaseDir = join(dir, 'repos');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function seedLegacy(
    docs: Array<{
      uid: string;
      format: 'markdown' | 'asciidoc';
      commits: Array<{
        content: string | null;
        message: string;
        author: string;
        timestampSec: number;
      }>;
    }>,
  ): Promise<void> {
    mkdirSync(legacyRepoDir, { recursive: true });
    await git.init({ fs, dir: legacyRepoDir, defaultBranch: 'main' });
    writeFileSync(join(legacyRepoDir, '.marginalia-root'), 'marginalia repo\n');
    await git.add({ fs, dir: legacyRepoDir, filepath: '.marginalia-root' });
    await git.commit({
      fs,
      dir: legacyRepoDir,
      message: 'init',
      author: { name: 'marginalia', email: 'system@marginalia.local' },
    });

    for (const doc of docs) {
      const filename = doc.format === 'asciidoc' ? `${doc.uid}.adoc` : `${doc.uid}.md`;
      const filepath = join(legacyRepoDir, filename);
      for (const commit of doc.commits) {
        if (commit.content !== null) {
          writeFileSync(filepath, commit.content);
          await git.add({ fs, dir: legacyRepoDir, filepath: filename });
        } else {
          rmSync(filepath, { force: true });
          await git.remove({ fs, dir: legacyRepoDir, filepath: filename });
        }
        await git.commit({
          fs,
          dir: legacyRepoDir,
          message: commit.message,
          author: {
            name: commit.author,
            email: `${commit.author}@example.com`,
            timestamp: commit.timestampSec,
            timezoneOffset: 0,
          },
        });
      }
    }
  }

  function seedDocsRow(uid: string, format: 'markdown' | 'asciidoc'): void {
    const db = openDatabase(dbPath);
    db.prepare(
      `INSERT INTO documents (uid, repo_dir, format, default_theme, created_at, updated_at)
       VALUES (?, ?, ?, 'default', 0, 0)`,
    ).run(uid, uid, format);
    db.close();
  }

  test('replays per-file history into per-doc repos with author/timestamp preserved', async () => {
    await seedLegacy([
      {
        uid: 'doc-a',
        format: 'markdown',
        commits: [
          {
            content: '# A v1\n',
            message: 'upload: doc-a\n\nX-Marginalia-Client-ID: alice\n',
            author: 'alice',
            timestampSec: 1_700_000_000,
          },
          {
            content: '# A v2\n',
            message: 'update: doc-a\n\nX-Marginalia-Client-ID: alice\n',
            author: 'alice',
            timestampSec: 1_700_000_100,
          },
        ],
      },
      {
        uid: 'doc-b',
        format: 'asciidoc',
        commits: [
          {
            content: '= B v1\n',
            message: 'upload: doc-b\n\nX-Marginalia-Client-ID: bob\n',
            author: 'bob',
            timestampSec: 1_700_000_050,
          },
        ],
      },
    ]);
    seedDocsRow('doc-a', 'markdown');
    seedDocsRow('doc-b', 'asciidoc');

    const db = openDatabase(dbPath);
    await migrateSharedRepoToPerDoc(db, legacyRepoDir, reposBaseDir);

    const store = new GitStore(reposBaseDir);
    await store.init();

    // history() filters by the doc's filepath, so the per-doc seed
    // `init` commit (which only touches `.marginalia-root`) is filtered
    // out. What's left is exactly the doc's user-visible history.
    const aHistory = await store.history({ uid: 'doc-a', format: 'markdown' });
    expect(aHistory.map((e) => e.author.name)).toEqual(['alice', 'alice']);
    expect(aHistory[0]?.timestamp).toBe(1_700_000_100 * 1000);
    expect(aHistory[0]?.message).toContain('X-Marginalia-Client-ID: alice');
    expect(store.read({ uid: 'doc-a', format: 'markdown' })).toBe('# A v2\n');

    const bHistory = await store.history({ uid: 'doc-b', format: 'asciidoc' });
    expect(bHistory.map((e) => e.author.name)).toEqual(['bob']);
    expect(store.read({ uid: 'doc-b', format: 'asciidoc' })).toBe('= B v1\n');
    db.close();
  });

  test('legacy repo is moved aside as `.legacy` after a successful run', async () => {
    await seedLegacy([
      {
        uid: 'only',
        format: 'markdown',
        commits: [
          {
            content: 'hi\n',
            message: 'upload: only\n',
            author: 'paul',
            timestampSec: 1_700_000_000,
          },
        ],
      },
    ]);
    seedDocsRow('only', 'markdown');

    const db = openDatabase(dbPath);
    await migrateSharedRepoToPerDoc(db, legacyRepoDir, reposBaseDir);
    db.close();

    expect(existsSync(legacyRepoDir)).toBe(false);
    expect(existsSync(`${legacyRepoDir}.legacy`)).toBe(true);
    expect(existsSync(join(reposBaseDir, 'only', '.git'))).toBe(true);
  });

  test('is a no-op when no legacy repo exists', async () => {
    seedDocsRow('fresh', 'markdown');
    const db = openDatabase(dbPath);
    await migrateSharedRepoToPerDoc(db, legacyRepoDir, reposBaseDir);
    db.close();

    expect(existsSync(reposBaseDir)).toBe(false);
  });

  test('skips docs whose per-doc repo already exists', async () => {
    await seedLegacy([
      {
        uid: 'doc-a',
        format: 'markdown',
        commits: [
          {
            content: '# A\n',
            message: 'upload: doc-a\n',
            author: 'alice',
            timestampSec: 1_700_000_000,
          },
        ],
      },
    ]);
    seedDocsRow('doc-a', 'markdown');

    // Pre-create the per-doc repo with different content.
    mkdirSync(join(reposBaseDir, 'doc-a'), { recursive: true });
    await git.init({ fs, dir: join(reposBaseDir, 'doc-a'), defaultBranch: 'main' });
    writeFileSync(join(reposBaseDir, 'doc-a', 'document.md'), 'pre-existing\n');
    await git.add({ fs, dir: join(reposBaseDir, 'doc-a'), filepath: 'document.md' });
    await git.commit({
      fs,
      dir: join(reposBaseDir, 'doc-a'),
      message: 'pre-existing',
      author: { name: 'someone', email: 'someone@example.com' },
    });

    const db = openDatabase(dbPath);
    await migrateSharedRepoToPerDoc(db, legacyRepoDir, reposBaseDir);
    db.close();

    const store = new GitStore(reposBaseDir);
    await store.init();
    expect(store.read({ uid: 'doc-a', format: 'markdown' })).toBe('pre-existing\n');
  });
});

describe('GitStore mutex', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-store-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('serializes concurrent writes to the same doc', async () => {
    const store = new GitStore(dir);
    await store.init();

    const writes = Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        store.write(
          { uid: 'doc', format: 'markdown' },
          `version ${i}\n`,
          { displayName: 'tester', clientId: `client-${i}` },
          'update',
        ),
      ),
    );
    const results = await writes;
    expect(results).toHaveLength(5);

    const history = await store.history({ uid: 'doc', format: 'markdown' });
    // 5 writes → 5 commits, each with a distinct oid (no collisions, no
    // race-y partial states).
    expect(history).toHaveLength(5);
    expect(new Set(history.map((e) => e.oid)).size).toBe(5);
  });

  test('writes to different docs run in parallel without interference', async () => {
    const store = new GitStore(dir);
    await store.init();

    await Promise.all([
      store.write(
        { uid: 'doc-a', format: 'markdown' },
        'A\n',
        { displayName: 'a', clientId: 'a' },
        'upload',
      ),
      store.write(
        { uid: 'doc-b', format: 'markdown' },
        'B\n',
        { displayName: 'b', clientId: 'b' },
        'upload',
      ),
    ]);

    expect(store.read({ uid: 'doc-a', format: 'markdown' })).toBe('A\n');
    expect(store.read({ uid: 'doc-b', format: 'markdown' })).toBe('B\n');
  });
});
