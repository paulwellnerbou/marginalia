import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import type { BlockInfo, BlockSourceRange, RenderResult } from '@marginalia/renderer';
import { rewriteAssetReferences } from '@marginalia/renderer';
import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  anchorUnchanged,
  prepareBlockReplacements,
  REANCHOR_COMMENT_SQL,
  reanchor,
  reanchorParams,
  TOP_LEVEL_COMMENTS_SQL,
  type TopLevelCommentRow,
} from '../anchoring.js';
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
import { mergeThreeWay, type ThreeWaySides } from '../conflict.js';
import {
  type CommentLinkStatus,
  type CommentReactionRow,
  type CommentRow,
  type DocumentRow,
  type EditProposalStatus,
  type EditProposalThreadRow,
  PROPOSAL_ANSWERS_JSON_SQL,
  parseAnswerIds,
} from '../db.js';
import type { GitStore } from '../git-store.js';
import {
  consumePendingMentions,
  listMentionCandidates,
  storeMentionsForComment,
} from '../mentions.js';
import { renderDocumentCached, renderDocumentCopy } from '../render-cache.js';
import { listAttached } from './assets.js';
import { toWire as toLegacyCommentWire } from './comments.js';
import type { AppDeps } from './documents.js';
import {
  findBlockBySourceSpan,
  loadProposalRow,
  locateAnchorRange,
  locateDocumentBlocks,
  locateProposalAnchorBySourceSpan,
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
  answers_comment_ids: string | null;
  decided_at: number | null;
  decided_by_name: string | null;
}

type ThreadState = 'open' | 'resolved';
type ThreadStateFilter = ThreadState | 'all';
type ResolutionKind = 'resolve' | 'accept' | 'reject';
type RespondAction = 'resolve' | 'accept' | 'reject' | 'reopen';

interface PreparedThreadWorkflow {
  oid: string;
  applyDb: () => EditProposalThreadRow[];
  // The post-merge source and its render, already computed here to
  // re-anchor comments. Handed back so the response can carry the new
  // document and the client is spared a full re-fetch + re-render of it.
  nextSource: string;
  rendered: RenderResult;
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
    ${PROPOSAL_ANSWERS_JSON_SQL},
    c.resolved_at AS decided_at,
    c.resolved_by_name AS decided_by_name
  FROM comments c
  LEFT JOIN comments_edit_proposals cep ON cep.comment_id = c.id
`;

/**
 * `threadState(row) === 'open'`, in SQL, against the `THREAD_SELECT`
 * aliases. `cep.status IS 'open'` rather than `=`: for a plain comment
 * the column is NULL, and `=` would yield NULL there, which `NOT (…)`
 * would not turn back into a match — leaving resolved comments in
 * neither half.
 */
const OPEN_THREAD_SQL = `((cep.status IS NULL AND c.resolved_at IS NULL) OR cep.status IS 'open')`;

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
  r.get('/:uid/threads/:tid/conflict', async (c) => getThreadConflict(c, deps));
  r.post('/:uid/threads/:tid/resolve', async (c) => resolveThreadConflict(c, deps));
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
 * Returns root threads with their replies, optional proposal payload, and
 * server-computed capabilities.
 *
 * Open threads only, unless asked otherwise: a resolved thread is settled
 * business, and on a long-reviewed document the archive dwarfs the live
 * queue. Every resolved proposal returned costs a git read here and a
 * chunk of the reading agent's context there. `state=resolved`/`all` ask
 * for the rest; `thread_id` fetches one thread whatever its state, which
 * is the cheap way back to something already closed.
 *
 * `thread_id` decides which threads come back, but it does not excuse a
 * malformed `state` — a value the caller misspelled is still a 400,
 * whatever else the request carries. Answering it anyway would hide the
 * typo for exactly as long as `thread_id` stayed in the query.
 */
async function listThreads(c: Context, deps: AppDeps) {
  const { db, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);

  const state = parseThreadStateFilter(c.req.query('state'));
  if (!state) return c.json({ error: 'invalid-state' }, 400);
  const threadId = c.req.query('thread_id') ?? null;

  const conditions = [
    'c.doc_uid = ?',
    'c.parent_id IS NULL',
    'c.parent_proposal_id IS NULL',
    'c.deleted_at IS NULL',
    '(c.is_hidden = 0 OR c.author_client_id = ?)',
  ];
  const viewerId = decision.identity?.clientId ?? '';
  const params: string[] = [doc.uid, viewerId];
  if (threadId) {
    // Naming a thread outranks the state filter — asking by id is how a
    // caller reaches one resolved thread without pulling the archive.
    // Any live message in it names it: the viewer's copy-link button
    // sits on replies too, so a `#comment-<id>` link often points at one.
    conditions.push(`(c.id = ?
       OR EXISTS (SELECT 1
                    FROM comments r
                   WHERE r.doc_uid = c.doc_uid
                     AND r.deleted_at IS NULL
                     AND r.id = ?
                     AND (r.is_hidden = 0 OR r.author_client_id = ?)
                     AND (r.parent_id = c.id OR r.parent_proposal_id = c.id)))`);
    params.push(threadId, threadId, viewerId);
  } else if (state === 'open') {
    conditions.push(OPEN_THREAD_SQL);
  } else if (state === 'resolved') {
    conditions.push(`NOT ${OPEN_THREAD_SQL}`);
  }

  const roots = db
    .prepare(
      `${THREAD_SELECT}
       WHERE ${conditions.join('\n         AND ')}
       ORDER BY c.created_at ASC`,
    )
    .all(...params) as ThreadRow[];
  const replies = loadRepliesForThreads(
    db,
    doc.uid,
    roots.map((row) => row.id),
  );
  const repliesByThread = groupRepliesByThread(replies);
  const reopenableAccepted = await loadReopenableAcceptedThreadIds(doc, deps, roots);

  // Batch-load reactions for every comment node on the page in a single
  // query. Without this, toThreadWire's per-thread fallback turns into
  // N+1 (one reactions query per root) and dominates the request as
  // thread counts grow.
  const reactionsByComment = loadCommentReactionsWire(
    db,
    doc.uid,
    [...roots.map((r) => r.id), ...replies.map((r) => r.id)],
    viewerId || null,
  );

  const answersByThread = loadAnswersByThread(
    db,
    doc.uid,
    roots.map((r) => r.id),
    viewerId || null,
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
      answersByThread,
    ),
  );
  return c.json({
    threads,
    // Always for the whole document, however the list was filtered: a
    // caller shown eight open threads still needs to know whether it is
    // looking at all visible threads. Private threads do not contribute
    // to another viewer's totals.
    counts: countThreadsByState(db, doc.uid, viewerId || null),
    mention_candidates: listMentionCandidates(db, doc.uid),
    pending_mentions:
      c.req.query('consume_mentions') === 'false'
        ? []
        : consumePendingMentions(db, doc.uid, decision.identity?.displayName ?? null),
  });
}

function parseThreadStateFilter(raw: string | undefined): ThreadStateFilter | null {
  if (raw === undefined || raw === '') return 'open';
  return raw === 'open' || raw === 'resolved' || raw === 'all' ? raw : null;
}

function countThreadsByState(
  db: Database,
  docUid: string,
  viewerId: string | null,
): { total: number; open: number; resolved: number } {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ${OPEN_THREAD_SQL} THEN 1 ELSE 0 END) AS open
         FROM comments c
         LEFT JOIN comments_edit_proposals cep ON cep.comment_id = c.id
        WHERE c.doc_uid = ?
          AND c.parent_id IS NULL
          AND c.parent_proposal_id IS NULL
          AND c.deleted_at IS NULL
          AND (c.is_hidden = 0 OR c.author_client_id = ?)`,
    )
    .get(docUid, viewerId ?? '') as { total: number; open: number | null };
  const open = row.open ?? 0;
  return { total: row.total, open, resolved: row.total - open };
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
  if (body.hidden !== undefined && typeof body.hidden !== 'boolean') {
    return c.json({ error: 'invalid-hidden' }, 400);
  }
  const hidden = body.hidden === true;
  if (hidden && proposal) return c.json({ error: 'hidden-proposal-forbidden' }, 400);
  const storedRootBody = proposal ? (rootBody.body ?? DEFAULT_PROPOSAL_BODY) : rootBody.body;

  if (!proposal) {
    if (!canComment(decision.role)) return c.json({ error: 'forbidden' }, 403);
    if (!rootBody.body) return c.json({ error: 'body-required' }, 400);
  } else {
    if (!canPropose(decision.role)) return c.json({ error: 'forbidden' }, 403);
    for (const answeredId of proposal.answersThreadIds) {
      if (!isAnswerableThread(db, doc.uid, answeredId, identity.clientId)) {
        return c.json({ error: 'answers-thread-not-found' }, 400);
      }
    }
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
          body, is_hidden, link_status, resolved_at, resolved_by_name,
          created_at, updated_at, deleted_at)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', NULL, NULL, ?, ?, NULL)`,
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
      hidden ? 1 : 0,
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
      const linkAnswer = db.prepare(
        `INSERT INTO comments_edit_proposal_answers
           (proposal_comment_id, answered_comment_id)
         VALUES (?, ?)`,
      );
      for (const answeredId of proposal.answersThreadIds) linkAnswer.run(id, answeredId);
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
  const mentionTargets = hidden
    ? []
    : storeMentionsForComment(db, doc.uid, id, rootComment.body, rootComment.author_display_name);

  if (hidden) {
    // Private threads never enter the document-wide realtime channel.
  } else if (proposal && isProposalRow(root)) {
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
  if (!canViewThread(proposal, decision.identity)) return c.json({ error: 'not-found' }, 404);

  const diff = await resolveProposalDiff(doc, proposal, deps);
  if (!diff) return c.json({ error: 'proposal-diff-unavailable' }, 410);

  let mergeable: 'clean' | 'conflict' | 'stale' | 'unavailable' | null = null;
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
    // can no longer be applied as-is and needs a rebase. `unavailable`
    // stays distinct: nothing is wrong with the proposal, the server
    // just can't run the merge.
    mergeable =
      status === 'clean' || status === 'conflict' || status === 'unavailable' ? status : 'stale';
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
  if (!canViewThread(row, identity)) return c.json({ error: 'not-found' }, 404);
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

      const rendered = await renderDocumentCached(preview.before, doc.format);
      const blocks = locateDocumentBlocks(doc, preview.before);
      anchor = locateProposalAnchorBySourceSpan(
        blocks,
        rendered.blocks,
        preview.before,
        changed.beforeStart,
        changed.beforeEnd,
        doc.format,
      );
      linkStatus = anchor?.linkStatus ?? null;
    } else if (preview.reason === 'unavailable') {
      // Recording 'conflict' here would pin a permanent conflict badge on
      // a proposal whose merge was never actually attempted.
      return c.json({ error: 'proposal-merge-unavailable' }, 503);
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
 * Edits the root of a thread: the root comment body (a proposal's
 * rationale or a plain thread's opener), a proposal's proposed text, or
 * both in one request. Root-body edits are author-only; an admin may
 * revise another author's proposed text without replacing their words.
 *
 * A `proposal.proposed_text` update rebuilds the proposal branch against
 * *current* main — the revision targets the source the actor just read —
 * so it doubles as a rebase: a conflicted or stale
 * proposal comes back cleanly appliable while the thread keeps its id,
 * discussion, links and reactions instead of being deleted and
 * re-created.
 *
 * An optional `comment` (proposal updates only) is posted as a reply in
 * the same request — the revision note lives in the discussion, where it
 * survives later rewrites. It is NOT the branch commit message: that
 * embeds the rationale and is rebuilt wholesale on every update.
 */
async function editThreadRoot(c: Context, deps: AppDeps) {
  const { db, realtime, store } = deps;
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
  if (!canViewThread(row, identity)) return c.json({ error: 'not-found' }, 404);
  const isAuthor = row.author_client_id === identity.clientId;
  const isAdmin = decision.role === 'admin';
  if (!isAuthor && !isAdmin) return c.json({ error: 'forbidden' }, 403);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  const next = parseThreadRootBody(body.body, isProposalRow(row));
  if (!next.ok) return c.json({ error: 'invalid-body' }, 400);
  const parsedUpdate = asProposalUpdate(body.proposal);
  if (!parsedUpdate.ok) return c.json({ error: parsedUpdate.error }, 400);
  const proposalUpdate = parsedUpdate.update;
  if (body.hidden !== undefined && typeof body.hidden !== 'boolean') {
    return c.json({ error: 'invalid-hidden' }, 400);
  }
  const nextHidden: boolean | undefined =
    typeof body.hidden === 'boolean' ? body.hidden : undefined;
  if (nextHidden !== undefined && isProposalRow(row)) {
    return c.json({ error: 'hidden-proposal-forbidden' }, 400);
  }
  if (nextHidden !== undefined && !isAuthor) return c.json({ error: 'forbidden' }, 403);
  const parsedComment = parseOptionalBody(body.comment);
  if (!parsedComment.ok) return c.json({ error: 'invalid-body' }, 400);
  const revisionComment = parsedComment.body;
  // A revision note without a revision has no meaning here — plain
  // replies go through POST /respond.
  if (revisionComment && !proposalUpdate) {
    return c.json({ error: 'comment-requires-proposal' }, 400);
  }
  if (next.body === undefined && !proposalUpdate && nextHidden === undefined) {
    return c.json({ error: 'body-required' }, 400);
  }
  // Admins may revise somebody else's proposal, but the original
  // rationale/opener remains the author's own words. An admin revision
  // note belongs in `comment`, where it is attributed to the admin.
  // Keep this after the shared payload validation above so malformed
  // requests have the same error semantics for authors and admins.
  if (!isAuthor && next.body !== undefined) return c.json({ error: 'forbidden' }, 403);

  let branchUpdate: { baseOid: string; rangeStart: number; rangeEnd: number } | null = null;
  // The old tip's full source, so a failed DB write can put the branch
  // back instead of leaving git and the stored splice range disagreeing.
  let previousTipSource: string | null = null;
  if (proposalUpdate) {
    if (!isProposalRow(row)) return c.json({ error: 'proposal-required' }, 400);
    if (row.proposal_status !== 'open') return c.json({ error: 'not-open' }, 400);
    if (!canPropose(decision.role)) return c.json({ error: 'forbidden' }, 403);
    if (row.branch_ref !== `refs/proposals/${row.id}` || !row.base_oid) {
      return c.json({ error: 'proposal-update-unavailable' }, 409);
    }

    const target = await readProposalRebaseTarget(deps, doc, row, identity);
    if (!target.ok) return c.json({ error: target.error }, target.status);
    const { baseOid, currentSource, blockRange } = target;
    previousTipSource = target.previousTipSource;

    if (next.body === undefined && baseOid === row.base_oid) {
      const current = await readProposalContent(store, doc, row);
      if (current && current.proposed_text === proposalUpdate.proposedText) {
        // Same base, same text — nothing would change; skip the branch
        // rewrite instead of minting an identical commit. A revision
        // comment still lands as a reply rather than being dropped.
        let noopReply: { reply: CommentRow; mentionTargets: string[]; hidden: boolean } | null =
          null;
        if (revisionComment) {
          db.exec('BEGIN');
          try {
            noopReply = insertThreadReply(db, doc.uid, row, revisionComment, identity);
            db.exec('COMMIT');
          } catch (err) {
            db.exec('ROLLBACK');
            throw err;
          }
          broadcastReplyCreated(deps, doc.uid, noopReply, identity);
        }
        const replies = loadReplies(db, doc.uid, tid);
        const reopenableAccepted = await loadReopenableAcceptedThreadIds(doc, deps, [row]);
        return c.json({
          thread: await toThreadWire(db, store, doc, row, replies, decision, reopenableAccepted),
          created_reply_id: noopReply?.reply.id ?? null,
        });
      }
    }

    try {
      await store.createProposalBranch(
        doc,
        baseOid,
        row.id,
        currentSource.slice(0, blockRange.start) +
          proposalUpdate.proposedText +
          currentSource.slice(blockRange.end),
        identity,
        next.body !== undefined ? next.body : row.body,
      );
    } catch (err) {
      console.warn(`[marginalia] proposal-branch rewrite failed for ${tid} (${doc.uid}):`, err);
      return c.json({ error: 'proposal-storage-unavailable' }, 503);
    }
    branchUpdate = { baseOid, rangeStart: blockRange.start, rangeEnd: blockRange.end };
  }

  const now = Date.now();
  let createdReply: { reply: CommentRow; mentionTargets: string[]; hidden: boolean } | null = null;
  db.exec('BEGIN');
  try {
    if (branchUpdate) {
      db.prepare(
        `UPDATE comments_edit_proposals
            SET base_oid = ?, base_block_start = ?, base_block_end = ?
          WHERE comment_id = ?`,
      ).run(branchUpdate.baseOid, branchUpdate.rangeStart, branchUpdate.rangeEnd, tid);
      // The rebuilt branch targets exactly this range of current main,
      // so any earlier 'conflict'/'low-confidence' state is resolved by
      // construction.
      db.prepare(`UPDATE comments SET link_status = 'linked', updated_at = ? WHERE id = ?`).run(
        now,
        tid,
      );
    }
    if (next.body !== undefined) {
      db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(
        next.body,
        now,
        tid,
      );
    }
    if (nextHidden !== undefined) {
      db.prepare('UPDATE comments SET is_hidden = ?, updated_at = ? WHERE id = ?').run(
        nextHidden ? 1 : 0,
        now,
        tid,
      );
      if (nextHidden) {
        // A private thread cannot notify people who are no longer allowed
        // to read it. Remove undelivered mentions from its whole discussion.
        db.prepare(
          `DELETE FROM comment_mentions
            WHERE doc_uid = ?
              AND comment_id IN (
                SELECT id FROM comments
                 WHERE doc_uid = ?
                   AND (id = ? OR parent_id = ? OR parent_proposal_id = ?)
              )
              AND delivered_at IS NULL`,
        ).run(doc.uid, doc.uid, tid, tid, tid);
      }
    }
    if (revisionComment) {
      createdReply = insertThreadReply(db, doc.uid, row, revisionComment, identity);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    if (branchUpdate && isProposalRow(row) && row.base_oid) {
      const undo =
        previousTipSource !== null
          ? store.createProposalBranch(
              doc,
              row.base_oid,
              tid,
              previousTipSource,
              identity,
              row.body,
            )
          : store.deleteProposalBranch(doc, tid);
      await undo.catch(() => undefined);
    }
    throw err;
  }

  const updated = loadThreadRow(db, tid, doc.uid);
  if (!updated) return c.json({ error: 'not-found' }, 404);
  const mentionTargets =
    next.body !== undefined && updated.is_hidden === 0
      ? storeMentionsForComment(db, doc.uid, updated.id, updated.body, updated.author_display_name)
      : [];

  if (createdReply) broadcastReplyCreated(deps, doc.uid, createdReply, identity);
  const visibilityChanged = row.is_hidden !== updated.is_hidden;
  if (updated.is_hidden === 1) {
    if (visibilityChanged) {
      realtime.broadcast(
        doc.uid,
        { type: 'comment.deleted', comment_id: updated.id },
        identity.clientId,
      );
    }
  } else if (visibilityChanged) {
    realtime.broadcast(
      doc.uid,
      { type: 'comment.created', comment: toLegacyCommentWire(updated) },
      identity.clientId,
    );
  } else if (isProposalRow(updated)) {
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
    created_reply_id: createdReply?.reply.id ?? null,
  });
}

/**
 * Pin a proposal as conflicted so every viewer sees the badge and the
 * resolver, rather than only the person whose accept just bounced.
 * Leaves the anchor alone — the text conflicts, the anchor is fine.
 */
function markProposalConflicted(
  deps: AppDeps,
  doc: DocumentRow,
  row: ThreadRow,
  identity: Identity,
): void {
  if (row.link_status === 'conflict') return;
  const now = Date.now();
  deps.db
    .prepare(`UPDATE comments SET link_status = 'conflict', updated_at = ? WHERE id = ?`)
    .run(now, row.id);
  const updated = loadProposalRow(deps.db, row.id, doc.uid);
  if (!updated) return;
  deps.realtime.broadcast(
    doc.uid,
    { type: 'edit_proposal.updated', edit_proposal: toProposalWire(updated) },
    identity.clientId,
  );
}

type RebaseTargetResult =
  | {
      ok: true;
      /** Current main — what the rebuilt branch will be parented at. */
      baseOid: string;
      currentSource: string;
      /** Where in `currentSource` the proposal's text belongs. */
      blockRange: BlockSourceRange;
      /** The old tip, so a failed DB write can put the branch back. */
      previousTipSource: string | null;
    }
  | { ok: false; status: 409 | 503; error: string };

/**
 * Locate where a proposal's text would land in the source as it stands
 * now. Rebuilding the branch on top of that is what rebases a proposal:
 * both the in-place update and conflict resolution mean "this is what
 * the proposal should say against current main", and neither can splice
 * without this range.
 *
 * Reads main's oid and its source in that order so a concurrent accept
 * can't land between them and leave the range addressing a source the
 * commit doesn't contain.
 */
async function readProposalRebaseTarget(
  deps: AppDeps,
  doc: DocumentRow,
  row: ThreadRow,
  identity: Identity,
): Promise<RebaseTargetResult> {
  const { db, realtime, store } = deps;
  const anchorBlockId = row.anchor_block_id;
  if (row.is_whole_document !== 1 && (row.link_status === 'orphaned' || !anchorBlockId)) {
    return { ok: false, status: 409, error: 'proposal-orphaned' };
  }

  let baseOid: string;
  let currentSource: string;
  let previousTipSource: string | null;
  try {
    baseOid = await store.mainOid(doc);
    currentSource = await store.readAt(doc, baseOid);
    previousTipSource = await store.readProposalTip(doc, row.id);
  } catch (err) {
    console.warn(`[marginalia] reading base for proposal ${row.id} (${doc.uid}) failed:`, err);
    return { ok: false, status: 503, error: 'proposal-storage-unavailable' };
  }

  let blockRange: BlockSourceRange | null;
  if (row.is_whole_document === 1 || !anchorBlockId) {
    blockRange = { start: 0, end: currentSource.length, kind: 'multi', text: '' };
  } else {
    blockRange = locateAnchorRange(doc, currentSource, anchorBlockId, row.anchor_end_block_id);
  }
  if (!blockRange) {
    // The anchor died since the last orphan sweep; record that (as the
    // accept path does) rather than fail with a state clients can't see.
    const now = Date.now();
    db.prepare(
      `UPDATE comments
          SET link_status = 'orphaned', anchor_block_id = NULL, anchor_end_block_id = NULL,
              updated_at = ?
        WHERE id = ?`,
    ).run(now, row.id);
    const orphaned = loadProposalRow(db, row.id, doc.uid);
    if (orphaned) {
      realtime.broadcast(
        doc.uid,
        { type: 'edit_proposal.updated', edit_proposal: toProposalWire(orphaned) },
        identity.clientId,
      );
    }
    return { ok: false, status: 409, error: 'proposal-orphaned' };
  }

  return { ok: true, baseOid, currentSource, blockRange, previousTipSource };
}

/**
 * The three sides of a proposal's merge, scoped the way the proposal
 * is: one block for a block proposal, the whole file for a
 * whole-document one.
 *
 * Scoping matters for more than display. A block proposal only ever
 * rewrites its own block, so merging the whole file would drag in
 * unrelated edits elsewhere as context and report conflicts the
 * proposal has no part in. It also makes the resolved text directly
 * usable: it is exactly what the branch rebuild splices back.
 */
async function readProposalConflictSides(
  deps: AppDeps,
  doc: DocumentRow,
  row: ThreadRow,
): Promise<
  | { ok: true; sides: ThreeWaySides; scope: 'block' | 'document' }
  | { ok: false; status: 409 | 503; error: string }
> {
  const content = await readProposalContent(deps.store, doc, row);
  if (!content) return { ok: false, status: 409, error: 'proposal-diff-unavailable' };

  const wholeDocument = row.is_whole_document === 1;
  let currentSource: string;
  try {
    currentSource = deps.store.read(doc);
  } catch (err) {
    console.warn(`[marginalia] reading source for proposal ${row.id} (${doc.uid}) failed:`, err);
    return { ok: false, status: 503, error: 'proposal-storage-unavailable' };
  }

  let current: string;
  if (wholeDocument) {
    current = currentSource;
  } else {
    const anchorBlockId = row.anchor_block_id;
    if (row.link_status === 'orphaned' || !anchorBlockId) {
      return { ok: false, status: 409, error: 'proposal-orphaned' };
    }
    const range = locateAnchorRange(doc, currentSource, anchorBlockId, row.anchor_end_block_id);
    if (!range) return { ok: false, status: 409, error: 'proposal-orphaned' };
    current = currentSource.slice(range.start, range.end);
  }

  return {
    ok: true,
    scope: wholeDocument ? 'document' : 'block',
    sides: { current, base: content.source_snapshot, proposed: content.proposed_text },
  };
}

/**
 * `GET /:uid/threads/:tid/conflict`
 *
 * The three-way state of an open proposal against the document as it
 * stands: what it was written against, what the document says now, and
 * what it asks for — plus either the merge git can do unaided, or the
 * hunks it can't.
 *
 * A pure read. Resolving is a separate, explicit POST, so opening the
 * resolver never mints a commit on somebody's proposal branch.
 */
async function getThreadConflict(c: Context, deps: AppDeps) {
  const { db } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  // Merging costs the per-document lock. Gate it on being able to act on
  // the result, so a reader can't force the work by polling.
  if (!canPropose(decision.role) && !canEdit(decision.role)) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const tid = c.req.param('tid');
  if (!tid) return c.json({ error: 'not-found' }, 404);
  const row = loadProposalRow(db, tid, doc.uid);
  if (!row) return c.json({ error: 'proposal-required' }, 400);
  if (!canViewThread(row, decision.identity)) return c.json({ error: 'not-found' }, 404);
  if (row.proposal_status !== 'open') return c.json({ error: 'not-open' }, 400);

  const sides = await readProposalConflictSides(deps, doc, row);
  if (!sides.ok) return c.json({ error: sides.error }, sides.status);

  const merged = await mergeThreeWay(sides.sides);
  if (!merged.ok && merged.reason === 'unavailable') {
    return c.json({ error: 'proposal-merge-unavailable' }, 503);
  }

  return c.json({
    scope: sides.scope,
    status: merged.ok ? 'clean' : 'conflict',
    ...sides.sides,
    merged: merged.ok ? merged.text : null,
    segments: merged.ok ? null : merged.segments,
    /** True when the merge leaves the document exactly as it already is. */
    empty: merged.ok && merged.text === sides.sides.current,
  });
}

/**
 * `POST /:uid/threads/:tid/resolve`
 *
 * Settle a proposal against current main and rebuild its branch there,
 * so a later accept is an ordinary fast-forward. With `resolved_text`
 * the caller has decided; without it the server takes the merge git can
 * make on its own and refuses if there isn't one.
 *
 * This is the same branch rewrite an in-place update does, under
 * different authority: resolving a conflict is part of merging a
 * proposal, so anyone who could accept it may resolve it — not only the
 * author, who may be long gone by the time the document moves.
 */
async function resolveThreadConflict(c: Context, deps: AppDeps) {
  const { db, realtime, store } = deps;
  const doc = loadDoc(db, c.req.param('uid'));
  if (!doc) return c.json({ error: 'not-found' }, 404);

  const decision = authorizeRequest(c, deps, doc);
  if (!decision.ok) return c.json({ error: decision.reason }, 401);
  if (!decision.identity) return c.json({ error: 'identity-required' }, 400);
  const identity = decision.identity;

  const tid = c.req.param('tid');
  if (!tid) return c.json({ error: 'not-found' }, 404);
  const row = loadProposalRow(db, tid, doc.uid);
  if (!row) return c.json({ error: 'proposal-required' }, 400);
  if (!canViewThread(row, identity)) return c.json({ error: 'not-found' }, 404);
  if (row.proposal_status !== 'open') return c.json({ error: 'not-open' }, 400);

  const isAuthor = row.author_client_id === identity.clientId;
  const mayResolve = canEdit(decision.role) || (isAuthor && canPropose(decision.role));
  if (!mayResolve) return c.json({ error: 'forbidden' }, 403);
  if (row.branch_ref !== `refs/proposals/${row.id}` || !row.base_oid) {
    return c.json({ error: 'proposal-update-unavailable' }, 409);
  }

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  const parsedResolution = parseResolvedText(body.resolved_text);
  if (!parsedResolution.ok) return c.json({ error: parsedResolution.error }, 400);
  const parsedComment = parseOptionalBody(body.comment);
  if (!parsedComment.ok) return c.json({ error: 'invalid-body' }, 400);
  const resolutionComment = parsedComment.body;

  // One read of the source serves both the merge and the splice. Taking
  // them separately would leave a window where a save lands in between,
  // and the resolution — merged against the source as it was — would be
  // spliced over a block nobody in this exchange has seen.
  const target = await readProposalRebaseTarget(deps, doc, row, identity);
  if (!target.ok) return c.json({ error: target.error }, target.status);
  const { baseOid, currentSource, blockRange, previousTipSource } = target;

  const content = await readProposalContent(store, doc, row);
  if (!content) return c.json({ error: 'proposal-diff-unavailable' }, 409);
  const current = currentSource.slice(blockRange.start, blockRange.end);

  let resolvedText: string;
  if (parsedResolution.text !== undefined) {
    resolvedText = parsedResolution.text;
  } else {
    const merged = await mergeThreeWay({
      current,
      base: content.source_snapshot,
      proposed: content.proposed_text,
    });
    if (!merged.ok) {
      if (merged.reason === 'unavailable') {
        return c.json({ error: 'proposal-merge-unavailable' }, 503);
      }
      // Nothing to apply unattended — the caller has to pick a side.
      return c.json({ error: 'proposal-conflict' }, 409);
    }
    resolvedText = merged.text;
  }

  // A resolution that matches the document leaves nothing to accept.
  // Rebuilding the branch anyway would produce a proposal whose diff is
  // empty and whose accept is a no-op, which reads as a broken button.
  if (resolvedText === current) {
    return c.json({ error: 'proposal-resolution-empty' }, 409);
  }

  try {
    await store.createProposalBranch(
      doc,
      baseOid,
      row.id,
      currentSource.slice(0, blockRange.start) + resolvedText + currentSource.slice(blockRange.end),
      identity,
      row.body,
    );
  } catch (err) {
    console.warn(`[marginalia] proposal-branch rewrite failed for ${tid} (${doc.uid}):`, err);
    return c.json({ error: 'proposal-storage-unavailable' }, 503);
  }

  const now = Date.now();
  let createdReply: { reply: CommentRow; mentionTargets: string[]; hidden: boolean } | null = null;
  db.exec('BEGIN');
  try {
    db.prepare(
      `UPDATE comments_edit_proposals
          SET base_oid = ?, base_block_start = ?, base_block_end = ?
        WHERE comment_id = ?`,
    ).run(baseOid, blockRange.start, blockRange.end, tid);
    // The rebuilt branch targets exactly this range of current main, so
    // the conflict is gone by construction.
    db.prepare(`UPDATE comments SET link_status = 'linked', updated_at = ? WHERE id = ?`).run(
      now,
      tid,
    );
    if (resolutionComment) {
      createdReply = insertThreadReply(db, doc.uid, row, resolutionComment, identity);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    const undo =
      previousTipSource !== null
        ? store.createProposalBranch(doc, row.base_oid, tid, previousTipSource, identity, row.body)
        : store.deleteProposalBranch(doc, tid);
    await undo.catch(() => undefined);
    throw err;
  }

  const updated = loadThreadRow(db, tid, doc.uid);
  if (!updated) return c.json({ error: 'not-found' }, 404);
  if (createdReply) broadcastReplyCreated(deps, doc.uid, createdReply, identity);
  if (isProposalRow(updated)) {
    realtime.broadcast(
      doc.uid,
      { type: 'edit_proposal.updated', edit_proposal: toProposalWire(updated) },
      identity.clientId,
    );
  }

  const replies = loadReplies(db, doc.uid, tid);
  const reopenableAccepted = await loadReopenableAcceptedThreadIds(doc, deps, [updated]);
  return c.json({
    thread: await toThreadWire(db, store, doc, updated, replies, decision, reopenableAccepted),
    created_reply_id: createdReply?.reply.id ?? null,
  });
}

/**
 * `resolved_text` absent means "merge it for me"; present it must be a
 * string, and an empty one is a real resolution — deleting the block is
 * a legitimate way to settle a conflict.
 */
function parseResolvedText(
  raw: unknown,
): { ok: true; text: string | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, text: undefined };
  if (typeof raw !== 'string') return { ok: false, error: 'invalid-body' };
  if (raw.length > MAX_PROPOSED_TEXT_LENGTH) return { ok: false, error: 'proposal-text-too-long' };
  return { ok: true, text: raw };
}

/**
 * Insert one reply row under a thread root and record its @mentions.
 * Caller owns the surrounding transaction and the post-commit
 * `broadcastReplyCreated`.
 */
function insertThreadReply(
  db: Database,
  docUid: string,
  root: ThreadRow,
  body: string,
  identity: Identity,
): { reply: CommentRow; mentionTargets: string[]; hidden: boolean } {
  const isProposal = isProposalRow(root);
  const id = newCommentId();
  const now = Date.now();
  db.prepare(
    `INSERT INTO comments
       (id, doc_uid, parent_id, parent_proposal_id,
        author_client_id, author_display_name,
        body, link_status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'linked', ?, ?)`,
  ).run(
    id,
    docUid,
    isProposal ? null : root.id,
    isProposal ? root.id : null,
    identity.clientId,
    identity.displayName,
    body,
    now,
    now,
  );
  const reply = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow;
  const hidden = root.is_hidden === 1;
  const mentionTargets = hidden
    ? []
    : storeMentionsForComment(db, docUid, reply.id, reply.body, reply.author_display_name);
  return { reply, mentionTargets, hidden };
}

function broadcastReplyCreated(
  deps: AppDeps,
  docUid: string,
  created: { reply: CommentRow; mentionTargets: string[]; hidden: boolean },
  identity: Identity,
): void {
  if (created.hidden) return;
  deps.realtime.broadcast(
    docUid,
    { type: 'comment.created', comment: toLegacyCommentWire(created.reply) },
    identity.clientId,
  );
  if (created.mentionTargets.length > 0) {
    deps.realtime.broadcastToDisplayNames(
      docUid,
      created.mentionTargets,
      { type: 'mention.created', comment: toLegacyCommentWire(created.reply) },
      identity.clientId,
    );
  }
}

/**
 * `DELETE /:uid/threads/:tid`
 *
 * Soft-deletes a root thread and all of its replies. Accepted proposal
 * threads are admin-delete only; document history is unaffected either
 * way — the accept commit stays on main and `loadAcceptedProposalHistory`
 * reads soft-deleted rows.
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
  if (!canViewThread(row, decision.identity)) return c.json({ error: 'not-found' }, 404);

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
    // Keep the branch ref for accepted proposals: history summaries may
    // still read the tip, and for a 3-way accept the ref is the only
    // thing keeping the authored tip reachable.
    if (row.branch_ref && row.proposal_status !== 'accepted') {
      await deps.store.deleteProposalBranch(doc, row.id).catch(() => undefined);
    }
    realtime.broadcast(
      doc.uid,
      { type: 'edit_proposal.deleted', edit_proposal_id: tid },
      decision.identity.clientId,
    );
  } else if (row.is_hidden === 0) {
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
  if (!canViewThread(thread, decision.identity)) return c.json({ error: 'not-found' }, 404);

  const cid = c.req.param('cid');
  if (!cid) return c.json({ error: 'not-found' }, 404);
  const reply = loadReplyRow(db, doc.uid, tid, cid);
  if (!reply) return c.json({ error: 'not-found' }, 404);
  if (!canViewComment(reply, decision.identity)) return c.json({ error: 'not-found' }, 404);
  if (reply.author_client_id !== decision.identity.clientId) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  if (body.hidden !== undefined && typeof body.hidden !== 'boolean') {
    return c.json({ error: 'invalid-hidden' }, 400);
  }
  const nextHidden = typeof body.hidden === 'boolean' ? body.hidden : undefined;
  const next = parseOptionalBody(body.body);
  if (!next.ok) return c.json({ error: 'invalid-body' }, 400);
  if (!next.body && nextHidden === undefined) return c.json({ error: 'body-required' }, 400);

  const now = Date.now();
  db.exec('BEGIN');
  try {
    if (next.body) {
      db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(
        next.body,
        now,
        cid,
      );
    }
    if (nextHidden !== undefined) {
      db.prepare('UPDATE comments SET is_hidden = ?, updated_at = ? WHERE id = ?').run(
        nextHidden ? 1 : 0,
        now,
        cid,
      );
      if (nextHidden) {
        db.prepare(
          `DELETE FROM comment_mentions
            WHERE doc_uid = ?
              AND comment_id = ?
              AND delivered_at IS NULL`,
        ).run(doc.uid, cid);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const updatedReply = loadReplyRow(db, doc.uid, tid, cid);
  if (!updatedReply) return c.json({ error: 'not-found' }, 404);
  const mentionTargets =
    !next.body || thread.is_hidden === 1 || updatedReply.is_hidden === 1
      ? []
      : storeMentionsForComment(
          db,
          doc.uid,
          updatedReply.id,
          updatedReply.body,
          updatedReply.author_display_name,
        );

  if (thread.is_hidden === 0) {
    const visibilityChanged = reply.is_hidden !== updatedReply.is_hidden;
    if (visibilityChanged && updatedReply.is_hidden === 1) {
      realtime.broadcast(
        doc.uid,
        { type: 'comment.deleted', comment_id: updatedReply.id },
        decision.identity.clientId,
      );
    } else if (visibilityChanged) {
      realtime.broadcast(
        doc.uid,
        { type: 'comment.created', comment: toLegacyCommentWire(updatedReply) },
        decision.identity.clientId,
      );
    } else if (updatedReply.is_hidden === 0) {
      realtime.broadcast(
        doc.uid,
        { type: 'comment.updated', comment: toLegacyCommentWire(updatedReply) },
        decision.identity.clientId,
      );
    }
  }
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
  if (!canViewThread(thread, decision.identity)) return c.json({ error: 'not-found' }, 404);

  const cid = c.req.param('cid');
  if (!cid) return c.json({ error: 'not-found' }, 404);
  const reply = loadReplyRow(db, doc.uid, tid, cid);
  if (!reply) return c.json({ error: 'not-found' }, 404);
  if (!canViewComment(reply, decision.identity)) return c.json({ error: 'not-found' }, 404);

  const isAuthor = reply.author_client_id === decision.identity.clientId;
  const isAdmin = decision.role === 'admin';
  if (!isAuthor && !isAdmin) return c.json({ error: 'forbidden' }, 403);

  db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(Date.now(), cid);
  if (thread.is_hidden === 0 && reply.is_hidden === 0) {
    realtime.broadcast(
      doc.uid,
      { type: 'comment.deleted', comment_id: cid },
      decision.identity.clientId,
    );
  }
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
  if (!canViewThread(thread, identity)) return c.json({ error: 'not-found' }, 404);
  const target = loadThreadNode(db, doc.uid, tid, cid);
  if (!target) return c.json({ error: 'not-found' }, 404);
  if (!canViewComment(target, identity)) return c.json({ error: 'not-found' }, 404);

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
  if (thread.is_hidden === 0 && target.is_hidden === 0) {
    realtime.broadcast(
      doc.uid,
      { type: 'comment.updated', comment: toLegacyCommentWire(target) },
      identity.clientId,
    );
  }

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
  if (!canViewThread(row, identity)) return c.json({ error: 'not-found' }, 404);

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
  // Filled when accepting a proposal also closes the comment threads it
  // was written to answer.
  let resolvedAnsweredThreadIds: string[] = [];
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
      resolvedAnsweredThreadIds = resolveAnsweredThreads(db, doc.uid, row, identity);
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
      const created = insertThreadReply(db, doc.uid, row, replyBody.body, identity);
      createdReplyId = created.reply.id;
      createdReply = created.reply;
      createdReplyMentionTargets = created.mentionTargets;
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
    broadcastReplyCreated(
      deps,
      doc.uid,
      {
        reply: createdReply,
        mentionTargets: createdReplyMentionTargets,
        hidden: row.is_hidden === 1,
      },
      identity,
    );
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

  if (action && updated.is_hidden === 0) {
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

  for (const answeredId of resolvedAnsweredThreadIds) {
    const answered = loadThreadRow(db, answeredId, doc.uid);
    if (answered && answered.is_hidden === 0) {
      realtime.broadcast(
        doc.uid,
        { type: 'comment.updated', comment: toLegacyCommentWire(answered) },
        identity.clientId,
      );
    }
  }

  // Accepting rewrites the document, and the client used to learn the new
  // text only by re-fetching and re-rendering the whole thing. Both are
  // already in hand here, so hand them back and skip that round trip.
  //
  // Accept only. Reopening an accepted proposal also rewrites the document,
  // but no client reads this field on that path — `resolveThread` keeps just
  // the thread — so building it there would mean an asset rewrite over the
  // whole document and a payload the size of the document, for nothing.
  let documentPayload: { oid: string; source: string; rendered: RenderResult } | null = null;
  if (action === 'accept' && preparedWorkflow && documentOid) {
    const attached = listAttached(db, doc.uid);
    const rendered = preparedWorkflow.rendered;
    rendered.html = await rewriteAssetReferences(rendered.html, {
      docUid: doc.uid,
      attached: new Set(attached.map((a) => a.ref_name)),
      assetVersions: new Map(attached.map((a) => [a.ref_name, a.asset_id])),
    });
    documentPayload = { oid: documentOid, source: preparedWorkflow.nextSource, rendered };
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
    resolved_answered_thread_ids: resolvedAnsweredThreadIds,
    document: documentPayload,
  });
}

/**
 * Accepting a proposal carries out what the comments it answers asked
 * for, so close those comments too rather than leaving requests standing
 * whose fix has already landed. An edit usually rewrites a whole
 * paragraph, so it can settle several of them at once.
 *
 * Only plain comment threads are closed. A proposal thread has its own
 * accepted/rejected lifecycle in `comments_edit_proposals.status`, and
 * setting `resolved_at` on one without touching that would leave the two
 * disagreeing. Already-resolved threads are left alone so the original
 * resolver keeps the credit.
 *
 * Returns the ids it resolved, empty if there was nothing to do.
 */
function resolveAnsweredThreads(
  db: Database,
  docUid: string,
  proposal: ThreadRow,
  identity: Identity,
): string[] {
  const resolved: string[] = [];
  const now = Date.now();
  const close = db.prepare(
    `UPDATE comments
        SET resolved_at = ?, resolved_by_name = ?, updated_at = ?
      WHERE id = ? AND doc_uid = ?`,
  );
  for (const answeredId of parseAnswerIds(proposal.answers_comment_ids)) {
    const answered = loadThreadRow(db, answeredId, docUid);
    if (!answered) continue;
    if (!canViewThread(answered, identity)) continue;
    if (answered.proposal_status !== null) continue;
    if (answered.resolved_at !== null) continue;
    close.run(now, identity.displayName, now, answeredId, docUid);
    resolved.push(answeredId);
  }
  return resolved;
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
      // Record it so the proposal carries a conflict badge and the
      // resolver for everyone, not just whoever happened to click
      // Accept. Safe to pin now that resolving clears it — an
      // `unavailable` merge still must not land here, since that one
      // says nothing about the proposal.
      markProposalConflicted(deps, doc, row, identity);
      throw new ThreadActionError(409, 'proposal-conflict');
    }
    // The merge tool itself is missing or broken — the proposal is fine,
    // so say so instead of blaming it for a conflict it doesn't have.
    if (merge.reason === 'unavailable') {
      throw new ThreadActionError(503, 'proposal-merge-unavailable');
    }
    throw new ThreadActionError(409, 'proposal-orphaned');
  }
  const oid = merge.oid;
  const nextSource = deps.store.read(doc);
  const spliceStart = isWholeDoc
    ? 0
    : locatePostMergeSpliceStart(doc, nextSource, proposedText, preMergeRange.start);

  const rendered = await renderDocumentCopy(nextSource, doc.format);
  const previousBlocks = locateDocumentBlocks(doc, preMergeSource);
  const presentBlocks = locateDocumentBlocks(doc, nextSource);
  const blockReplacements = prepareBlockReplacements({
    before: previousBlocks,
    after: presentBlocks,
  });
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
  // Re-anchor everything first and decide what to write only at the end:
  // the relocation pass below rewrites some of these, so whether an update
  // is a no-op is not settled until it has run.
  const anchorCandidates = topLevelComments.map((comment) => ({
    comment,
    upd: reanchor(comment, rendered.blocks, { blockReplacements }),
  }));

  const acceptedAnchor = locateAcceptedProposalAnchor(
    presentBlocks,
    rendered.blocks,
    spliceStart,
    spliceStart + proposedText.length,
  );
  const postAcceptAnchor = acceptedAnchor ? snapshotPostAcceptAnchor(acceptedAnchor) : null;

  // A proposal can be the answer to a comment whose entire quoted text it
  // replaces. Ordinary quote re-anchoring has no evidence left in that
  // case, even though the proposal gives us an exact old-span -> new-span
  // mapping. Carry the resolved comment onto the resulting paragraph. If
  // its quote survived and stayed fully linked, leave the more precise
  // selection alone; the generic block-transition fallback is deliberately
  // low-confidence, so this exact proposal mapping supersedes it.
  const relocatedAnsweredComments: string[] = [];
  if (postAcceptAnchor) {
    for (const answeredId of parseAnswerIds(row.answers_comment_ids)) {
      const upd = anchorCandidates.find((c) => c.comment.id === answeredId)?.upd;
      if (!upd || upd.linkStatus === 'linked') continue;
      upd.linkStatus = postAcceptAnchor.linkStatus;
      upd.blockId = postAcceptAnchor.blockId;
      upd.endBlockId = null;
      upd.startOffset = postAcceptAnchor.startOffset;
      upd.endOffset = postAcceptAnchor.endOffset;
      upd.quote = postAcceptAnchor.quote;
      relocatedAnsweredComments.push(answeredId);
    }
  }

  // Now that relocation has had its say, drop the rows that did not move —
  // see `anchorUnchanged`. A comment the proposal answers is typically
  // already orphaned, so re-anchoring alone leaves it untouched; filtering
  // before the pass above would have hidden it from the re-home.
  const commentAnchorUpdates = anchorCandidates
    .filter(({ comment, upd }) => !anchorUnchanged(comment, upd))
    .map(({ comment, upd }) => ({ commentId: comment.id, ...upd }));

  return {
    oid,
    nextSource,
    rendered,
    applyDb: () => {
      const now = Date.now();
      deps.db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(now, doc.uid);

      const updateCommentStmt = deps.db.prepare(REANCHOR_COMMENT_SQL);
      for (const upd of commentAnchorUpdates) {
        updateCommentStmt.run(...reanchorParams(upd, now, upd.commentId));
      }

      if (postAcceptAnchor && relocatedAnsweredComments.length > 0) {
        const carryAnchor = deps.db.prepare(
          `UPDATE comments
              SET anchor_prefix = '',
                  anchor_suffix = '',
                  anchor_heading_path = ?,
                  anchor_section_index = ?,
                  anchor_section_index_path = ?
            WHERE id = ?`,
        );
        for (const answeredId of relocatedAnsweredComments) {
          carryAnchor.run(
            postAcceptAnchor.headingPath,
            postAcceptAnchor.sectionIndex,
            postAcceptAnchor.sectionIndexPath,
            answeredId,
          );
        }
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
                anchor_quote = ?,
                anchor_prefix = ?,
                anchor_suffix = ?,
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
          postAcceptAnchor?.blockId ?? row.anchor_block_id,
          postAcceptAnchor?.quote ?? row.anchor_quote,
          postAcceptAnchor ? '' : row.anchor_prefix,
          postAcceptAnchor ? '' : row.anchor_suffix,
          postAcceptAnchor?.startOffset ?? row.anchor_start_offset,
          postAcceptAnchor?.endOffset ?? row.anchor_end_offset,
          postAcceptAnchor?.headingPath ?? row.anchor_heading_path,
          postAcceptAnchor?.sectionIndex ?? row.anchor_section_index,
          postAcceptAnchor?.sectionIndexPath ?? row.anchor_section_index_path,
          postAcceptAnchor?.linkStatus ?? row.link_status,
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

  const history = await deps.store.history(doc, { depth: 2 });
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

  const rendered = await renderDocumentCached(diff.before, doc.format);
  const previousBlocks = locateDocumentBlocks(doc, diff.after);
  const knownBlocks = locateDocumentBlocks(doc, diff.before);
  const blockReplacements = prepareBlockReplacements({
    before: previousBlocks,
    after: knownBlocks,
  });
  const topLevel = deps.db.prepare(TOP_LEVEL_COMMENTS_SQL).all(doc.uid) as TopLevelCommentRow[];
  const commentAnchorUpdates = topLevel.flatMap((comment) => {
    const upd = reanchor(comment, rendered.blocks, {
      isEditProposal: comment.is_edit_proposal === 1,
      blockReplacements,
    });
    // Skip the rows that did not move — see `anchorUnchanged`.
    if (anchorUnchanged(comment, upd)) return [];
    return [{ commentId: comment.id, ...upd }];
  });

  const restoredProposalAnchor =
    row.base_block_start !== null && row.base_block_end !== null
      ? locateProposalAnchorBySourceSpan(
          knownBlocks,
          rendered.blocks,
          diff.before,
          row.base_block_start,
          row.base_block_end,
          doc.format,
        )
      : null;
  return {
    oid,
    nextSource: diff.before,
    rendered,
    applyDb: () => {
      const now = Date.now();
      deps.db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(now, doc.uid);

      const updateStmt = deps.db.prepare(REANCHOR_COMMENT_SQL);
      for (const upd of commentAnchorUpdates) {
        updateStmt.run(...reanchorParams(upd, now, upd.commentId));
      }

      if (restoredProposalAnchor) {
        deps.db
          .prepare(
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
              WHERE id = ?`,
          )
          .run(
            restoredProposalAnchor.block.id,
            restoredProposalAnchor.endBlock?.id ?? null,
            restoredProposalAnchor.quote,
            JSON.stringify(restoredProposalAnchor.block.headingPath),
            restoredProposalAnchor.block.sectionIndex,
            JSON.stringify(restoredProposalAnchor.block.sectionIndexPath),
            restoredProposalAnchor.linkStatus,
            now,
            row.id,
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

/** Hidden comments are private even from document admins. */
function canViewComment(row: CommentRow, identity: Identity | null | undefined): boolean {
  return row.is_hidden === 0 || identity?.clientId === row.author_client_id;
}

/** A hidden opener makes its complete thread private. */
function canViewThread(row: CommentRow, identity: Identity | null | undefined): boolean {
  return canViewComment(row, identity);
}

function isThreadIdVisible(
  db: Database,
  docUid: string,
  threadId: string,
  viewerId: string | null,
): boolean {
  const row = db
    .prepare(
      `SELECT 1
         FROM comments
        WHERE id = ?
          AND doc_uid = ?
          AND parent_id IS NULL
          AND parent_proposal_id IS NULL
          AND deleted_at IS NULL
          AND (is_hidden = 0 OR author_client_id = ?)
        LIMIT 1`,
    )
    .get(threadId, docUid, viewerId ?? '');
  return row !== null && row !== undefined;
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

function loadReplies(db: Database, docUid: string, threadId: string): CommentRow[] {
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

/**
 * Replies for the roots being returned, rather than every reply in the
 * document — with the list filtered down to open threads, the discussion
 * under the resolved ones is dead weight.
 *
 * Batches share no thread, so per-thread order survives the concatenation
 * even though the batches themselves are not merged.
 */
function loadRepliesForThreads(db: Database, docUid: string, threadIds: string[]): CommentRow[] {
  const replies: CommentRow[] = [];
  for (let i = 0; i < threadIds.length; i += ID_QUERY_BATCH) {
    const batch = threadIds.slice(i, i + ID_QUERY_BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT *
           FROM comments
          WHERE doc_uid = ?
            AND deleted_at IS NULL
            AND (parent_id IN (${placeholders}) OR parent_proposal_id IN (${placeholders}))
          ORDER BY created_at ASC`,
      )
      .all(docUid, ...batch, ...batch) as CommentRow[];
    replies.push(...rows);
  }
  return replies;
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

  const history = await deps.store.history(doc, { depth: 2 });
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
  /**
   * Preloaded reverse index (answered thread id → proposal ids), so
   * listThreads doesn't run one query per thread. Single-thread handlers
   * omit it and pay for one extra query.
   */
  preloadedAnswers?: Map<string, string[]>,
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
  const visibleReplies = replies.filter((reply) =>
    canViewComment(reply, decision.ok ? decision.identity : null),
  );

  const reactionsByComment =
    preloadedReactions ??
    loadCommentReactionsWire(db, doc.uid, [row.id, ...visibleReplies.map((r) => r.id)], viewerId);
  const answeredBy = (preloadedAnswers ?? loadAnswersByThread(db, doc.uid, [row.id], viewerId)).get(
    row.id,
  );
  const answersThreadIds = proposalRow
    ? parseAnswerIds(proposalRow.answers_comment_ids).filter((id) =>
        isThreadIdVisible(db, doc.uid, id, viewerId),
      )
    : [];
  // Closed proposals keep their branch so the dedicated diff endpoint can
  // render the historical change, but the thread list has no use for their
  // editable text: accepted/rejected cards cannot open the proposal editor.
  // Avoid inflating two full document blobs for every archived proposal on
  // every `state=all` refresh. Long-reviewed documents can carry hundreds of
  // closed proposals; reading all of those branches was enough to exhaust the
  // server's memory immediately after an accept, taking the next diff request
  // down with the process.
  const proposalContent =
    proposalRow?.proposal_status === 'open'
      ? await readProposalContent(store, doc, proposalRow)
      : null;

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
      // Change the proposed text in place (author or admin). Orphans need
      // a repair first; a 'conflict' anchor is fine — updating rebuilds
      // the branch against current main, which is exactly what clears it.
      update:
        proposal &&
        state === 'open' &&
        (isRootAuthor || isAdmin) &&
        decision.ok &&
        canPropose(decision.role) &&
        row.branch_ref === `refs/proposals/${row.id}` &&
        row.base_oid !== null &&
        (row.is_whole_document === 1 ||
          (row.link_status !== 'orphaned' && row.anchor_block_id !== null)),
      repair:
        proposal &&
        state === 'open' &&
        decision.ok &&
        canPropose(decision.role) &&
        row.link_status === 'orphaned' &&
        row.is_whole_document !== 1 &&
        row.branch_ref !== null &&
        row.base_oid !== null,
      // Merging a proposal is the accepter's job, so resolving what
      // stands in the way of merging it is too — not the author's alone,
      // who may be gone by the time the document moves under them.
      // Orphans need an anchor before there is anywhere to merge into.
      resolve_conflict:
        proposal &&
        state === 'open' &&
        decision.ok &&
        (canEdit(decision.role) || (isRootAuthor && canPropose(decision.role))) &&
        row.branch_ref === `refs/proposals/${row.id}` &&
        row.base_oid !== null &&
        (row.is_whole_document === 1 ||
          (row.link_status !== 'orphaned' && row.anchor_block_id !== null)),
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
    /**
     * Proposals written to answer this thread, oldest first. Empty for
     * a thread nobody has proposed against — including every proposal
     * thread, which is not itself a request.
     */
    answered_by_thread_ids: answeredBy ?? [],
    proposal: proposalRow
      ? {
          ...(proposalContent ?? {
            source_snapshot: null,
            proposed_text: null,
          }),
          whole_document: proposalRow.is_whole_document === 1,
          /**
           * Root threads this proposal answers, oldest first; empty if
           * it stands alone. Accepting it resolves all of them.
           */
          answers_thread_ids: answersThreadIds,
        }
      : null,
    comments: [
      {
        id: row.id,
        hidden: row.is_hidden === 1,
        body: row.body,
        author: {
          client_id: row.author_client_id,
          display_name: row.author_display_name,
        },
        capabilities: {
          edit: canRootEdit,
          delete: row.proposal_status === 'accepted' ? isAdmin : canRootDelete,
          hide: !proposal && isRootAuthor,
          react: canReply,
        },
        reactions: reactionsByComment.get(row.id) ?? [],
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
      ...visibleReplies.map((reply) => ({
        id: reply.id,
        hidden: reply.is_hidden === 1,
        body: reply.body,
        author: {
          client_id: reply.author_client_id,
          display_name: reply.author_display_name,
        },
        capabilities: {
          edit: viewerId !== null && viewerId === reply.author_client_id,
          delete: (viewerId !== null && viewerId === reply.author_client_id) || isAdmin,
          hide: viewerId !== null && viewerId === reply.author_client_id,
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

// Conservative cap on an `IN (?, ?, …)` list. SQLite's
// `SQLITE_MAX_VARIABLE_NUMBER` is 999 on older builds and 32766 on
// recent ones; 500 is well under the floor and lets us batch without
// caring which build is active. Plus 1 for `doc_uid`.
const ID_QUERY_BATCH = 500;

/**
 * Which proposals answer each thread. One query for the whole page —
 * the UI and the review queue both want "has anything been proposed for
 * this comment yet?", which the per-proposal link list can't answer
 * without reading every proposal in the document.
 */
function loadAnswersByThread(
  db: Database,
  docUid: string,
  threadIds: string[],
  viewerId: string | null,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (threadIds.length === 0) return out;

  // Filter on the requested ids in SQL rather than reading every linked
  // proposal in the document and discarding most of them. For the
  // listThreads page that is the same set either way, but the
  // single-thread handlers ask about exactly one id and shouldn't pay
  // for a document-wide scan.
  for (let i = 0; i < threadIds.length; i += ID_QUERY_BATCH) {
    const batch = threadIds.slice(i, i + ID_QUERY_BATCH);
    const placeholders = batch.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT a.proposal_comment_id, a.answered_comment_id
           FROM comments_edit_proposal_answers a
           JOIN comments c ON c.id = a.proposal_comment_id
          WHERE c.doc_uid = ?
            AND c.deleted_at IS NULL
            AND (c.is_hidden = 0 OR c.author_client_id = ?)
            AND a.answered_comment_id IN (${placeholders})
          ORDER BY a.answered_comment_id, c.created_at ASC, c.rowid ASC`,
      )
      .all(docUid, viewerId ?? '', ...batch) as Array<{
      proposal_comment_id: string;
      answered_comment_id: string;
    }>;
    for (const row of rows) {
      const list = out.get(row.answered_comment_id);
      if (list) list.push(row.proposal_comment_id);
      else out.set(row.answered_comment_id, [row.proposal_comment_id]);
    }
  }
  return out;
}

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
  for (let i = 0; i < commentIds.length; i += ID_QUERY_BATCH) {
    const batch = commentIds.slice(i, i + ID_QUERY_BATCH);
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
  blocks: ReadonlyMap<string, BlockSourceRange>,
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

interface PostAcceptAnchorSnapshot {
  blockId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
  headingPath: string;
  sectionIndex: number;
  sectionIndexPath: string;
  linkStatus: 'linked' | 'low-confidence';
}

/**
 * Turn the paragraph produced by an accepted proposal into a complete new
 * anchor. Keeping the old quote with the new content-hash block id makes the
 * very next document save treat that id as stale and orphan the proposal.
 * Accepted history is recovered from git, so the anchor can (and should)
 * describe the current paragraph instead of doubling as the old snapshot.
 */
function snapshotPostAcceptAnchor({
  block,
  linkStatus,
}: {
  block: BlockInfo;
  linkStatus: 'linked' | 'low-confidence';
}): PostAcceptAnchorSnapshot {
  return {
    blockId: block.id,
    quote: block.text,
    startOffset: 0,
    endOffset: block.text.length,
    headingPath: JSON.stringify(block.headingPath),
    sectionIndex: block.sectionIndex,
    sectionIndexPath: JSON.stringify(block.sectionIndexPath),
    linkStatus,
  };
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

type RepairAnchor = NonNullable<ReturnType<typeof locateProposalAnchorBySourceSpan>>;

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

  const rendered = await renderDocumentCached(currentSource, doc.format);
  const blocks = locateDocumentBlocks(doc, currentSource);
  return locateProposalAnchorBySourceSpan(
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

/**
 * A rewrite settles the requests standing against the text it replaces,
 * and a paragraph can carry a good many. The cap is only there to keep
 * a malformed payload from writing an unbounded number of link rows.
 */
const MAX_ANSWERED_THREADS = 100;

interface ParsedProposal {
  proposedText: string;
  wholeDocument: boolean;
  /** Root threads this proposal answers, validated against the DB by the caller. */
  answersThreadIds: string[];
}

function asProposal(v: unknown):
  | { ok: true; proposal: ParsedProposal | null }
  | {
      ok: false;
      error: 'proposal-text-required' | 'proposal-text-too-long' | 'too-many-answered-threads';
    } {
  if (v === null || v === undefined) return { ok: true, proposal: null };
  if (typeof v !== 'object') return { ok: false, error: 'proposal-text-required' };
  const proposal = v as Record<string, unknown>;
  const proposedText = typeof proposal.proposed_text === 'string' ? proposal.proposed_text : null;
  if (proposedText === null) return { ok: false, error: 'proposal-text-required' };
  if (proposedText.length > MAX_PROPOSED_TEXT_LENGTH) {
    return { ok: false, error: 'proposal-text-too-long' };
  }
  const wholeDocument = proposal.whole_document === true;
  // `answers_thread_id` is the single-link spelling this replaced. Still
  // accepted so a client that predates the list keeps working.
  const single = asString(proposal.answers_thread_id);
  const listed = Array.isArray(proposal.answers_thread_ids)
    ? proposal.answers_thread_ids.filter((id): id is string => typeof id === 'string' && id !== '')
    : [];
  const answersThreadIds = [...new Set(single ? [single, ...listed] : listed)];
  if (answersThreadIds.length > MAX_ANSWERED_THREADS) {
    return { ok: false, error: 'too-many-answered-threads' };
  }
  return {
    ok: true,
    proposal: {
      proposedText,
      wholeDocument,
      answersThreadIds,
    },
  };
}

/**
 * The `proposal` payload of a PATCH: only `proposed_text` is mutable.
 * The anchor, `whole_document`, and `answers_thread_ids` are fixed at
 * create time — moving a proposal is a delete + re-create.
 */
function asProposalUpdate(
  v: unknown,
):
  | { ok: true; update: { proposedText: string } | null }
  | { ok: false; error: 'proposal-text-required' | 'proposal-text-too-long' } {
  if (v === null || v === undefined) return { ok: true, update: null };
  if (typeof v !== 'object') return { ok: false, error: 'proposal-text-required' };
  const proposedText = (v as Record<string, unknown>).proposed_text;
  if (typeof proposedText !== 'string') return { ok: false, error: 'proposal-text-required' };
  if (proposedText.length > MAX_PROPOSED_TEXT_LENGTH) {
    return { ok: false, error: 'proposal-text-too-long' };
  }
  return { ok: true, update: { proposedText } };
}

/**
 * A proposal may name the root threads it answers. Only root threads
 * qualify — a reply is not a request in its own right — and they must
 * live in this document, so a token for one document can't be used to
 * probe ids in another.
 */
function isAnswerableThread(
  db: Database,
  docUid: string,
  threadId: string,
  viewerId: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM comments
        WHERE id = ? AND doc_uid = ?
          AND parent_id IS NULL AND parent_proposal_id IS NULL
          AND deleted_at IS NULL
          AND (is_hidden = 0 OR author_client_id = ?)
        LIMIT 1`,
    )
    .get(threadId, docUid, viewerId);
  return row !== null && row !== undefined;
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
    readonly status: 400 | 409 | 503,
    readonly code: string,
  ) {
    super(code);
  }
}
