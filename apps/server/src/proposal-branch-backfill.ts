import type { Database } from 'bun:sqlite';
import {
  locateAllBlocks,
  locateAllBlocksAsciidoc,
  locateBlockSource,
} from '@marginalia/renderer';
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
        ).all()
      : db
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
                AND c.anchor_block_id IS NOT NULL
                AND c.doc_uid = ?`,
          )
          .all(docUid)
  ) as Array<{
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
        SET branch_ref = ?, base_oid = ?, base_block_start = ?, base_block_end = ?
      WHERE comment_id = ?`,
  );

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

    const identity = { displayName: 'marginalia', clientId: 'marginalia' };
    try {
      const { refName } = await store.createProposalBranch(
        doc,
        baseOid,
        row.id,
        nextSource,
        identity,
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

  return { migrated, skipped };
}

