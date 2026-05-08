import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateAllBlocks } from '@marginalia/renderer';
import * as git from 'isomorphic-git';
import { openDatabase } from '../src/db.js';
import { GitStore } from '../src/git-store.js';
import { backfillProposalBranches } from '../src/proposal-branch-backfill.js';

/**
 * Boot-time backfill for pre-#25 / pre-Phase-3 databases: open proposal
 * rows that still have `proposed_text` in the column get a one-commit
 * `refs/proposals/<pid>` branch built from it. Once Phase 3 has run,
 * the column is dropped and backfill becomes a no-op.
 */
describe('backfillProposalBranches', () => {
  let dir: string;
  let dbPath: string;
  let reposDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-backfill-'));
    dbPath = join(dir, 'db.sqlite');
    reposDir = join(dir, 'repos');
  });

  /**
   * Re-add the legacy columns the production schema dropped, so these
   * tests can seed a pre-Phase-3 row layout. Idempotent.
   */
  function reinstateLegacyColumns(db: Database): void {
    const cols = db.prepare(`PRAGMA table_info(comments_edit_proposals)`).all() as Array<{
      name: string;
    }>;
    const has = new Set(cols.map((c) => c.name));
    if (!has.has('anchor_kind')) {
      db.exec(`ALTER TABLE comments_edit_proposals ADD COLUMN anchor_kind TEXT`);
    }
    if (!has.has('source_snapshot')) {
      db.exec(`ALTER TABLE comments_edit_proposals ADD COLUMN source_snapshot TEXT`);
    }
    if (!has.has('proposed_text')) {
      db.exec(`ALTER TABLE comments_edit_proposals ADD COLUMN proposed_text TEXT`);
    }
  }

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Insert a doc + a single open proposal row sans `branch_ref`/`base_oid`,
   * mimicking the pre-#25 storage shape.
   */
  async function seedLegacyDoc(opts: {
    uid: string;
    source: string;
    proposalId: string;
    proposedText: string;
    blockText: string;
  }): Promise<{ blockId: string }> {
    const db = openDatabase(dbPath);
    reinstateLegacyColumns(db);
    db.prepare(
      `INSERT INTO documents (uid, repo_dir, format, default_theme, created_at, updated_at)
       VALUES (?, ?, 'markdown', 'default', 0, 0)`,
    ).run(opts.uid, opts.uid);
    const store = new GitStore(reposDir);
    await store.init();
    await store.write(
      { uid: opts.uid, format: 'markdown' },
      opts.source,
      { displayName: 'seed', clientId: 'seed' },
      'upload',
    );
    const blockId = [...locateAllBlocks(opts.source).entries()].find(
      ([, range]) => range.text === opts.blockText,
    )?.[0];
    if (!blockId) throw new Error(`block "${opts.blockText}" not found in seed`);

    db.prepare(
      `INSERT INTO comments
         (id, doc_uid, anchor_block_id, anchor_quote,
          author_client_id, author_display_name,
          body, link_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'seed', 'Seed', '', 'linked', 0, 0)`,
    ).run(opts.proposalId, opts.uid, blockId, opts.blockText);
    db.prepare(
      `INSERT INTO comments_edit_proposals
         (comment_id, anchor_kind, source_snapshot, proposed_text, status, accepted_oid, branch_ref, base_oid)
       VALUES (?, NULL, ?, ?, 'open', NULL, NULL, NULL)`,
    ).run(opts.proposalId, opts.blockText, opts.proposedText);
    db.close();
    return { blockId };
  }

  test('backfills branch_ref + base_oid for an open legacy proposal', async () => {
    await seedLegacyDoc({
      uid: 'doc-1',
      source: '# Title\n\nalpha',
      proposalId: 'prop-1',
      proposedText: 'beta',
      blockText: 'alpha',
    });

    const db = openDatabase(dbPath);
    const store = new GitStore(reposDir);
    await store.init();

    const summary = await backfillProposalBranches(db, store);
    expect(summary).toEqual({ migrated: 1, skipped: 0 });

    const row = db
      .prepare(
        `SELECT branch_ref, base_oid FROM comments_edit_proposals WHERE comment_id = 'prop-1'`,
      )
      .get() as { branch_ref: string; base_oid: string };
    expect(row.branch_ref).toBe('refs/proposals/prop-1');
    expect(row.base_oid).toBeString();

    // The branch tip must contain the spliced source (full doc, block
    // replaced) so accept can use git.merge against current main.
    const tip = await store.readProposalTip({ uid: 'doc-1', format: 'markdown' }, 'prop-1');
    expect(tip).toBe('# Title\n\nbeta');

    // base_oid must equal main's tip at backfill time.
    const mainOid = await git.resolveRef({
      fs,
      dir: store.repoDir('doc-1'),
      ref: 'main',
    });
    expect(row.base_oid).toBe(mainOid);

    // The branch commit must be authored by the proposal's author
    // (`seed`) — not by a hard-coded backfill identity. Otherwise a
    // FF accept would attribute the resulting `accept-proposal:` history
    // entry to the wrong user.
    const tipOid = await git.resolveRef({
      fs,
      dir: store.repoDir('doc-1'),
      ref: 'refs/proposals/prop-1',
    });
    const { commit } = await git.readCommit({ fs, dir: store.repoDir('doc-1'), oid: tipOid });
    expect(commit.author.name).toBe('seed');
    expect(commit.message).toContain('X-Marginalia-Client-ID: seed');

    db.close();
  });

  test('is idempotent — running twice changes nothing', async () => {
    await seedLegacyDoc({
      uid: 'doc-1',
      source: '# Title\n\nalpha',
      proposalId: 'prop-1',
      proposedText: 'beta',
      blockText: 'alpha',
    });

    const db = openDatabase(dbPath);
    const store = new GitStore(reposDir);
    await store.init();

    const first = await backfillProposalBranches(db, store);
    expect(first).toEqual({ migrated: 1, skipped: 0 });

    const rowAfterFirst = db
      .prepare(
        `SELECT branch_ref, base_oid FROM comments_edit_proposals WHERE comment_id = 'prop-1'`,
      )
      .get() as { branch_ref: string; base_oid: string };

    const second = await backfillProposalBranches(db, store);
    expect(second).toEqual({ migrated: 0, skipped: 0 });

    const rowAfterSecond = db
      .prepare(
        `SELECT branch_ref, base_oid FROM comments_edit_proposals WHERE comment_id = 'prop-1'`,
      )
      .get() as { branch_ref: string; base_oid: string };
    expect(rowAfterSecond).toEqual(rowAfterFirst);

    db.close();
  });

  test('skips rows whose anchor block can no longer be located', async () => {
    // Seed a proposal whose anchor_block_id no longer exists in main's
    // current source (the doc was edited after the proposal was made,
    // before #25 added orphan tracking on every edit).
    const db = openDatabase(dbPath);
    reinstateLegacyColumns(db);
    db.prepare(
      `INSERT INTO documents (uid, repo_dir, format, default_theme, created_at, updated_at)
       VALUES ('doc-1', 'doc-1', 'markdown', 'default', 0, 0)`,
    ).run();
    const store = new GitStore(reposDir);
    await store.init();
    await store.write(
      { uid: 'doc-1', format: 'markdown' },
      '# Title\n\nalpha',
      { displayName: 'seed', clientId: 'seed' },
      'upload',
    );
    db.prepare(
      `INSERT INTO comments
         (id, doc_uid, anchor_block_id, anchor_quote,
          author_client_id, author_display_name,
          body, link_status, created_at, updated_at)
       VALUES ('prop-1', 'doc-1', 'block-that-does-not-exist', 'gone',
               'seed', 'Seed', '', 'linked', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO comments_edit_proposals
         (comment_id, anchor_kind, source_snapshot, proposed_text, status, accepted_oid, branch_ref, base_oid)
       VALUES ('prop-1', NULL, 'gone', 'edited', 'open', NULL, NULL, NULL)`,
    ).run();

    const summary = await backfillProposalBranches(db, store);
    expect(summary).toEqual({ migrated: 0, skipped: 1 });

    const row = db
      .prepare(
        `SELECT branch_ref, base_oid FROM comments_edit_proposals WHERE comment_id = 'prop-1'`,
      )
      .get() as { branch_ref: string | null; base_oid: string | null };
    expect(row.branch_ref).toBeNull();
    expect(row.base_oid).toBeNull();

    db.close();
  });

  test('leaves rows with status != open untouched', async () => {
    await seedLegacyDoc({
      uid: 'doc-1',
      source: '# Title\n\nalpha',
      proposalId: 'prop-accepted',
      proposedText: 'beta',
      blockText: 'alpha',
    });
    const db = openDatabase(dbPath);
    db.prepare(
      `UPDATE comments_edit_proposals SET status = 'accepted' WHERE comment_id = 'prop-accepted'`,
    ).run();
    const store = new GitStore(reposDir);
    await store.init();

    const summary = await backfillProposalBranches(db, store);
    expect(summary).toEqual({ migrated: 0, skipped: 0 });

    const row = db
      .prepare(`SELECT branch_ref FROM comments_edit_proposals WHERE comment_id = 'prop-accepted'`)
      .get() as { branch_ref: string | null };
    expect(row.branch_ref).toBeNull();

    db.close();
  });

  test('reuses stored base_oid even when byte range is null; recomputes range from base_oid source', async () => {
    // Half-populated row: base_oid was captured but the byte range
    // wasn't (e.g. createThread reached store.readAt successfully but
    // locateBlockRange returned null at create time, or a later
    // schema migration left ranges null). The backfill must reuse
    // base_oid as the splice base and locate the block in *that*
    // source — not silently re-anchor onto current main.
    const db = openDatabase(dbPath);
    reinstateLegacyColumns(db);
    db.prepare(
      `INSERT INTO documents (uid, repo_dir, format, default_theme, created_at, updated_at)
       VALUES ('doc-1', 'doc-1', 'markdown', 'default', 0, 0)`,
    ).run();
    const store = new GitStore(reposDir);
    await store.init();

    const baseSource = '# Title\n\nalpha';
    await store.write(
      { uid: 'doc-1', format: 'markdown' },
      baseSource,
      { displayName: 'orig', clientId: 'orig' },
      'upload',
    );
    const originalBaseOid = await store.mainOid({ uid: 'doc-1', format: 'markdown' });
    const blockId = [...locateAllBlocks(baseSource).entries()].find(
      ([, range]) => range.text === 'alpha',
    )?.[0];
    if (!blockId) throw new Error('seed alpha block not found');

    db.prepare(
      `INSERT INTO comments
         (id, doc_uid, anchor_block_id, anchor_quote,
          author_client_id, author_display_name,
          body, link_status, created_at, updated_at)
       VALUES ('prop-1', 'doc-1', ?, 'alpha',
               'alice', 'Alice', '', 'linked', 0, 0)`,
    ).run(blockId);
    db.prepare(
      `INSERT INTO comments_edit_proposals
         (comment_id, anchor_kind, source_snapshot, proposed_text, status, accepted_oid,
          branch_ref, base_oid, base_block_start, base_block_end)
       VALUES ('prop-1', NULL, 'alpha', 'beta', 'open', NULL,
               NULL, ?, NULL, NULL)`,
    ).run(originalBaseOid);

    // Move main on so any "use current main" behavior would be visible.
    await store.write(
      { uid: 'doc-1', format: 'markdown' },
      `${baseSource}\n\nadded paragraph`,
      { displayName: 'orig', clientId: 'orig' },
      'update',
    );
    const newMainOid = await store.mainOid({ uid: 'doc-1', format: 'markdown' });
    expect(newMainOid).not.toBe(originalBaseOid);

    const summary = await backfillProposalBranches(db, store);
    expect(summary.migrated).toBe(1);

    const row = db
      .prepare(
        `SELECT branch_ref, base_oid, base_block_start, base_block_end
           FROM comments_edit_proposals WHERE comment_id = 'prop-1'`,
      )
      .get() as {
      branch_ref: string;
      base_oid: string;
      base_block_start: number;
      base_block_end: number;
    };
    // base_oid must remain the original; range must be the alpha range
    // *in the original base*, not the current main.
    expect(row.branch_ref).toBe('refs/proposals/prop-1');
    expect(row.base_oid).toBe(originalBaseOid);
    expect(baseSource.slice(row.base_block_start, row.base_block_end)).toBe('alpha');

    db.close();
  });

  test('preserves stored base_oid + byte range when only branch_ref is missing', async () => {
    // Simulates a row from createThread where base reads succeeded but
    // createProposalBranch failed (e.g. transient git error). The row
    // has base_oid + base_block_{start,end} populated and branch_ref
    // null. Backfill must NOT re-base it onto current main; the
    // original base is the proposal's stable parent.
    const db = openDatabase(dbPath);
    reinstateLegacyColumns(db);
    db.prepare(
      `INSERT INTO documents (uid, repo_dir, format, default_theme, created_at, updated_at)
       VALUES ('doc-1', 'doc-1', 'markdown', 'default', 0, 0)`,
    ).run();
    const store = new GitStore(reposDir);
    await store.init();

    // Original main: contains "alpha".
    await store.write(
      { uid: 'doc-1', format: 'markdown' },
      '# Title\n\nalpha',
      { displayName: 'orig', clientId: 'orig' },
      'upload',
    );
    const originalBaseOid = await store.mainOid({ uid: 'doc-1', format: 'markdown' });

    // Insert the proposal row with the original base captured but no
    // branch_ref. Block id doesn't matter — the loop must not re-locate.
    db.prepare(
      `INSERT INTO comments
         (id, doc_uid, anchor_block_id, anchor_quote,
          author_client_id, author_display_name,
          body, link_status, created_at, updated_at)
       VALUES ('prop-1', 'doc-1', 'doesnt-matter', 'alpha',
               'alice', 'Alice', '', 'linked', 0, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO comments_edit_proposals
         (comment_id, anchor_kind, source_snapshot, proposed_text, status, accepted_oid,
          branch_ref, base_oid, base_block_start, base_block_end)
       VALUES ('prop-1', NULL, 'alpha', 'beta', 'open', NULL,
               NULL, ?, 10, 15)`,
    ).run(originalBaseOid);

    // Main moves on (someone else edited the doc) — the *current* main
    // is no longer the proposal's base.
    await store.write(
      { uid: 'doc-1', format: 'markdown' },
      '# Title\n\nalpha\n\nadded paragraph',
      { displayName: 'orig', clientId: 'orig' },
      'update',
    );
    const newMainOid = await store.mainOid({ uid: 'doc-1', format: 'markdown' });
    expect(newMainOid).not.toBe(originalBaseOid);

    const summary = await backfillProposalBranches(db, store);
    expect(summary.migrated).toBe(1);

    const row = db
      .prepare(
        `SELECT branch_ref, base_oid, base_block_start, base_block_end
           FROM comments_edit_proposals WHERE comment_id = 'prop-1'`,
      )
      .get() as {
      branch_ref: string;
      base_oid: string;
      base_block_start: number;
      base_block_end: number;
    };
    // branch_ref is now set, but the base_* values must be the original
    // ones we stored — NOT the new main tip.
    expect(row.branch_ref).toBe('refs/proposals/prop-1');
    expect(row.base_oid).toBe(originalBaseOid);
    expect(row.base_block_start).toBe(10);
    expect(row.base_block_end).toBe(15);

    db.close();
  });
});
