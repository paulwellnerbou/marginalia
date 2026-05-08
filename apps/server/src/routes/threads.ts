import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import type { BlockInfo, BlockSourceRange } from '@marginalia/renderer';
import { canMergeMultiBlock, renderDocument } from '@marginalia/renderer';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { reanchor } from '../anchoring.js';
import {
  authorize,
  canComment,
  canEdit,
  canPropose,
  type Identity,
  INVITE_SESSION_COOKIE,
  parseCookie,
  SESSION_COOKIE,
} from '../auth.js';
import { mapWithConcurrency } from '../concurrency.js';
import type {
  CommentLinkStatus,
  CommentReactionRow,
  CommentRow,
  DocumentRow,
  EditProposalStatus,
  EditProposalThreadRow,
} from '../db.js';
import type { GitStore } from '../git-store.js';
import {
  consumePendingMentions,
  listMentionCandidates,
  storeMentionsForComment,
} from '../mentions.js';
import { toWire as toLegacyCommentWire } from './comments.js';
import type { AppDeps } from './documents.js';
import {
  findBlockBySourceSpan,
  loadProposalRow,
  locateAnchorRange,
  locateDocumentBlocks,
  readProposalContent,
  readProposalFullContent,
  reanchorProposals,
  reopenAcceptedProposal,
  toWire as toProposalWire,
} from './edit-proposals.js';

interface ThreadRow extends CommentRow {
  proposal_status: EditProposalStatus | null;
  accepted_oid: string | null;
  branch_ref: string | null;
  base_oid: string | null;
  base_block_start: number | null;
  base_block_end: number | null;
  is_whole_document: number | null;
  decided_at: number | null;
  decided_by_name: string | null;
}

type ThreadState = 'open' | 'resolved';
type ResolutionKind = 'resolve' | 'accept' | 'reject';
type RespondAction = 'resolve' | 'accept' | 'reject' | 'reopen';

interface PreparedThreadWorkflow {
  oid: string;
  applyDb: () => EditProposalThreadRow[];
}

const DEFAULT_PROPOSAL_BODY = 'Proposed change';

const THREAD_SELECT = `
  SELECT
    c.*,
    cep.status AS proposal_status,
    cep.accepted_oid,
    cep.branch_ref,
    cep.base_oid,
    cep.base_block_start,
    cep.base_block_end,
    cep.is_whole_document,
    c.resolved_at AS decided_at,
    c.resolved_by_name AS decided_by_name
  FROM comments c
  LEFT JOIN comments_edit_proposals cep ON cep.comment_id = c.id
`;

/**
 * Unified thread endpoints.
 *
 * Root threads are the public API surface for comments and edit proposals.
 * Replies stay as comment rows underneath the root, but creation, workflow,
 * and node-level mutations now go through `/threads`.
 */
export function threadsRouter(deps: AppDeps): Hono {
  const r = new Hono();

  r.get('/:uid/threads', async (c) => listThreads(c, deps));
  r.post('/:uid/threads', async (c) => createThread(c, deps));
  r.get('/:uid/threads/:tid/diff', async (c) => getThreadDiff(c, deps));
  r.post('/:uid/threads/:tid/repair', async (c) => repairThreadAnchor(c, deps));
  r.patch('/:uid/threads/:tid', async (c) => editThreadRoot(c, deps));
  r.delete('/:uid/threads/:tid', async (c) => deleteThread(c, deps));
  r.patch('/:uid/threads/:tid/comments/:cid', async (c) => editThreadReply(c, deps));
  r.delete('/:uid/threads/:tid/comments/:cid', async (c) => deleteThreadReply(c, deps));
  r.post('/:uid/threads/:tid/respond', async (c) => respondToThread(c, deps));
  r.post('/:uid/threads/:tid/comments/:cid/reactions', async (c) => toggleCommentReaction(c, deps));

  return r;
}

/**
 * `GET /:uid/threads`
 *
 * Returns every root thread with its replies, optional proposal payload, and
 * server-computed capabilities.
 */
async function listThreads(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const roots = db
    .prepare(
      `${THREAD_SELECT}
       WHERE c.doc_uid = ?
         AND c.parent_id IS NULL
         AND c.parent_proposal_id IS NULL
         AND c.deleted_at IS NULL
       ORDER BY c.created_at ASC`,
    )
    .all(doc.uid) as ThreadRow[];
  const replies = loadReplies(db, doc.uid, null);
  const repliesByThread = groupRepliesByThread(replies);
  const reopenableAccepted = await loadReopenableAcceptedThreadIds(doc, deps, roots);

  // Batch-load reactions for every comment node on the page in a single
  // query. Without this, toThreadWire's per-thread fallback turns into
  // N+1 (one reactions query per root) and dominates the request as
  // thread counts grow.
  const viewerId = decision.identity?.clientId ?? null;
  const reactionsByComment = loadCommentReactionsWire(
    db,
    doc.uid,
    [...roots.map((r) => r.id), ...replies.map((r) => r.id)],
    viewerId,
  );

  const threads = await mapWithConcurrency(roots, 4, (root) =>
    toThreadWire(
      db,
      store,
      doc,
      root,
      repliesByThread.get(root.id) ?? [],
      decision,
      reopenableAccepted,
      reactionsByComment,
    ),
  );
  return c.json({
    threads,
    mention_candidates: listMentionCandidates(db, doc.uid),
    pending_mentions:
      c.req.query('consume_mentions') === 'false'
        ? []
        : consumePendingMentions(db, doc.uid, decision.identity?.displayName ?? null),
  });
}

/**
 * `POST /:uid/threads`
 *
 * Creates either a plain comment thread or a proposal thread rooted at one
 * anchored comment row.
 */
async function createThread(c: Context, deps: AppDeps) {
  const { db, store, realtime } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  const identity = decision.identity;

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  const parsedAnchor = asAnchor(body.anchor);
  if (!parsedAnchor.ok) return c.json({ error: parsedAnchor.error }, 400);
  const anchor = parsedAnchor.anchor;

  const rootBody = parseOptionalBody(body.body);
  if (!rootBody.ok) return c.json({ error: 'invalid-body' }, 400);
  const parsedProposal = asProposal(body.proposal);
  if (!parsedProposal.ok) return c.json({ error: parsedProposal.error }, 400);
  const proposal = parsedProposal.proposal;
  const storedRootBody = proposal ? (rootBody.body ?? DEFAULT_PROPOSAL_BODY) : rootBody.body;

  if (!proposal) {
    if (!canComment(decision.role)) return c.json({ error: 'forbidden' }, 403);
    if (!rootBody.body) return c.json({ error: 'body-required' }, 400);
  } else {
    if (!canPropose(decision.role)) return c.json({ error: 'forbidden' }, 403);
  }

  const id = newCommentId();

  let blockRange: BlockSourceRange | null = null;
  let branchRef: string | null = null;
  let baseOid: string | null = null;
  if (proposal) {
    // Read source AT baseOid — reading the working tree separately
    // from `mainOid()` would race with concurrent accepts and parent
    // the branch on a different commit than the spliced content.
    let currentSource: string;
    try {
      baseOid = await store.mainOid(doc);
      currentSource = await store.readAt(doc, baseOid);
    } catch (err) {
      console.warn(`[marginalia] reading base for proposal ${id} (${doc.uid}) failed:`, err);
      return c.json({ error: 'proposal-storage-unavailable' }, 503);
    }
    if (proposal.wholeDocument) {
      blockRange = { start: 0, end: currentSource.length, kind: 'multi', text: '' };
    } else {
      blockRange = locateAnchorRange(doc, currentSource, anchor.blockId, anchor.endBlockId);
      if (!blockRange) return c.json({ error: 'anchor-block-not-found' }, 400);
    }
    const nextSource =
      currentSource.slice(0, blockRange.start) +
      proposal.proposedText +
      currentSource.slice(blockRange.end);
    try {
      const branch = await store.createProposalBranch(
        doc,
        baseOid as string,
        id,
        nextSource,
        identity,
        storedRootBody,
      );
      branchRef = branch.refName;
    } catch (err) {
      console.warn(`[marginalia] proposal-branch creation failed for ${id} (${doc.uid}):`, err);
      return c.json({ error: 'proposal-storage-unavailable' }, 503);
    }
  }

  const now = Date.now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO comments
         (id, doc_uid, parent_id, parent_proposal_id,
          anchor_block_id, anchor_end_block_id,
          anchor_quote, anchor_prefix, anchor_suffix,
          anchor_start_offset, anchor_end_offset,
          anchor_heading_path, anchor_section_index, anchor_section_index_path,
          author_client_id, author_display_name,
          body, link_status, resolved_at, resolved_by_name,
          created_at, updated_at, deleted_at)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', NULL, NULL, ?, ?, NULL)`,
    ).run(
      id,
      doc.uid,
      anchor.blockId,
      anchor.endBlockId,
      anchor.quote,
      anchor.prefix,
      anchor.suffix,
      anchor.startOffset,
      anchor.endOffset,
      anchor.headingPath ? JSON.stringify(anchor.headingPath) : null,
      anchor.sectionIndex,
      anchor.sectionIndexPath ? JSON.stringify(anchor.sectionIndexPath) : null,
      identity.clientId,
      identity.displayName,
      storedRootBody,
      now,
      now,
    );

    if (proposal) {
      db.prepare(
        `INSERT INTO comments_edit_proposals
           (comment_id, status, accepted_oid,
            branch_ref, base_oid, base_block_start, base_block_end,
            is_whole_document)
         VALUES (?, 'open', NULL, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        branchRef,
        baseOid,
        blockRange?.start ?? null,
        blockRange?.end ?? null,
        proposal.wholeDocument ? 1 : 0,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (branchRef) await store.deleteProposalBranch(doc, id).catch(() => undefined);
    throw err;
  }

  const root = loadThreadRow(db, id, doc.uid);
  if (!root) return c.json({ error: 'not-found' }, 404);
  const thread = await toThreadWire(db, store, doc, root, [], decision, new Set<string>());
  const rootComment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow;
  const mentionTargets = storeMentionsForComment(
    db,
    doc.uid,
    id,
    rootComment.body,
    rootComment.author_display_name,
  );

  if (proposal && isProposalRow(root)) {
    realtime.broadcast(
      doc.uid,
      {
        type: 'edit_proposal.created',
        edit_proposal: toProposalWire(root),
      },
      identity.clientId,
    );
  } else {
    realtime.broadcast(
      doc.uid,
      { type: 'comment.created', comment: toLegacyCommentWire(rootComment) },
      identity.clientId,
    );
  }
  if (mentionTargets.length > 0) {
    realtime.broadcastToDisplayNames(
      doc.uid,
      mentionTargets,
      { type: 'mention.created', comment: toLegacyCommentWire(rootComment) },
      identity.clientId,
    );
  }

  return c.json({ thread }, 201);
}

/**
 * `GET /:uid/threads/:tid/diff` — before/after diff for a proposal thread.
 *
 * `mergeable` is computed via a `git merge --dry-run` under the per-doc
 * lock, which serializes with every repo write for this document. To
 * avoid loading that path on every viewer, `mergeable` is `null` in
 * any of:
 *
 * - the row is accepted / rejected (the field is meaningful only for
 *   open proposals)
 * - the proposal is not currently acceptable: `link_status='orphaned'`,
 *   or a non-whole-document proposal whose `anchor_block_id` has been
 *   nulled out. Accept would refuse these with `proposal-orphaned`, so
 *   surfacing a `'clean'` status would mislead the UI
 * - the caller has read-only access — they can't accept, so they don't
 *   need it. Propose-capable callers can opt in explicitly with
 *   `?mergeable=1`; readers can't, otherwise a reader could force the
 *   expensive dry-run by spamming the query parameter
 *
 * Editors with an acceptable, open proposal get a non-null status by
 * default, no opt-in required.
 */
async function getThreadDiff(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const tid = c.req.param('tid');
  if (!tid) return c.json({ error: 'not-found' }, 404);
  const proposal = loadProposalRow(db, tid, doc.uid);
  if (!proposal) return c.json({ error: 'proposal-required' }, 400);

  const diff = await resolveProposalDiff(doc, proposal, deps);
  if (!diff) return c.json({ error: 'proposal-diff-unavailable' }, 410);

  let mergeable: 'clean' | 'conflict' | 'stale' | null = null;
  // Skip the dry-run merge when the proposal can't be accepted regardless
  // of the result (orphaned anchor, missing block id) — running it would
  // burn the per-doc lock and could surface a misleading 'clean' for a
  // proposal that the accept path would refuse with proposal-orphaned.
  // Whole-document proposals don't depend on `anchor_block_id`.
  const isAcceptable =
    proposal.proposal_status === 'open' &&
    isProposalAnchorAcceptable(proposal) &&
    (proposal.is_whole_document === 1 || proposal.anchor_block_id !== null);
  const wantMergeable =
    isAcceptable &&
    (canEdit(decision.role) || (c.req.query('mergeable') === '1' && canPropose(decision.role)));
  if (wantMergeable) {
    const status = await deps.store.proposalMergeStatus(doc, proposal.id);
    // `merged` and `absent` both collapse to `stale` — the proposal
    // can no longer be applied as-is and needs a rebase.
    mergeable = status === 'clean' ? 'clean' : status === 'conflict' ? 'conflict' : 'stale';
  }
  return c.json({ ...diff, mergeable });
}

/**
 * Recover the {before, after} pair for a proposal from git: `before` is
 * the anchor block at `base_oid`, `after` is the corresponding range at
 * the proposal branch tip. Returns null when the row lacks the columns
 * needed to address the splice range (legacy pre-#25 rows that escaped
 * boot backfill, or branch creation failed at create time without
 * recovery).
 */
async function resolveProposalDiff(
  doc: DocumentRow,
  proposal: EditProposalThreadRow,
  deps: AppDeps,
): Promise<{
  before: string;
  after: string;
  original: { before: string; after: string } | null;
} | null> {
  const content = await readProposalContent(deps.store, doc, proposal);
  if (!content) return null;
  const original = await readProposalFullContent(deps.store, doc, proposal);
  return { before: content.source_snapshot, after: content.proposed_text, original };
}

async function repairThreadAnchor(c: Context, deps: AppDeps) {
  const { db, realtime, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  const identity = decision.identity;
  if (!canPropose(decision.role)) return c.json({ error: 'forbidden' }, 403);

  const tid = c.req.param('tid');
  if (!tid) return c.json({ error: 'not-found' }, 404);
  const row = loadProposalRow(db, tid, doc.uid);
  if (!row) return c.json({ error: 'proposal-required' }, 400);
  if (row.proposal_status !== 'open') return c.json({ error: 'not-open' }, 400);
  if (row.is_whole_document === 1) return c.json({ error: 'proposal-repair-unavailable' }, 409);
  if (row.link_status !== 'orphaned') return c.json({ error: 'not-orphaned' }, 400);
  if (row.branch_ref !== `refs/proposals/${row.id}` || !row.base_oid) {
    return c.json({ error: 'proposal-repair-unavailable' }, 409);
  }

  return store.withProposalRepair(doc, row.id, identity, async ({ preview, rewrite }) => {
    let anchor: RepairAnchor | null = null;
    let linkStatus: CommentLinkStatus | null = null;
    let repairedBranch: { baseOid: string; baseBlockStart: number; baseBlockEnd: number } | null =
      null;
    if (preview.ok) {
      const changed = changedSpan(preview.before, preview.after);
      if (!changed) return c.json({ error: 'proposal-repair-unavailable' }, 409);
      if (!rewrite?.ok) return c.json({ error: 'proposal-repair-unavailable' }, 409);
      repairedBranch = {
        baseOid: rewrite.baseOid,
        baseBlockStart: changed.beforeStart,
        baseBlockEnd: changed.beforeEnd,
      };

      const rendered = await renderDocument(preview.before, doc.format);
      const blocks = locateDocumentBlocks(doc, preview.before);
      anchor = locateRepairAnchor(
        blocks,
        rendered.blocks,
        preview.before,
        changed.beforeStart,
        changed.beforeEnd,
        doc.format,
      );
      linkStatus = anchor?.linkStatus ?? null;
    } else if (preview.reason === 'conflict') {
      anchor = await locateConflictRepairAnchor(doc, row, store);
      linkStatus = anchor ? 'conflict' : null;
    } else {
      const code =
        preview.reason === 'absent' ? 'proposal-repair-unavailable' : 'proposal-already-merged';
      return c.json({ error: code }, 409);
    }
    if (!anchor || !linkStatus) {
      return c.json(
        { error: preview.ok ? 'proposal-repair-unavailable' : 'proposal-conflict' },
        409,
      );
    }

    const now = Date.now();
    if (repairedBranch) {
      db.prepare(
        `UPDATE comments_edit_proposals
            SET base_oid = ?,
                base_block_start = ?,
                base_block_end = ?
          WHERE comment_id = ?`,
      ).run(
        repairedBranch.baseOid,
        repairedBranch.baseBlockStart,
        repairedBranch.baseBlockEnd,
        row.id,
      );
    }
    db.prepare(
      `UPDATE comments
          SET anchor_block_id = ?,
              anchor_end_block_id = ?,
              anchor_quote = ?,
              anchor_prefix = '',
              anchor_suffix = '',
              anchor_start_offset = NULL,
              anchor_end_offset = NULL,
              anchor_heading_path = ?,
              anchor_section_index = ?,
              anchor_section_index_path = ?,
              link_status = ?,
              updated_at = ?
        WHERE id = ? AND doc_uid = ?`,
    ).run(
      anchor.block.id,
      anchor.endBlock?.id ?? null,
      anchor.quote,
      JSON.stringify(anchor.block.headingPath),
      anchor.block.sectionIndex,
      JSON.stringify(anchor.block.sectionIndexPath),
      linkStatus,
      now,
      row.id,
      doc.uid,
    );

    const updated = loadThreadRow(db, row.id, doc.uid);
    if (!updated) return c.json({ error: 'not-found' }, 404);
    const replies = loadReplies(db, doc.uid, row.id);
    const reopenableAccepted = await loadReopenableAcceptedThreadIds(doc, deps, [updated]);

    if (isProposalRow(updated)) {
      realtime.broadcast(
        doc.uid,
        { type: 'edit_proposal.updated', edit_proposal: toProposalWire(updated) },
        identity.clientId,
      );
    }

    return c.json({
      thread: await toThreadWire(db, store, doc, updated, replies, decision, reopenableAccepted),
    });
  });
}

/**
 * `PATCH /:uid/threads/:tid`
 *
 * Edits only the root comment body of a thread. Proposal roots use this for
 * rationale edits; plain threads use it for the root comment text.
 */
async function editThreadRoot(c: Context, deps: AppDeps) {
  const { db, realtime, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);

  const tid = c.req.param('tid');
  if (!tid) return c.json({ error: 'not-found' }, 404);
  const row = loadThreadRow(db, tid, doc.uid);
  if (!row) return c.json({ error: 'not-found' }, 404);
  if (row.author_client_id !== decision.identity.clientId)
    return c.json({ error: 'forbidden' }, 403);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  const next = parseThreadRootBody(body.body, isProposalRow(row));
  if (!next.ok) return c.json({ error: 'invalid-body' }, 400);
  if (next.body === undefined) return c.json({ error: 'body-required' }, 400);

  const now = Date.now();
  db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(next.body, now, tid);

  const updated = loadThreadRow(db, tid, doc.uid);
  if (!updated) return c.json({ error: 'not-found' }, 404);
  const mentionTargets = storeMentionsForComment(
    db,
    doc.uid,
    updated.id,
    updated.body,
    updated.author_display_name,
  );

  if (isProposalRow(updated)) {
    realtime.broadcast(
      doc.uid,
      {
        type: 'edit_proposal.updated',
        edit_proposal: toProposalWire(updated),
      },
      decision.identity.clientId,
    );
  } else {
    realtime.broadcast(
      doc.uid,
      { type: 'comment.updated', comment: toLegacyCommentWire(updated) },
      decision.identity.clientId,
    );
  }
  if (mentionTargets.length > 0) {
    realtime.broadcastToDisplayNames(
      doc.uid,
      mentionTargets,
      { type: 'mention.created', comment: toLegacyCommentWire(updated) },
      decision.identity.clientId,
    );
  }

  const replies = loadReplies(db, doc.uid, tid);
  const reopenableAccepted = await loadReopenableAcceptedThreadIds(doc, deps, [updated]);
  return c.json({
    thread: await toThreadWire(db, store, doc, updated, replies, decision, reopenableAccepted),
  });
}

/**
 * `DELETE /:uid/threads/:tid`
 *
 * Soft-deletes a root thread. Accepted proposal threads remain admin-delete
 * only to preserve audit history.
 */
async function deleteThread(c: Context, deps: AppDeps) {
  const { db, realtime } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);

  const tid = c.req.param('tid');
  if (!tid) return c.json({ error: 'not-found' }, 404);
  const row = loadThreadRow(db, tid, doc.uid);
  if (!row) return c.json({ error: 'not-found' }, 404);

  const isAuthor = row.author_client_id === decision.identity.clientId;
  const isAdmin = decision.role === 'admin';
  if (!isAuthor && !isAdmin) return c.json({ error: 'forbidden' }, 403);
  if (row.proposal_status === 'accepted' && !isAdmin) {
    return c.json({ error: 'forbidden-accepted' }, 403);
  }

  const now = Date.now();
  db.prepare(
    `UPDATE comments
        SET deleted_at = ?, updated_at = ?
      WHERE doc_uid = ?
        AND deleted_at IS NULL
        AND (id = ? OR parent_id = ? OR parent_proposal_id = ?)`,
  ).run(now, now, doc.uid, tid, tid, tid);
  if (isProposalRow(row)) {
    if (row.branch_ref) {
      await deps.store.deleteProposalBranch(doc, row.id).catch(() => undefined);
    }
    realtime.broadcast(
      doc.uid,
      { type: 'edit_proposal.deleted', edit_proposal_id: tid },
      decision.identity.clientId,
    );
  } else {
    realtime.broadcast(
      doc.uid,
      { type: 'comment.deleted', comment_id: tid },
      decision.identity.clientId,
    );
  }
  return c.body(null, 204);
}

/**
 * `PATCH /:uid/threads/:tid/comments/:cid`
 *
 * Edits one reply node under a thread. Root comments use `PATCH /:uid/threads/:tid`.
 */
async function editThreadReply(c: Context, deps: AppDeps) {
  const { db, realtime, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);

  const tid = c.req.param('tid');
  if (!tid) return c.json({ error: 'not-found' }, 404);
  const thread = loadThreadRow(db, tid, doc.uid);
  if (!thread) return c.json({ error: 'not-found' }, 404);

  const cid = c.req.param('cid');
  if (!cid) return c.json({ error: 'not-found' }, 404);
  const reply = loadReplyRow(db, doc.uid, tid, cid);
  if (!reply) return c.json({ error: 'not-found' }, 404);
  if (reply.author_client_id !== decision.identity.clientId) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  const next = parseOptionalBody(body.body);
  if (!next.ok) return c.json({ error: 'invalid-body' }, 400);
  if (!next.body) return c.json({ error: 'body-required' }, 400);

  const now = Date.now();
  db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(next.body, now, cid);

  const updatedReply = loadReplyRow(db, doc.uid, tid, cid);
  if (!updatedReply) return c.json({ error: 'not-found' }, 404);
  const mentionTargets = storeMentionsForComment(
    db,
    doc.uid,
    updatedReply.id,
    updatedReply.body,
    updatedReply.author_display_name,
  );

  realtime.broadcast(
    doc.uid,
    { type: 'comment.updated', comment: toLegacyCommentWire(updatedReply) },
    decision.identity.clientId,
  );
  if (mentionTargets.length > 0) {
    realtime.broadcastToDisplayNames(
      doc.uid,
      mentionTargets,
      { type: 'mention.created', comment: toLegacyCommentWire(updatedReply) },
      decision.identity.clientId,
    );
  }

  const updatedThread = loadThreadRow(db, tid, doc.uid);
  if (!updatedThread) return c.json({ error: 'not-found' }, 404);
  const replies = loadReplies(db, doc.uid, tid);
  const reopenableAccepted = await loadReopenableAcceptedThreadIds(doc, deps, [updatedThread]);
  return c.json({
    thread: await toThreadWire(
      db,
      store,
      doc,
      updatedThread,
      replies,
      decision,
      reopenableAccepted,
    ),
  });
}

/**
 * `DELETE /:uid/threads/:tid/comments/:cid`
 *
 * Soft-deletes one reply node under a thread. Allowed for the reply author or
 * a document admin.
 */
async function deleteThreadReply(c: Context, deps: AppDeps) {
  const { db, realtime } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);

  const tid = c.req.param('tid');
  if (!tid) return c.json({ error: 'not-found' }, 404);
  const thread = loadThreadRow(db, tid, doc.uid);
  if (!thread) return c.json({ error: 'not-found' }, 404);

  const cid = c.req.param('cid');
  if (!cid) return c.json({ error: 'not-found' }, 404);
  const reply = loadReplyRow(db, doc.uid, tid, cid);
  if (!reply) return c.json({ error: 'not-found' }, 404);

  const isAuthor = reply.author_client_id === decision.identity.clientId;
  const isAdmin = decision.role === 'admin';
  if (!isAuthor && !isAdmin) return c.json({ error: 'forbidden' }, 403);

  db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(Date.now(), cid);
  realtime.broadcast(
    doc.uid,
    { type: 'comment.deleted', comment_id: cid },
    decision.identity.clientId,
  );
  return c.body(null, 204);
}

/**
 * `POST /:uid/threads/:tid/comments/:cid/reactions`
 *
 * Toggle the requesting viewer's emoji reaction on a single comment node.
 * Body: `{ emoji: string }`. If the viewer already reacted with this
 * emoji it's removed; otherwise it's added. Returns the updated thread.
 */
async function toggleCommentReaction(c: Context, deps: AppDeps) {
  const { db, realtime, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  // `react` shares the comment gate (see the `react: canReply` field in
  // toThreadWire) — readers can't react, anyone who can reply can.
  if (!canComment(decision.role)) return c.json({ error: 'forbidden' }, 403);
  const identity = decision.identity;

  const tid = c.req.param('tid');
  const cid = c.req.param('cid');
  if (!tid || !cid) return c.json({ error: 'not-found' }, 404);

  const thread = loadThreadRow(db, tid, doc.uid);
  if (!thread) return c.json({ error: 'not-found' }, 404);
  const target = loadThreadNode(db, doc.uid, tid, cid);
  if (!target) return c.json({ error: 'not-found' }, 404);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  const emoji = parseEmoji(body.emoji);
  if (!emoji) return c.json({ error: 'invalid-emoji' }, 400);

  // Race-free toggle: `INSERT OR IGNORE` is a single atomic statement
  // that reports 0 changes when the row already existed; we DELETE in
  // that case. Two concurrent same-user same-emoji clicks no longer
  // race a SELECT+INSERT pair into a unique-PK 500 — at worst they
  // cancel out, the same end-state as a sequential double-click.
  //
  // The pair is wrapped in a transaction even though each statement is
  // individually atomic: if a third party deletes the just-inserted
  // row between our two statements, our DELETE becomes a no-op and the
  // user's toggle silently flips. The transaction keeps the toggle
  // semantics consistent even under multi-connection / multi-process
  // SQLite (bun:sqlite is single-connection today, but cheap insurance
  // against future-self surprise).
  //
  // `doc_uid` is in every WHERE for defense-in-depth: comment ids are
  // globally unique today, but scoping by document matches the rest of
  // the endpoint and keeps the toggle correct if id generation ever
  // changes.
  db.exec('BEGIN');
  try {
    const inserted = db
      .prepare(
        `INSERT OR IGNORE INTO comment_reactions
           (doc_uid, comment_id, emoji, author_client_id, author_display_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(doc.uid, cid, emoji, identity.clientId, identity.displayName, Date.now());
    if (inserted.changes === 0) {
      db.prepare(
        `DELETE FROM comment_reactions
          WHERE doc_uid = ? AND comment_id = ? AND author_client_id = ? AND emoji = ?`,
      ).run(doc.uid, cid, identity.clientId, emoji);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Reuse `comment.updated` so existing clients debounce-refresh threads
  // without needing a new event-type handler. The wire payload doesn't
  // need reactions on it — listThreads is the source of truth and will
  // deliver them on next fetch.
  realtime.broadcast(
    doc.uid,
    { type: 'comment.updated', comment: toLegacyCommentWire(target) },
    identity.clientId,
  );

  // Thread row is unchanged by a reaction toggle, but the per-comment
  // reactions read inside `toThreadWire` is — that's the only thing we
  // need fresh. `replies` is reloaded so the wire reflects any other
  // concurrent activity.
  const replies = loadReplies(db, doc.uid, tid);
  const reopenableAccepted = await loadReopenableAcceptedThreadIds(doc, deps, [thread]);
  return c.json({
    thread: await toThreadWire(db, store, doc, thread, replies, decision, reopenableAccepted),
  });
}

/**
 * Load a single comment node (opener OR reply) belonging to a thread.
 * Returns null when the row doesn't exist, is soft-deleted, or doesn't
 * belong to `threadId` — used by node-level mutations to validate the
 * URL path (`/threads/:tid/comments/:cid`) in one shot.
 */
function loadThreadNode(
  db: Database,
  docUid: string,
  threadId: string,
  commentId: string,
): CommentRow | null {
  const stmt =
    commentId === threadId
      ? db.prepare(
          `SELECT * FROM comments
            WHERE id = ? AND doc_uid = ?
              AND parent_id IS NULL AND parent_proposal_id IS NULL
              AND deleted_at IS NULL
            LIMIT 1`,
        )
      : db.prepare(
          `SELECT * FROM comments
            WHERE id = ? AND doc_uid = ?
              AND deleted_at IS NULL
              AND (parent_id = ? OR parent_proposal_id = ?)
            LIMIT 1`,
        );
  const row = (
    commentId === threadId
      ? stmt.get(commentId, docUid)
      : stmt.get(commentId, docUid, threadId, threadId)
  ) as CommentRow | undefined;
  return row ?? null;
}

// Loose validation: reactions are arbitrary short strings (emoji
// codepoints, possibly multi-codepoint sequences with ZWJ joiners).
// Reject empty / over-long / whitespace-bearing values to keep storage
// bounded and deny unprintable injection. The picker only ever sends
// from a small standard set, but the server can't trust that.
const MAX_EMOJI_LENGTH = 32;

function parseEmoji(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.length === 0 || v.length > MAX_EMOJI_LENGTH) return null;
  if (/\s/.test(v)) return null;
  return v;
}

/**
 * `POST /:uid/threads/:tid/respond`
 *
 * Adds a reply, changes thread workflow state, or does both in one request.
 */
async function respondToThread(c: Context, deps: AppDeps) {
  const { db, realtime } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  const identity = decision.identity;

  const tid = c.req.param('tid');
  if (!tid) return c.json({ error: 'not-found' }, 404);
  const row = loadThreadRow(db, tid, doc.uid);
  if (!row) return c.json({ error: 'not-found' }, 404);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  const replyBody = parseOptionalBody(body.body);
  if (!replyBody.ok) return c.json({ error: 'invalid-body' }, 400);
  const action = asRespondAction(body.action);
  if (body.action !== undefined && action === null) return c.json({ error: 'invalid-body' }, 400);
  if (!replyBody.body && !action) return c.json({ error: 'empty-response' }, 400);

  if (replyBody.body && !canComment(decision.role)) return c.json({ error: 'forbidden' }, 403);

  const resolution = threadResolution(row);
  const state = threadState(row);
  const isAuthor = row.author_client_id === identity.clientId;
  const isAdmin = decision.role === 'admin';
  const isProposal = isProposalRow(row);

  if (action === 'resolve') {
    if (isProposal) return c.json({ error: 'proposal-forbidden' }, 400);
    if (state !== 'open') return c.json({ error: 'not-open' }, 400);
    if (!isAuthor && !isAdmin) return c.json({ error: 'forbidden' }, 403);
  } else if (action === 'accept') {
    if (!isProposal) return c.json({ error: 'proposal-required' }, 400);
    if (state !== 'open') return c.json({ error: 'not-open' }, 400);
    if (!canEdit(decision.role)) return c.json({ error: 'forbidden' }, 403);
    if (row.link_status === 'orphaned' || !row.anchor_block_id) {
      return c.json({ error: 'proposal-orphaned' }, 409);
    }
    if (row.link_status === 'conflict') {
      return c.json({ error: 'proposal-conflict' }, 409);
    }
  } else if (action === 'reject') {
    if (!isProposal) return c.json({ error: 'proposal-required' }, 400);
    if (state !== 'open') return c.json({ error: 'not-open' }, 400);
    if (!canEdit(decision.role) && !isAuthor) return c.json({ error: 'forbidden' }, 403);
  } else if (action === 'reopen') {
    if (state !== 'resolved') return c.json({ error: 'not-resolved' }, 400);
    if (!isProposal) {
      if (!isAuthor && !isAdmin) return c.json({ error: 'forbidden' }, 403);
    } else if (resolution?.kind === 'reject') {
      if (!canEdit(decision.role) && !isAuthor) return c.json({ error: 'forbidden' }, 403);
    } else if (resolution?.kind === 'accept') {
      if (!canEdit(decision.role)) return c.json({ error: 'forbidden' }, 403);
      const reopenable = await loadReopenableAcceptedThreadIds(doc, deps, [row]);
      if (!reopenable.has(row.id)) return c.json({ error: 'not-reopenable' }, 409);
    } else {
      return c.json({ error: 'not-reopenable' }, 409);
    }
  }

  let documentOid: string | null = null;
  let preparedWorkflow: PreparedThreadWorkflow | null = null;
  let createdReplyId: string | null = null;
  let createdReply: CommentRow | null = null;
  let createdReplyMentionTargets: string[] = [];
  let reanchoredProposalUpdates: EditProposalThreadRow[] = [];

  try {
    if (action === 'accept') {
      preparedWorkflow = await prepareAcceptProposalThread(doc, row, deps, identity);
    } else if (action === 'reopen' && resolution?.kind === 'accept') {
      preparedWorkflow = await prepareReopenAcceptedProposalThread(doc, row, deps, identity);
    }
  } catch (err) {
    if (err instanceof ThreadActionError) {
      return c.json({ error: err.code }, err.status);
    }
    throw err;
  }

  db.exec('BEGIN');
  try {
    if (action === 'resolve') {
      const now = Date.now();
      db.prepare(
        `UPDATE comments
            SET resolved_at = ?, resolved_by_name = ?, updated_at = ?
          WHERE id = ?`,
      ).run(now, identity.displayName, now, tid);
    } else if (action === 'reject') {
      const now = Date.now();
      db.prepare(
        `UPDATE comments_edit_proposals
            SET status = 'rejected'
          WHERE comment_id = ?`,
      ).run(tid);
      db.prepare(
        `UPDATE comments
            SET resolved_at = ?, resolved_by_name = ?, updated_at = ?
          WHERE id = ?`,
      ).run(now, identity.displayName, now, tid);
    } else if (action === 'accept') {
      if (!preparedWorkflow) throw new ThreadActionError(409, 'proposal-orphaned');
      documentOid = preparedWorkflow.oid;
      reanchoredProposalUpdates = preparedWorkflow.applyDb();
    } else if (action === 'reopen') {
      const now = Date.now();
      if (!isProposal) {
        db.prepare(
          `UPDATE comments
              SET resolved_at = NULL, resolved_by_name = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(now, tid);
      } else if (resolution?.kind === 'reject') {
        db.prepare(
          `UPDATE comments_edit_proposals
              SET status = 'open', accepted_oid = NULL
            WHERE comment_id = ?`,
        ).run(tid);
        db.prepare(
          `UPDATE comments
              SET resolved_at = NULL, resolved_by_name = NULL, updated_at = ?
            WHERE id = ?`,
        ).run(now, tid);
      } else if (resolution?.kind === 'accept') {
        if (!preparedWorkflow) throw new ThreadActionError(409, 'not-reopenable');
        documentOid = preparedWorkflow.oid;
        reanchoredProposalUpdates = preparedWorkflow.applyDb();
      }
    }

    if (replyBody.body) {
      const now = Date.now();
      createdReplyId = newCommentId();
      db.prepare(
        `INSERT INTO comments
           (id, doc_uid, parent_id, parent_proposal_id,
            author_client_id, author_display_name,
            body, link_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'linked', ?, ?)`,
      ).run(
        createdReplyId,
        doc.uid,
        isProposal ? null : tid,
        isProposal ? tid : null,
        identity.clientId,
        identity.displayName,
        replyBody.body,
        now,
        now,
      );

      createdReply = db
        .prepare('SELECT * FROM comments WHERE id = ?')
        .get(createdReplyId) as CommentRow;
      createdReplyMentionTargets = storeMentionsForComment(
        db,
        doc.uid,
        createdReply.id,
        createdReply.body,
        createdReply.author_display_name,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (err instanceof ThreadActionError) {
      return c.json({ error: err.code }, err.status);
    }
    throw err;
  }

  if (createdReply) {
    realtime.broadcast(
      doc.uid,
      { type: 'comment.created', comment: toLegacyCommentWire(createdReply) },
      identity.clientId,
    );
    if (createdReplyMentionTargets.length > 0) {
      realtime.broadcastToDisplayNames(
        doc.uid,
        createdReplyMentionTargets,
        { type: 'mention.created', comment: toLegacyCommentWire(createdReply) },
        identity.clientId,
      );
    }
  }
  for (const proposal of reanchoredProposalUpdates) {
    realtime.broadcast(
      doc.uid,
      {
        type: 'edit_proposal.updated',
        edit_proposal: toProposalWire(proposal),
      },
      identity.clientId,
    );
  }

  const updated = loadThreadRow(db, tid, doc.uid);
  if (!updated) return c.json({ error: 'not-found' }, 404);
  const replies = loadReplies(db, doc.uid, tid);
  const reopenableAccepted = await loadReopenableAcceptedThreadIds(doc, deps, [updated]);

  if (action) {
    if (isProposalRow(updated)) {
      realtime.broadcast(
        doc.uid,
        {
          type: 'edit_proposal.updated',
          edit_proposal: toProposalWire(updated),
        },
        identity.clientId,
      );
    } else {
      realtime.broadcast(
        doc.uid,
        { type: 'comment.updated', comment: toLegacyCommentWire(updated) },
        identity.clientId,
      );
    }
  }
  if (documentOid) {
    realtime.broadcast(
      doc.uid,
      { type: 'document.updated', oid: documentOid, author: identity.displayName },
      identity.clientId,
    );
  }

  return c.json({
    thread: await toThreadWire(
      deps.db,
      deps.store,
      doc,
      updated,
      replies,
      decision,
      reopenableAccepted,
    ),
    created_reply_id: createdReplyId,
  });
}

async function prepareAcceptProposalThread(
  doc: DocumentRow,
  row: ThreadRow,
  deps: AppDeps,
  identity: Identity,
): Promise<PreparedThreadWorkflow> {
  const isWholeDoc = row.is_whole_document === 1;
  if (
    !row.branch_ref ||
    !row.base_oid ||
    row.base_block_start === null ||
    row.base_block_end === null
  ) {
    throw new ThreadActionError(409, 'proposal-orphaned');
  }
  if (!isWholeDoc && !row.anchor_block_id) {
    throw new ThreadActionError(409, 'proposal-orphaned');
  }

  // Recover proposedText from the branch tip and base blob — needed
  // for post-merge anchor relocation. Done before the merge so we
  // don't depend on git state mutated by the merge call.
  const content = await readProposalContent(deps.store, doc, row);
  if (!content) throw new ThreadActionError(409, 'proposal-orphaned');
  const proposedText = content.proposed_text;

  const preMergeSource = deps.store.read(doc);
  // Whole-document proposals splice the full source. Skip the anchor
  // block lookup — it has no meaning here, and the proposal is never
  // orphaned by anchor drift.
  let preMergeRange: BlockSourceRange | null;
  if (isWholeDoc) {
    preMergeRange = { start: 0, end: preMergeSource.length, kind: 'multi', text: '' };
  } else {
    // Guard above ensures anchor_block_id is non-null in this branch.
    const blockId = row.anchor_block_id;
    if (!blockId) throw new ThreadActionError(409, 'proposal-orphaned');
    preMergeRange = locateAnchorRange(doc, preMergeSource, blockId, row.anchor_end_block_id);
  }
  if (!preMergeRange) {
    const now = Date.now();
    deps.db
      .prepare(
        `UPDATE comments
            SET link_status = 'orphaned', anchor_block_id = NULL, anchor_end_block_id = NULL,
                updated_at = ?
          WHERE id = ?`,
      )
      .run(now, row.id);
    const updated = loadProposalRow(deps.db, row.id, doc.uid);
    if (updated) {
      deps.realtime.broadcast(
        doc.uid,
        {
          type: 'edit_proposal.updated',
          edit_proposal: toProposalWire(updated),
        },
        identity.clientId,
      );
    }
    throw new ThreadActionError(409, 'proposal-orphaned');
  }

  const merge = await deps.store.mergeProposalBranch(doc, row.id, identity);
  if (!merge.ok) {
    if (merge.reason === 'conflict') {
      throw new ThreadActionError(409, 'proposal-conflict');
    }
    throw new ThreadActionError(409, 'proposal-orphaned');
  }
  const oid = merge.oid;
  const nextSource = deps.store.read(doc);
  const spliceStart = isWholeDoc
    ? 0
    : locatePostMergeSpliceStart(doc, nextSource, proposedText, preMergeRange.start);

  const rendered = await renderDocument(nextSource, doc.format);
  const presentBlocks = locateDocumentBlocks(doc, nextSource);
  const topLevelComments = deps.db
    .prepare(
      `SELECT c.*
         FROM comments c
         LEFT JOIN comments_edit_proposals cep ON cep.comment_id = c.id
        WHERE c.doc_uid = ?
          AND c.parent_id IS NULL
          AND c.parent_proposal_id IS NULL
          AND c.deleted_at IS NULL
          AND cep.comment_id IS NULL`,
    )
    .all(doc.uid) as CommentRow[];
  const commentAnchorUpdates = topLevelComments.map((comment) => {
    const upd = reanchor(comment, rendered.blocks);
    return { commentId: comment.id, ...upd };
  });

  const acceptedAnchor = locateAcceptedProposalAnchor(
    presentBlocks,
    rendered.blocks,
    spliceStart,
    spliceStart + proposedText.length,
  );

  return {
    oid,
    applyDb: () => {
      const now = Date.now();
      deps.db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(now, doc.uid);

      const updateCommentStmt = deps.db.prepare(
        `UPDATE comments
            SET anchor_block_id = ?, anchor_start_offset = ?, anchor_end_offset = ?,
                link_status = ?, updated_at = ?
          WHERE id = ?`,
      );
      for (const upd of commentAnchorUpdates) {
        updateCommentStmt.run(
          upd.blockId,
          upd.startOffset,
          upd.endOffset,
          upd.linkStatus,
          now,
          upd.commentId,
        );
      }

      deps.db
        .prepare(
          `UPDATE comments_edit_proposals
            SET status = 'accepted', accepted_oid = ?
          WHERE comment_id = ?`,
        )
        .run(oid, row.id);
      deps.db
        .prepare(
          `UPDATE comments
            SET anchor_block_id = ?,
                anchor_end_block_id = NULL,
                anchor_start_offset = ?,
                anchor_end_offset = ?,
                anchor_heading_path = ?,
                anchor_section_index = ?,
                anchor_section_index_path = ?,
                link_status = ?,
                resolved_at = ?,
                resolved_by_name = ?,
                updated_at = ?
          WHERE id = ?`,
        )
        .run(
          acceptedAnchor?.block.id ?? row.anchor_block_id,
          null,
          null,
          acceptedAnchor
            ? JSON.stringify(acceptedAnchor.block.headingPath)
            : row.anchor_heading_path,
          acceptedAnchor?.block.sectionIndex ?? row.anchor_section_index,
          acceptedAnchor
            ? JSON.stringify(acceptedAnchor.block.sectionIndexPath)
            : row.anchor_section_index_path,
          acceptedAnchor?.linkStatus ?? row.link_status,
          now,
          identity.displayName,
          now,
          row.id,
        );

      return reanchorProposals(deps.db, doc.uid, presentBlocks, doc.format, now);
    },
  };
}

async function prepareReopenAcceptedProposalThread(
  doc: DocumentRow,
  row: ThreadRow,
  deps: AppDeps,
  identity: Identity,
): Promise<PreparedThreadWorkflow> {
  if (!row.accepted_oid) throw new ThreadActionError(409, 'not-reopenable');

  const history = await deps.store.history(doc);
  const latest = history[0];
  const parent = history[1];
  if (!latest || latest.oid !== row.accepted_oid || !parent) {
    throw new ThreadActionError(409, 'not-reopenable');
  }

  const diff = await deps.store.diffAt(doc, row.accepted_oid);
  if (!diff) throw new ThreadActionError(409, 'not-reopenable');

  const { oid } = await deps.store.write(doc, diff.before, identity, 'restore', {
    restoredFromOid: parent.oid,
  });

  const rendered = await renderDocument(diff.before, doc.format);
  const topLevel = deps.db
    .prepare(
      `SELECT * FROM comments
         WHERE doc_uid = ? AND parent_id IS NULL AND deleted_at IS NULL`,
    )
    .all(doc.uid) as CommentRow[];
  const commentAnchorUpdates = topLevel.map((comment) => {
    const upd = reanchor(comment, rendered.blocks);
    return { commentId: comment.id, ...upd };
  });

  const knownBlocks = locateDocumentBlocks(doc, diff.before);
  return {
    oid,
    applyDb: () => {
      const now = Date.now();
      deps.db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(now, doc.uid);

      const updateStmt = deps.db.prepare(
        `UPDATE comments
            SET anchor_block_id = ?, anchor_start_offset = ?, anchor_end_offset = ?,
                link_status = ?, updated_at = ?
          WHERE id = ?`,
      );
      for (const upd of commentAnchorUpdates) {
        updateStmt.run(
          upd.blockId,
          upd.startOffset,
          upd.endOffset,
          upd.linkStatus,
          now,
          upd.commentId,
        );
      }

      const reopened = reopenAcceptedProposal(deps.db, doc.uid, row.id, now);
      if (!reopened) throw new ThreadActionError(409, 'not-reopenable');

      return reanchorProposals(deps.db, doc.uid, knownBlocks, doc.format, now);
    },
  };
}

function loadDoc(db: Database, uid: string | undefined): DocumentRow | null {
  if (!uid) return null;
  const row = db.prepare('SELECT * FROM documents WHERE uid = ?').get(uid) as
    | DocumentRow
    | undefined;
  return row ?? null;
}

function authorizeRequest(c: Context, deps: AppDeps, doc: DocumentRow) {
  const cookie = c.req.raw.headers.get('cookie');
  const sessionToken = parseCookie(cookie, SESSION_COOKIE);
  const inviteSessionToken = parseCookie(cookie, INVITE_SESSION_COOKIE);
  return authorize(deps.db, doc, c.req.raw.headers, sessionToken, inviteSessionToken);
}

function loadThreadRow(db: Database, threadId: string, docUid: string): ThreadRow | undefined {
  return db
    .prepare(
      `${THREAD_SELECT}
       WHERE c.id = ?
         AND c.doc_uid = ?
         AND c.parent_id IS NULL
         AND c.parent_proposal_id IS NULL
         AND c.deleted_at IS NULL
       LIMIT 1`,
    )
    .get(threadId, docUid) as ThreadRow | undefined;
}

function loadReplyRow(
  db: Database,
  docUid: string,
  threadId: string,
  commentId: string,
): CommentRow | undefined {
  return db
    .prepare(
      `SELECT *
         FROM comments
        WHERE id = ?
          AND doc_uid = ?
          AND deleted_at IS NULL
          AND (parent_id = ? OR parent_proposal_id = ?)
        LIMIT 1`,
    )
    .get(commentId, docUid, threadId, threadId) as CommentRow | undefined;
}

function loadReplies(db: Database, docUid: string, threadId: string | null): CommentRow[] {
  if (threadId) {
    return db
      .prepare(
        `SELECT *
           FROM comments
          WHERE doc_uid = ?
            AND deleted_at IS NULL
            AND (parent_id = ? OR parent_proposal_id = ?)
          ORDER BY created_at ASC`,
      )
      .all(docUid, threadId, threadId) as CommentRow[];
  }
  return db
    .prepare(
      `SELECT *
         FROM comments
        WHERE doc_uid = ?
          AND deleted_at IS NULL
          AND (parent_id IS NOT NULL OR parent_proposal_id IS NOT NULL)
        ORDER BY created_at ASC`,
    )
    .all(docUid) as CommentRow[];
}

function groupRepliesByThread(replies: CommentRow[]): Map<string, CommentRow[]> {
  const byThread = new Map<string, CommentRow[]>();
  for (const reply of replies) {
    const threadId = reply.parent_id ?? reply.parent_proposal_id;
    if (!threadId) continue;
    const list = byThread.get(threadId);
    if (list) list.push(reply);
    else byThread.set(threadId, [reply]);
  }
  return byThread;
}

async function loadReopenableAcceptedThreadIds(
  doc: DocumentRow,
  deps: AppDeps,
  rows: ThreadRow[],
): Promise<Set<string>> {
  const accepted = rows.filter((row) => row.proposal_status === 'accepted' && row.accepted_oid);
  if (accepted.length === 0) return new Set<string>();

  const history = await deps.store.history(doc);
  const latest = history[0];
  const parent = history[1];
  if (!latest || !parent) return new Set<string>();

  // Reopen makes the proposal `status='open'` again; without recoverable
  // branch metadata the row is permanently undiffable + unacceptable
  // (accept would 409 proposal-orphaned, diff 410). Block reopen for
  // legacy accepted rows that don't carry the metadata to be operational.
  return new Set(
    accepted
      .filter(
        (row) =>
          row.accepted_oid === latest.oid &&
          row.branch_ref !== null &&
          row.base_oid !== null &&
          row.base_block_start !== null &&
          row.base_block_end !== null,
      )
      .map((row) => row.id),
  );
}

async function toThreadWire(
  db: Database,
  store: GitStore,
  doc: DocumentRow,
  row: ThreadRow,
  replies: CommentRow[],
  decision: ReturnType<typeof authorize>,
  reopenableAccepted: Set<string>,
  /**
   * Preloaded reactions keyed by comment id, used by listThreads to
   * collapse what would otherwise be N+1 queries (one per thread) into
   * a single batch read. Single-thread mutation handlers omit this and
   * pay the cost of one extra query, which is fine.
   */
  preloadedReactions?: Map<string, ReactionWire[]>,
): Promise<Record<string, unknown>> {
  const state = threadState(row);
  const resolution = threadResolution(row);
  const rootAuthor = row.author_client_id;
  const viewerId = decision.ok ? (decision.identity?.clientId ?? null) : null;
  const isRootAuthor = viewerId !== null && viewerId === rootAuthor;
  const isAdmin = decision.ok && decision.role === 'admin';
  const proposalRow: EditProposalThreadRow | null = isProposalRow(row) ? row : null;
  const proposal = proposalRow !== null;
  const canReply = decision.ok && canComment(decision.role);
  const canRootEdit = viewerId !== null && viewerId === row.author_client_id;
  const canRootDelete = canRootEdit || isAdmin;

  const reactionsByComment =
    preloadedReactions ??
    loadCommentReactionsWire(db, doc.uid, [row.id, ...replies.map((r) => r.id)], viewerId);

  return {
    id: row.id,
    state,
    resolution,
    link_status: row.link_status,
    anchor: {
      block_id: row.anchor_block_id,
      end_block_id: row.anchor_end_block_id,
      quote: row.anchor_quote,
      prefix: row.anchor_prefix ?? '',
      suffix: row.anchor_suffix ?? '',
      start_offset: row.anchor_start_offset,
      end_offset: row.anchor_end_offset,
      heading_path: parseHeadingPath(row.anchor_heading_path),
      section_index: row.anchor_section_index,
      section_index_path: parseIntArray(row.anchor_section_index_path),
    },
    capabilities: {
      reply: canReply,
      resolve: !proposal && state === 'open' && (isRootAuthor || isAdmin),
      accept:
        proposal &&
        state === 'open' &&
        decision.ok &&
        canEdit(decision.role) &&
        isProposalAnchorAcceptable(row) &&
        (row.is_whole_document === 1 || row.anchor_block_id !== null),
      reject:
        proposal && state === 'open' && decision.ok && (canEdit(decision.role) || isRootAuthor),
      repair:
        proposal &&
        state === 'open' &&
        decision.ok &&
        canPropose(decision.role) &&
        row.link_status === 'orphaned' &&
        row.is_whole_document !== 1 &&
        row.branch_ref !== null &&
        row.base_oid !== null,
      reopen:
        state === 'resolved' &&
        (!proposal
          ? isRootAuthor || isAdmin
          : resolution?.kind === 'reject'
            ? decision.ok && (canEdit(decision.role) || isRootAuthor)
            : resolution?.kind === 'accept'
              ? decision.ok && canEdit(decision.role) && reopenableAccepted.has(row.id)
              : false),
    },
    proposal: proposalRow
      ? {
          ...((await readProposalContent(store, doc, proposalRow)) ?? {
            source_snapshot: null,
            proposed_text: null,
          }),
          whole_document: proposalRow.is_whole_document === 1,
        }
      : null,
    comments: [
      {
        id: row.id,
        body: row.body,
        author: {
          client_id: row.author_client_id,
          display_name: row.author_display_name,
        },
        capabilities: {
          edit: canRootEdit,
          delete: row.proposal_status === 'accepted' ? isAdmin : canRootDelete,
          react: canReply,
        },
        reactions: reactionsByComment.get(row.id) ?? [],
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      ...replies.map((reply) => ({
        id: reply.id,
        body: reply.body,
        author: {
          client_id: reply.author_client_id,
          display_name: reply.author_display_name,
        },
        capabilities: {
          edit: viewerId !== null && viewerId === reply.author_client_id,
          delete: (viewerId !== null && viewerId === reply.author_client_id) || isAdmin,
          react: canReply,
        },
        reactions: reactionsByComment.get(reply.id) ?? [],
        created_at: reply.created_at,
        updated_at: reply.updated_at,
      })),
    ],
  };
}

interface ReactionWire {
  emoji: string;
  count: number;
  /** True when the requesting viewer has this reaction on this comment. */
  reacted: boolean;
  /** Author display names, ordered by reaction time (oldest first). */
  authors: string[];
}

// Conservative cap on the `comment_id IN (?, ?, …)` list. SQLite's
// `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older builds and 32766 on
// recent ones; 500 is well under the floor and lets us batch without
// caring which build is active. Plus 1 for `doc_uid`.
const REACTION_QUERY_BATCH = 500;

function loadCommentReactionsWire(
  db: Database,
  docUid: string,
  commentIds: string[],
  viewerId: string | null,
): Map<string, ReactionWire[]> {
  const result = new Map<string, ReactionWire[]>();
  if (commentIds.length === 0) return result;

  // Group reactions per (comment_id, emoji) as we read across batches.
  const grouped = new Map<string, Map<string, ReactionWire>>();
  for (let i = 0; i < commentIds.length; i += REACTION_QUERY_BATCH) {
    const batch = commentIds.slice(i, i + REACTION_QUERY_BATCH);
    const placeholders = batch.map(() => '?').join(',');
    // ORDER BY (comment_id, created_at) lines up with the
    // (doc_uid, comment_id, created_at) index so the sort is index-
    // driven rather than a filesort. Downstream we group by
    // comment_id anyway, so the cross-comment order doesn't matter —
    // only oldest-first within each comment, which this preserves.
    const rows = db
      .prepare(
        `SELECT comment_id, emoji, author_client_id, author_display_name
           FROM comment_reactions
          WHERE doc_uid = ?
            AND comment_id IN (${placeholders})
          ORDER BY comment_id, created_at ASC`,
      )
      .all(docUid, ...batch) as Pick<
      CommentReactionRow,
      'comment_id' | 'emoji' | 'author_client_id' | 'author_display_name'
    >[];
    for (const r of rows) {
      let perComment = grouped.get(r.comment_id);
      if (!perComment) {
        perComment = new Map();
        grouped.set(r.comment_id, perComment);
      }
      let bucket = perComment.get(r.emoji);
      if (!bucket) {
        bucket = { emoji: r.emoji, count: 0, reacted: false, authors: [] };
        perComment.set(r.emoji, bucket);
      }
      bucket.count += 1;
      bucket.authors.push(r.author_display_name);
      if (viewerId !== null && r.author_client_id === viewerId) bucket.reacted = true;
    }
  }
  for (const [cid, perComment] of grouped) {
    result.set(cid, Array.from(perComment.values()));
  }
  return result;
}

function threadState(row: ThreadRow): ThreadState {
  if (isProposalRow(row)) return row.proposal_status === 'open' ? 'open' : 'resolved';
  return row.resolved_at === null ? 'open' : 'resolved';
}

function threadResolution(
  row: ThreadRow,
): { kind: ResolutionKind; at: number; by_name: string | null } | null {
  if (!isProposalRow(row)) {
    return row.resolved_at === null
      ? null
      : { kind: 'resolve', at: row.resolved_at, by_name: row.resolved_by_name };
  }
  if (row.proposal_status === 'accepted') {
    return {
      kind: 'accept',
      at: row.decided_at ?? row.resolved_at ?? row.updated_at,
      by_name: row.decided_by_name ?? row.resolved_by_name,
    };
  }
  if (row.proposal_status === 'rejected') {
    return {
      kind: 'reject',
      at: row.decided_at ?? row.resolved_at ?? row.updated_at,
      by_name: row.decided_by_name ?? row.resolved_by_name,
    };
  }
  return null;
}

function isProposalRow(row: ThreadRow): row is EditProposalThreadRow {
  return row.proposal_status !== null;
}

/**
 * Find the block-boundary position in `nextSource` where `proposedText`
 * was inserted by the merge. The splice always starts at a block start
 * (the branch was built that way against base), so we only consider
 * candidate positions that align with a block boundary — `indexOf`
 * alone could match common short text inside an unrelated block.
 *
 * Ties broken by proximity to `baselineStart` (the splice site in
 * pre-merge source). Falls back to `baselineStart` if no block start
 * carries the proposed text.
 */
function locatePostMergeSpliceStart(
  doc: DocumentRow,
  nextSource: string,
  proposedText: string,
  baselineStart: number,
): number {
  if (proposedText.length === 0) return baselineStart;
  let bestStart: number | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const range of locateDocumentBlocks(doc, nextSource).values()) {
    // Require an exact range match — a prefix-only match could pick an
    // unrelated block that just happens to start with proposedText.
    if (nextSource.slice(range.start, range.end) !== proposedText) continue;
    const dist = Math.abs(range.start - baselineStart);
    if (dist < bestDist) {
      bestStart = range.start;
      bestDist = dist;
    }
  }
  return bestStart ?? baselineStart;
}

function locateAcceptedProposalAnchor(
  blocks: Map<string, BlockSourceRange>,
  renderedBlocks: BlockInfo[],
  start: number,
  end: number,
): { block: BlockInfo; linkStatus: 'linked' | 'low-confidence' } | null {
  const located = findBlockBySourceSpan(blocks, start, end);
  if (!located) return null;
  const rendered = renderedBlocks.find((block) => block.id === located.id);
  if (!rendered) return null;
  return { block: rendered, linkStatus: located.confidence };
}

function changedSpan(
  before: string,
  after: string,
): { beforeStart: number; beforeEnd: number } | null {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let suffix = 0;
  while (
    suffix < before.length - start &&
    suffix < after.length - start &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return {
    beforeStart: start,
    beforeEnd: before.length - suffix,
  };
}

function locateRepairAnchor(
  blocks: Map<string, BlockSourceRange>,
  renderedBlocks: BlockInfo[],
  source: string,
  start: number,
  end: number,
  format: DocumentRow['format'],
): {
  block: BlockInfo;
  endBlock: BlockInfo | null;
  quote: string;
  linkStatus: 'linked' | 'low-confidence';
} | null {
  const renderedById = new Map(renderedBlocks.map((block) => [block.id, block]));
  const sorted = Array.from(blocks.entries()).sort((a, b) => a[1].start - b[1].start);

  for (const [id, range] of sorted) {
    if (range.start !== start || range.end !== end) continue;
    const block = renderedById.get(id);
    if (!block) return null;
    return {
      block,
      endBlock: null,
      quote: source.slice(range.start, range.end),
      linkStatus: 'linked',
    };
  }

  let best: {
    startId: string;
    startRange: BlockSourceRange;
    endId: string;
    endRange: BlockSourceRange;
    span: number;
  } | null = null;
  for (const [startId, startRange] of sorted) {
    if (startRange.start !== start) continue;
    for (const [endId, endRange] of sorted) {
      if (endRange.end !== end) continue;
      if (!canMergeMultiBlock(startRange, endRange, format)) continue;
      const span =
        Math.max(startRange.end, endRange.end) - Math.min(startRange.start, endRange.start);
      if (!best || span < best.span) {
        best = { startId, startRange, endId, endRange, span };
      }
    }
  }
  if (best) {
    const block = renderedById.get(best.startId);
    const endBlock = renderedById.get(best.endId);
    if (!block || !endBlock) return null;
    return {
      block,
      endBlock: best.endId === best.startId ? null : endBlock,
      quote: source.slice(
        Math.min(best.startRange.start, best.endRange.start),
        Math.max(best.startRange.end, best.endRange.end),
      ),
      linkStatus: 'linked',
    };
  }

  const located = findBlockBySourceSpan(blocks, start, end);
  if (!located) return null;
  const block = renderedById.get(located.id);
  if (!block) return null;
  return {
    block,
    endBlock: null,
    quote: source.slice(start, end) || located.range.text,
    linkStatus: located.confidence,
  };
}

type RepairAnchor = NonNullable<ReturnType<typeof locateRepairAnchor>>;

async function locateConflictRepairAnchor(
  doc: DocumentRow,
  row: EditProposalThreadRow,
  store: GitStore,
): Promise<RepairAnchor | null> {
  if (row.base_block_start === null || row.base_block_end === null) return null;
  const original = await readProposalFullContent(store, doc, row);
  if (!original) return null;
  const lineSpan = lineSpanForOffsets(original.before, row.base_block_start, row.base_block_end);
  if (!lineSpan) return null;

  const currentSource = store.read(doc);
  const currentSpan = sourceSpanForLineSpan(currentSource, lineSpan.startLine, lineSpan.endLine);
  if (!currentSpan) return null;

  const rendered = await renderDocument(currentSource, doc.format);
  const blocks = locateDocumentBlocks(doc, currentSource);
  return locateRepairAnchor(
    blocks,
    rendered.blocks,
    currentSource,
    currentSpan.start,
    currentSpan.end,
    doc.format,
  );
}

function lineSpanForOffsets(
  source: string,
  start: number,
  end: number,
): { startLine: number; endLine: number } | null {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const safeStart = Math.max(0, Math.min(source.length, start));
  const safeEnd = Math.max(safeStart, Math.min(source.length, end));
  const endProbe = safeEnd > safeStart ? safeEnd - 1 : safeStart;
  return {
    startLine: lineNumberAtOffset(source, safeStart),
    endLine: lineNumberAtOffset(source, endProbe),
  };
}

function lineNumberAtOffset(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function sourceSpanForLineSpan(
  source: string,
  startLine: number,
  endLine: number,
): { start: number; end: number } | null {
  if (startLine < 1 || endLine < startLine) return null;
  const lineStarts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }
  if (startLine > lineStarts.length) return null;
  const clampedEndLine = Math.min(endLine, lineStarts.length);
  const start = lineStarts[startLine - 1];
  if (start === undefined) return null;
  const nextLineStart = lineStarts[clampedEndLine];
  let end =
    clampedEndLine < lineStarts.length && nextLineStart !== undefined
      ? nextLineStart - 1
      : source.length;
  if (end > start && source.charCodeAt(end - 1) === 13) end -= 1;
  return end >= start ? { start, end } : null;
}

function isProposalAnchorAcceptable(row: Pick<CommentRow, 'link_status'>): boolean {
  return row.link_status !== 'orphaned' && row.link_status !== 'conflict';
}

async function safeJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const v = await c.req.json();
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

type OptionalBodyParse = { ok: true; body: string | null } | { ok: false };

function parseOptionalBody(v: unknown): OptionalBodyParse {
  if (v === undefined || v === null) return { ok: true, body: null };
  if (typeof v !== 'string') return { ok: false };
  const trimmed = v.trim();
  if (trimmed.length === 0) return { ok: true, body: null };
  if (trimmed.length > 5000) return { ok: false };
  return { ok: true, body: trimmed };
}

type ThreadRootBodyParse = { ok: true; body: string | undefined } | { ok: false };

function parseThreadRootBody(v: unknown, allowEmpty: boolean): ThreadRootBodyParse {
  if (v === null && allowEmpty) return { ok: true, body: '' };
  if (v === undefined || v === null) return { ok: true, body: undefined };
  if (typeof v !== 'string') return { ok: false };
  const trimmed = v.trim();
  if (trimmed.length === 0) return { ok: true, body: allowEmpty ? '' : undefined };
  if (trimmed.length > 5000) return { ok: false };
  return { ok: true, body: trimmed };
}

function asRespondAction(v: unknown): RespondAction | null {
  return v === 'resolve' || v === 'accept' || v === 'reject' || v === 'reopen' ? v : null;
}

// Caps on free-text anchor fields. `quote` can legitimately concatenate
// multiple top-level blocks for multi-block proposals, so we mirror the
// proposed_text ceiling. prefix/suffix are short context windows used for
// re-anchoring — kilobytes are plenty.
const MAX_ANCHOR_QUOTE_LENGTH = 60000;
const MAX_ANCHOR_CONTEXT_LENGTH = 1024;

interface ParsedAnchor {
  blockId: string;
  endBlockId: string | null;
  quote: string;
  prefix: string;
  suffix: string;
  startOffset: number;
  endOffset: number;
  headingPath: string[] | null;
  sectionIndex: number | null;
  sectionIndexPath: number[] | null;
}

type AnchorParseResult =
  | { ok: true; anchor: ParsedAnchor }
  | { ok: false; error: 'anchor-required' | 'anchor-too-long' };

function asAnchor(v: unknown): AnchorParseResult {
  if (!v || typeof v !== 'object') return { ok: false, error: 'anchor-required' };
  const a = v as Record<string, unknown>;
  const blockId = asString(a.block_id);
  const quote = typeof a.quote === 'string' ? a.quote : null;
  if (!blockId || quote === null) return { ok: false, error: 'anchor-required' };
  const prefix = typeof a.prefix === 'string' ? a.prefix : '';
  const suffix = typeof a.suffix === 'string' ? a.suffix : '';
  if (
    quote.length > MAX_ANCHOR_QUOTE_LENGTH ||
    prefix.length > MAX_ANCHOR_CONTEXT_LENGTH ||
    suffix.length > MAX_ANCHOR_CONTEXT_LENGTH
  ) {
    return { ok: false, error: 'anchor-too-long' };
  }
  const rawEnd = typeof a.end_block_id === 'string' ? a.end_block_id : null;
  const endBlockId = rawEnd && rawEnd.length > 0 && rawEnd !== blockId ? rawEnd : null;
  const headingPath = Array.isArray(a.heading_path)
    ? a.heading_path.filter((s): s is string => typeof s === 'string')
    : null;
  const sectionIndexPath = Array.isArray(a.section_index_path)
    ? a.section_index_path.filter((n): n is number => typeof n === 'number')
    : null;
  return {
    ok: true,
    anchor: {
      blockId,
      endBlockId,
      quote,
      prefix,
      suffix,
      startOffset: typeof a.start_offset === 'number' ? a.start_offset : 0,
      endOffset: typeof a.end_offset === 'number' ? a.end_offset : quote.length,
      headingPath,
      sectionIndex: typeof a.section_index === 'number' ? a.section_index : null,
      sectionIndexPath,
    },
  };
}

const MAX_PROPOSED_TEXT_LENGTH = 60000;

function asProposal(
  v: unknown,
):
  | { ok: true; proposal: { proposedText: string; wholeDocument: boolean } | null }
  | { ok: false; error: 'proposal-text-required' | 'proposal-text-too-long' } {
  if (v === null || v === undefined) return { ok: true, proposal: null };
  if (typeof v !== 'object') return { ok: false, error: 'proposal-text-required' };
  const proposal = v as Record<string, unknown>;
  const proposedText = typeof proposal.proposed_text === 'string' ? proposal.proposed_text : null;
  if (proposedText === null) return { ok: false, error: 'proposal-text-required' };
  if (proposedText.length > MAX_PROPOSED_TEXT_LENGTH) {
    return { ok: false, error: 'proposal-text-too-long' };
  }
  const wholeDocument = proposal.whole_document === true;
  return { ok: true, proposal: { proposedText, wholeDocument } };
}

function parseHeadingPath(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : null;
  } catch {
    return null;
  }
}

function parseIntArray(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : null;
  } catch {
    return null;
  }
}

function newCommentId(): string {
  return randomBytes(12).toString('base64url');
}

class ThreadActionError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: string,
  ) {
    super(code);
  }
}
