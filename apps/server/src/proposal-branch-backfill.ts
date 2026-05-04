import type { Database } from 'bun:sqlite';
import { locateAllBlocks, locateAllBlocksAsciidoc } from '@marginalia/renderer';
import { columnExists, type DocumentFormat } from './db.js';
import type { GitStore } from './git-store.js';

/**
 * Build `refs/proposals/<pid>` for every open or rejected proposal whose
 * row is missing a `branch_ref`. Rejected rows are included because the
 * Phase-2 reject-deletes-branch behavior left them without a ref but
 * with `proposed_text` still in the column — last chance to capture
 * before `dropLegacyProposalColumns`. Idempotent. `docUid`, when set,
 * scopes the scan to one document.
 *
 * Reads `proposed_text` from the legacy column to splice the branch tip,
 * so this is a no-op once `dropLegacyProposalColumns` has run — fresh
 * databases never had the column, and post-migration databases have all
 * applicable rows already carrying a `branch_ref`.
 */
export async function backfillProposalBranches(
  db: Database,
  store: GitStore,
  docUid?: string,
): Promise<{ migrated: number; skipped: number }> {
  if (!columnExists(db, 'comments_edit_proposals', 'proposed_text')) {
    return { migrated: 0, skipped: 0 };
  }
  const rows = (
    docUid === undefined
      ? db.prepare(
          `SELECT cep.comment_id          AS id,
                  c.doc_uid               AS doc_uid,
                  c.anchor_block_id       AS anchor_block_id,
                  c.author_client_id      AS author_client_id,
                  c.author_display_name   AS author_display_name,
                  c.body                  AS body,
                  cep.proposed_text       AS proposed_text,
                  cep.base_oid            AS base_oid,
                  cep.base_block_start    AS base_block_start,
                  cep.base_block_end      AS base_block_end,
                  d.format                AS format
             FROM comments_edit_proposals cep
             JOIN comments c   ON c.id  = cep.comment_id
             JOIN documents d  ON d.uid = c.doc_uid
            WHERE cep.status IN ('open', 'rejected')
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
                    cep.base_oid            AS base_oid,
                    cep.base_block_start    AS base_block_start,
                    cep.base_block_end      AS base_block_end,
                    d.format                AS format
               FROM comments_edit_proposals cep
               JOIN comments c   ON c.id  = cep.comment_id
               JOIN documents d  ON d.uid = c.doc_uid
              WHERE cep.status IN ('open', 'rejected')
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
    body: string;
    proposed_text: string;
    base_oid: string | null;
    base_block_start: number | null;
    base_block_end: number | null;
    format: DocumentFormat;
  }>;

  let migrated = 0;
  let skipped = 0;

  // Phase 1: do all git work outside any DB transaction. Holding the
  // SQLite write lock across filesystem / git I/O would block unrelated
  // requests on the import path, where this runs inside a request
  // handler.
  const persist: Array<{
    id: string;
    refName: string;
    baseOid: string;
    rangeStart: number;
    rangeEnd: number;
  }> = [];

  for (const row of rows) {
    const doc = { uid: row.doc_uid, format: row.format };

    // base_oid alone is authoritative for the proposal's base — the
    // original base must not silently re-anchor onto current main. If
    // it's set but the splice range isn't (e.g. a post-#25 createThread
    // where base reads succeeded but `locateBlockRange` returned null),
    // recompute the range from the source at the stored baseOid, not
    // from current main.
    let baseOid: string;
    let baseSource: string;
    try {
      if (row.base_oid !== null) {
        baseOid = row.base_oid;
      } else {
        baseOid = await store.mainOid(doc);
      }
      baseSource = await store.readAt(doc, baseOid);
    } catch {
      skipped += 1;
      continue;
    }

    let rangeStart: number;
    let rangeEnd: number;
    if (row.base_block_start !== null && row.base_block_end !== null) {
      rangeStart = row.base_block_start;
      rangeEnd = row.base_block_end;
    } else {
      const blocks =
        doc.format === 'asciidoc'
          ? locateAllBlocksAsciidoc(baseSource)
          : locateAllBlocks(baseSource);
      const range = blocks.get(row.anchor_block_id);
      if (!range) {
        skipped += 1;
        continue;
      }
      rangeStart = range.start;
      rangeEnd = range.end;
    }
    const nextSource =
      baseSource.slice(0, rangeStart) + row.proposed_text + baseSource.slice(rangeEnd);

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
        row.body,
      );
      persist.push({ id: row.id, refName, baseOid, rangeStart, rangeEnd });
    } catch (err) {
      console.warn(
        `[marginalia] proposal-branch backfill failed for ${row.id} (${row.doc_uid}):`,
        err,
      );
      skipped += 1;
    }
  }

  // Phase 2: persist all results in one short transaction. The
  // `branch_ref IS NULL` guard makes the UPDATE a no-op if a concurrent
  // path set the ref between our SELECT and now, so we never clobber a
  // newer branch.
  if (persist.length > 0) {
    // COALESCE preserves any existing base metadata defensively: the
    // loop already reuses stored values when present, but if a
    // concurrent path set them between SELECT and UPDATE we must not
    // overwrite them.
    const update = db.prepare(
      `UPDATE comments_edit_proposals
          SET branch_ref = ?,
              base_oid = COALESCE(base_oid, ?),
              base_block_start = COALESCE(base_block_start, ?),
              base_block_end = COALESCE(base_block_end, ?)
        WHERE comment_id = ? AND branch_ref IS NULL`,
    );
    db.exec('BEGIN');
    try {
      for (const p of persist) {
        update.run(p.refName, p.baseOid, p.rangeStart, p.rangeEnd, p.id);
      }
      db.exec('COMMIT');
      migrated = persist.length;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  return { migrated, skipped };
}

