import type { Database } from 'bun:sqlite';
import { locateAllBlocks, locateAllBlocksAsciidoc } from '@marginalia/renderer';
import type { DocumentFormat } from './db.js';
import type { GitStore } from './git-store.js';

/**
 * Build `refs/proposals/<pid>` for every open proposal whose row is missing
 * a `branch_ref`. Idempotent. `docUid`, when set, scopes the scan to one
 * document (used by the import path to skip scanning the whole DB).
 *
 * Rows whose anchor block can't be located in current source are left
 * alone; the existing block-id orphan check surfaces them at accept time.
 */
export async function backfillProposalBranches(
  db: Database,
  store: GitStore,
  docUid?: string,
): Promise<{ migrated: number; skipped: number }> {
  const rows = (
    docUid === undefined
      ? db.prepare(
          `SELECT cep.comment_id          AS id,
                  c.doc_uid               AS doc_uid,
                  c.anchor_block_id       AS anchor_block_id,
                  c.author_client_id      AS author_client_id,
                  c.author_display_name   AS author_display_name,
                  cep.proposed_text       AS proposed_text,
                  d.format                AS format
             FROM comments_edit_proposals cep
             JOIN comments c   ON c.id  = cep.comment_id
             JOIN documents d  ON d.uid = c.doc_uid
            WHERE cep.status = 'open'
              AND cep.branch_ref IS NULL
              AND c.deleted_at IS NULL
              AND c.anchor_block_id IS NOT NULL`,
        ).all()
      : db
          .prepare(
            `SELECT cep.comment_id          AS id,
                    c.doc_uid               AS doc_uid,
                    c.anchor_block_id       AS anchor_block_id,
                    c.author_client_id      AS author_client_id,
                    c.author_display_name   AS author_display_name,
                    cep.proposed_text       AS proposed_text,
                    d.format                AS format
               FROM comments_edit_proposals cep
               JOIN comments c   ON c.id  = cep.comment_id
               JOIN documents d  ON d.uid = c.doc_uid
              WHERE cep.status = 'open'
                AND cep.branch_ref IS NULL
                AND c.deleted_at IS NULL
                AND c.anchor_block_id IS NOT NULL
                AND c.doc_uid = ?`,
          )
          .all(docUid)
  ) as Array<{
    id: string;
    doc_uid: string;
    anchor_block_id: string;
    author_client_id: string;
    author_display_name: string;
    proposed_text: string;
    format: DocumentFormat;
  }>;

  let migrated = 0;
  let skipped = 0;
  const update = db.prepare(
    `UPDATE comments_edit_proposals
        SET branch_ref = ?, base_oid = ?, base_block_start = ?, base_block_end = ?
      WHERE comment_id = ?`,
  );

  // Wrap the loop in a transaction — autocommit per-row would pay
  // SQLite's BEGIN/COMMIT cost for every migrated proposal, which adds
  // up on large repositories.
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      const doc = { uid: row.doc_uid, format: row.format };
      let baseOid: string;
      let source: string;
      try {
        // Resolve baseOid first, then read source AT that oid — keeps the
        // splice and the eventual proposal-branch parent on the same tree
        // even if main advances during the loop.
        baseOid = await store.mainOid(doc);
        source = await store.readAt(doc, baseOid);
      } catch {
        skipped += 1;
        continue;
      }
      const blocks =
        doc.format === 'asciidoc' ? locateAllBlocksAsciidoc(source) : locateAllBlocks(source);
      const range = blocks.get(row.anchor_block_id) ?? null;
      if (!range) {
        skipped += 1;
        continue;
      }
      const nextSource =
        source.slice(0, range.start) + row.proposed_text + source.slice(range.end);

      try {
        const { refName } = await store.createProposalBranch(
          doc,
          baseOid,
          row.id,
          nextSource,
          {
            clientId: row.author_client_id,
            displayName: row.author_display_name,
          },
        );
        update.run(refName, baseOid, range.start, range.end, row.id);
        migrated += 1;
      } catch (err) {
        console.warn(
          `[marginalia] proposal-branch backfill failed for ${row.id} (${row.doc_uid}):`,
          err,
        );
        skipped += 1;
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return { migrated, skipped };
}

