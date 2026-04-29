import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as git from 'isomorphic-git';
import { locateAllBlocks } from '@marginalia/renderer';
import { openDatabase } from '../src/db.js';
import { GitStore } from '../src/git-store.js';
import { backfillProposalBranches } from '../src/proposal-branch-backfill.js';

/**
 * Boot-time backfill: legacy pending proposals (created before #25, no
 * branch_ref) get a `refs/proposals/<pid>` branch built retroactively
 * from their stored `proposed_text`, so accept can use git.merge.
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
    const tip = await store.readProposalTip(
      { uid: 'doc-1', format: 'markdown' },
      'prop-1',
    );
    expect(tip).toBe('# Title\n\nbeta');

    // base_oid must equal main's tip at backfill time.
    const mainOid = await git.resolveRef({
      fs,
      dir: store.repoDir('doc-1'),
      ref: 'main',
    });
    expect(row.base_oid).toBe(mainOid);

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
      .prepare(
        `SELECT branch_ref FROM comments_edit_proposals WHERE comment_id = 'prop-accepted'`,
      )
      .get() as { branch_ref: string | null };
    expect(row.branch_ref).toBeNull();

    db.close();
  });
});
