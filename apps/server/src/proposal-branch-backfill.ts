import type { Database } from 'bun:sqlite';
import {
  locateAllBlocks,
  locateAllBlocksAsciidoc,
  locateBlockSource,
} from '@marginalia/renderer';
import type { DocumentFormat } from './db.js';
import type { GitStore } from './git-store.js';

/**
 * One-shot boot migration: for every still-open proposal that predates
 * issue #25 (`branch_ref IS NULL`), retroactively build the
 * `refs/proposals/<pid>` ref so accept can use git's merge for conflict
 * detection. Idempotent — rows already carrying a `branch_ref` are
 * skipped, so it's safe to run on every boot.
 *
 * For each row we splice the stored `proposed_text` into the doc's
 * current main source at the anchor block's range and create a one-commit
 * branch parented at main's tip. If the anchor block can no longer be
 * located (the doc has moved on without anchor block id stability), we
 * leave the row alone — it'll fall through to the legacy splice path on
 * accept and surface as orphaned via the existing block-id check.
 */
export async function backfillProposalBranches(
  db: Database,
  store: GitStore,
): Promise<{ migrated: number; skipped: number }> {
  const rows = db
    .prepare(
      `SELECT cep.comment_id     AS id,
              c.doc_uid          AS doc_uid,
              c.anchor_block_id  AS anchor_block_id,
              cep.proposed_text  AS proposed_text,
              d.format           AS format
         FROM comments_edit_proposals cep
         JOIN comments c   ON c.id  = cep.comment_id
         JOIN documents d  ON d.uid = c.doc_uid
        WHERE cep.status = 'open'
          AND cep.branch_ref IS NULL
          AND c.deleted_at IS NULL
          AND c.anchor_block_id IS NOT NULL`,
    )
    .all() as Array<{
    id: string;
    doc_uid: string;
    anchor_block_id: string;
    proposed_text: string;
    format: DocumentFormat;
  }>;

  let migrated = 0;
  let skipped = 0;
  const update = db.prepare(
    `UPDATE comments_edit_proposals
        SET branch_ref = ?, base_oid = ?
      WHERE comment_id = ?`,
  );

  for (const row of rows) {
    const doc = { uid: row.doc_uid, format: row.format };
    const source = safeRead(store, doc);
    if (source === null) {
      skipped += 1;
      continue;
    }
    const range =
      doc.format === 'asciidoc'
        ? (locateAllBlocksAsciidoc(source).get(row.anchor_block_id) ?? null)
        : locateBlockSource(source, row.anchor_block_id) ??
          locateAllBlocks(source).get(row.anchor_block_id) ??
          null;
    if (!range) {
      skipped += 1;
      continue;
    }
    const nextSource =
      source.slice(0, range.start) + row.proposed_text + source.slice(range.end);

    let baseOid: string;
    try {
      baseOid = await store.mainOid(doc);
    } catch {
      skipped += 1;
      continue;
    }
    const identity = { displayName: 'marginalia', clientId: 'marginalia' };
    try {
      const { refName } = await store.createProposalBranch(
        doc,
        baseOid,
        row.id,
        nextSource,
        identity,
      );
      update.run(refName, baseOid, row.id);
      migrated += 1;
    } catch (err) {
      console.warn(
        `[marginalia] proposal-branch backfill failed for ${row.id} (${row.doc_uid}):`,
        err,
      );
      skipped += 1;
    }
  }

  return { migrated, skipped };
}

function safeRead(store: GitStore, doc: { uid: string; format: DocumentFormat }): string | null {
  try {
    return store.read(doc);
  } catch {
    return null;
  }
}
