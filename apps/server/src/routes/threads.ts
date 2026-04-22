import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import {
  locateAllBlocks,
  locateAllBlocksAsciidoc,
  locateBlockSource,
  renderDocument,
} from '@marginalia/renderer';
import type { BlockInfo, BlockSourceRange } from '@marginalia/renderer';
import type { CommentRow, DocumentRow, EditProposalStatus } from '../db.js';
import {
  authorize,
  canComment,
  canEdit,
  canPropose,
  parseCookie,
  SESSION_COOKIE,
  type Identity,
  type Role,
} from '../auth.js';
import {
  consumePendingMentions,
  listMentionCandidates,
  storeMentionsForComment,
} from '../mentions.js';
import { reanchor } from '../anchoring.js';
import type { AppDeps } from './documents.js';
import {
  loadProposalRow,
  reopenAcceptedProposal,
  reanchorProposals,
  resolveProposalDiffBefore,
  toWire as toProposalWire,
} from './edit-proposals.js';
import { toWire as toLegacyCommentWire } from './comments.js';

interface ThreadRow extends CommentRow {
  anchor_kind: string | null;
  source_snapshot: string | null;
  proposed_text: string | null;
  proposal_status: EditProposalStatus | null;
  accepted_oid: string | null;
  decided_at: number | null;
  decided_by_name: string | null;
}

type ThreadState = 'open' | 'resolved';
type ResolutionKind = 'resolve' | 'accept' | 'reject';
type RespondAction = 'resolve' | 'accept' | 'reject' | 'reopen';

const THREAD_SELECT = `
  SELECT
    c.*,
    cep.anchor_kind,
    cep.source_snapshot,
    cep.proposed_text,
    cep.status AS proposal_status,
    cep.accepted_oid,
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
  r.patch('/:uid/threads/:tid', async (c) => editThreadRoot(c, deps));
  r.delete('/:uid/threads/:tid', async (c) => deleteThread(c, deps));
  r.patch('/:uid/threads/:tid/comments/:cid', async (c) => editThreadReply(c, deps));
  r.delete('/:uid/threads/:tid/comments/:cid', async (c) => deleteThreadReply(c, deps));
  r.post('/:uid/threads/:tid/respond', async (c) => respondToThread(c, deps));

  return r;
}

/**
 * `GET /:uid/threads`
 *
 * Returns every root thread with its replies, optional proposal payload, and
 * server-computed capabilities.
 */
async function listThreads(c: Context, deps: AppDeps) {
  const { db } = deps;
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

  return c.json({
    threads: roots.map((root) =>
      toThreadWire(root, repliesByThread.get(root.id) ?? [], decision, reopenableAccepted),
    ),
    mention_candidates: listMentionCandidates(db, doc.uid),
    pending_mentions: consumePendingMentions(db, doc.uid, decision.identity?.displayName ?? null),
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

  const anchor = asAnchor(body.anchor);
  if (!anchor) return c.json({ error: 'anchor-required' }, 400);

  const rootBody = asOptionalBody(body.body);
  const proposal = asProposal(body.proposal);

  if (!proposal) {
    if (!canComment(decision.role)) return c.json({ error: 'forbidden' }, 403);
    if (!rootBody) return c.json({ error: 'body-required' }, 400);
  } else {
    if (!canPropose(decision.role)) return c.json({ error: 'forbidden' }, 403);
  }

  const id = newCommentId();
  const now = Date.now();
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO comments
         (id, doc_uid, parent_id, parent_proposal_id,
          anchor_block_id, anchor_quote, anchor_prefix, anchor_suffix,
          anchor_start_offset, anchor_end_offset,
          anchor_heading_path, anchor_section_index, anchor_section_index_path,
          author_client_id, author_display_name,
          body, link_status, resolved_at, resolved_by_name,
          created_at, updated_at, deleted_at)
       VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'linked', NULL, NULL, ?, ?, NULL)`,
    ).run(
      id,
      doc.uid,
      anchor.blockId,
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
      proposal ? (rootBody ?? '') : rootBody,
      now,
      now,
    );

    if (proposal) {
      const currentSource = store.read(doc.path);
      const sourceSnapshot = readProposalBlockSource(doc, currentSource, anchor.blockId) ?? anchor.quote;
      db.prepare(
        `INSERT INTO comments_edit_proposals
           (comment_id, anchor_kind, source_snapshot, proposed_text, status, accepted_oid)
         VALUES (?, ?, ?, ?, 'open', NULL)`,
      ).run(id, proposal.anchorKind, sourceSnapshot, proposal.proposedText);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  const root = loadThreadRow(db, id, doc.uid);
  if (!root) return c.json({ error: 'not-found' }, 404);
  const thread = toThreadWire(root, [], decision, new Set<string>());
  const rootComment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id) as CommentRow;
  const mentionTargets = storeMentionsForComment(
    db,
    doc.uid,
    id,
    rootComment.body,
    rootComment.author_display_name,
  );

  if (proposal) {
    realtime.broadcast(
      doc.uid,
      { type: 'edit_proposal.created', edit_proposal: toProposalWire(root as never) },
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
 * `GET /:uid/threads/:tid/diff`
 *
 * Returns the before/after diff payload for a proposal thread.
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

  const before = await resolveProposalDiffBefore(doc, proposal, deps);
  return c.json({ before, after: proposal.proposed_text });
}

/**
 * `PATCH /:uid/threads/:tid`
 *
 * Edits only the root comment body of a thread. Proposal roots use this for
 * rationale edits; plain threads use it for the root comment text.
 */
async function editThreadRoot(c: Context, deps: AppDeps) {
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
  if (row.author_client_id !== decision.identity.clientId) return c.json({ error: 'forbidden' }, 403);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);

  const next = asThreadRootBody(body.body, isProposalRow(row));
  if (next === undefined) return c.json({ error: 'body-required' }, 400);

  const now = Date.now();
  db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(next, now, tid);

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
      { type: 'edit_proposal.updated', edit_proposal: toProposalWire(updated as never) },
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
    thread: toThreadWire(updated, replies, decision, reopenableAccepted),
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

  db.prepare('UPDATE comments SET deleted_at = ? WHERE id = ?').run(Date.now(), tid);
  if (isProposalRow(row)) {
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
  if (reply.author_client_id !== decision.identity.clientId) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await safeJson(c);
  const next = body ? asOptionalBody(body.body) : null;
  if (!next) return c.json({ error: 'body-required' }, 400);

  const now = Date.now();
  db.prepare('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?').run(next, now, cid);

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
    thread: toThreadWire(updatedThread, replies, decision, reopenableAccepted),
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
  const replyBody = asOptionalBody(body.body);
  const action = asRespondAction(body.action);
  if (!replyBody && !action) return c.json({ error: 'empty-response' }, 400);
  if (body.action !== undefined && action === null) return c.json({ error: 'invalid-body' }, 400);

  if (replyBody && !canComment(decision.role)) return c.json({ error: 'forbidden' }, 403);

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
    try {
      documentOid = await acceptProposalThread(doc, row, deps, identity);
    } catch (err) {
      if (err instanceof ThreadActionError) {
        return c.json({ error: err.code }, err.status);
      }
      throw err;
    }
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
      try {
        documentOid = await reopenAcceptedProposalThread(doc, row, deps, identity);
      } catch (err) {
        if (err instanceof ThreadActionError) {
          return c.json({ error: err.code }, err.status);
        }
        throw err;
      }
    }
  }

  let createdReplyId: string | null = null;
  if (replyBody) {
    const now = Date.now();
    createdReplyId = newCommentId();
    db.prepare(
      `INSERT INTO comments
         (id, doc_uid, parent_id, parent_proposal_id,
          author_client_id, author_display_name,
          body, link_status, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 'linked', ?, ?)`,
    ).run(createdReplyId, doc.uid, tid, identity.clientId, identity.displayName, replyBody, now, now);

    const reply = db.prepare('SELECT * FROM comments WHERE id = ?').get(createdReplyId) as CommentRow;
    const mentionTargets = storeMentionsForComment(
      db,
      doc.uid,
      reply.id,
      reply.body,
      reply.author_display_name,
    );
    realtime.broadcast(
      doc.uid,
      { type: 'comment.created', comment: toLegacyCommentWire(reply) },
      identity.clientId,
    );
    if (mentionTargets.length > 0) {
      realtime.broadcastToDisplayNames(
        doc.uid,
        mentionTargets,
        { type: 'mention.created', comment: toLegacyCommentWire(reply) },
        identity.clientId,
      );
    }
  }

  const updated = loadThreadRow(db, tid, doc.uid);
  if (!updated) return c.json({ error: 'not-found' }, 404);
  const replies = loadReplies(db, doc.uid, tid);
  const reopenableAccepted = await loadReopenableAcceptedThreadIds(doc, deps, [updated]);

  if (action) {
    if (isProposalRow(updated)) {
      realtime.broadcast(
        doc.uid,
        { type: 'edit_proposal.updated', edit_proposal: toProposalWire(updated as never) },
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
    thread: toThreadWire(updated, replies, decision, reopenableAccepted),
    created_reply_id: createdReplyId,
  });
}

async function acceptProposalThread(
  doc: DocumentRow,
  row: ThreadRow,
  deps: AppDeps,
  identity: Identity,
): Promise<string> {
  if (!row.anchor_block_id || !row.proposed_text) {
    throw new ThreadActionError(409, 'proposal-orphaned');
  }

  const source = deps.store.read(doc.path);
  const range =
    doc.format === 'asciidoc'
      ? (locateAllBlocksAsciidoc(source).get(row.anchor_block_id) ?? null)
      : locateBlockSource(source, row.anchor_block_id);
  if (!range) {
    const now = Date.now();
    deps.db
      .prepare(
        `UPDATE comments
            SET link_status = 'orphaned', anchor_block_id = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, row.id);
    const updated = loadProposalRow(deps.db, row.id, doc.uid);
    if (updated) {
      deps.realtime.broadcast(
        doc.uid,
        { type: 'edit_proposal.updated', edit_proposal: toProposalWire(updated) },
        identity.clientId,
      );
    }
    throw new ThreadActionError(409, 'proposal-orphaned');
  }

  const nextSource = source.slice(0, range.start) + row.proposed_text + source.slice(range.end);
  const { oid } = await deps.store.write(doc.uid, doc.format, nextSource, identity, 'accept-proposal', {
    proposalId: row.id,
  });
  const now = Date.now();
  deps.db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(now, doc.uid);

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
  const updateCommentStmt = deps.db.prepare(
    `UPDATE comments
        SET anchor_block_id = ?, anchor_start_offset = ?, anchor_end_offset = ?,
            link_status = ?, updated_at = ?
      WHERE id = ?`,
  );
  for (const comment of topLevelComments) {
    const upd = reanchor(comment, rendered.blocks);
    updateCommentStmt.run(
      upd.blockId,
      upd.startOffset,
      upd.endOffset,
      upd.linkStatus,
      now,
      comment.id,
    );
  }

  const acceptedAnchor = locateAcceptedProposalAnchor(
    presentBlocks,
    rendered.blocks,
    range.start,
    range.start + row.proposed_text.length,
  );
  deps.db.prepare(
    `UPDATE comments_edit_proposals
        SET status = 'accepted', accepted_oid = ?
      WHERE comment_id = ?`,
  ).run(oid, row.id);
  deps.db.prepare(
    `UPDATE comments
        SET anchor_block_id = ?,
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
  ).run(
    acceptedAnchor?.block.id ?? row.anchor_block_id,
    null,
    null,
    acceptedAnchor ? JSON.stringify(acceptedAnchor.block.headingPath) : row.anchor_heading_path,
    acceptedAnchor?.block.sectionIndex ?? row.anchor_section_index,
    acceptedAnchor ? JSON.stringify(acceptedAnchor.block.sectionIndexPath) : row.anchor_section_index_path,
    acceptedAnchor?.linkStatus ?? row.link_status,
    now,
    identity.displayName,
    now,
    row.id,
  );

  reanchorProposals(deps.db, doc.uid, [...presentBlocks.keys()], now, deps.realtime, identity.clientId);
  return oid;
}

async function reopenAcceptedProposalThread(
  doc: DocumentRow,
  row: ThreadRow,
  deps: AppDeps,
  identity: Identity,
): Promise<string> {
  if (!row.accepted_oid) throw new ThreadActionError(409, 'not-reopenable');

  const history = await deps.store.history(doc.path);
  const latest = history[0];
  const parent = history[1];
  if (!latest || latest.oid !== row.accepted_oid || !parent) {
    throw new ThreadActionError(409, 'not-reopenable');
  }

  const diff = await deps.store.diffAt(doc.path, row.accepted_oid);
  if (!diff) throw new ThreadActionError(409, 'not-reopenable');

  const { oid } = await deps.store.write(
    doc.uid,
    doc.format,
    diff.before,
    identity,
    'restore',
    { restoredFromOid: parent.oid },
  );
  const now = Date.now();
  deps.db.prepare('UPDATE documents SET updated_at = ? WHERE uid = ?').run(now, doc.uid);

  const rendered = await renderDocument(diff.before, doc.format);
  const topLevel = deps.db
    .prepare(
      `SELECT * FROM comments
         WHERE doc_uid = ? AND parent_id IS NULL AND deleted_at IS NULL`,
    )
    .all(doc.uid) as CommentRow[];
  const updateStmt = deps.db.prepare(
    `UPDATE comments
        SET anchor_block_id = ?, anchor_start_offset = ?, anchor_end_offset = ?,
            link_status = ?, updated_at = ?
      WHERE id = ?`,
  );
  for (const comment of topLevel) {
    const upd = reanchor(comment, rendered.blocks);
    updateStmt.run(
      upd.blockId,
      upd.startOffset,
      upd.endOffset,
      upd.linkStatus,
      now,
      comment.id,
    );
  }

  const reopened = reopenAcceptedProposal(deps.db, doc.uid, row.id, now);
  if (!reopened) throw new ThreadActionError(409, 'not-reopenable');

  const knownIds = [...locateDocumentBlocks(doc, diff.before).keys()];
  reanchorProposals(deps.db, doc.uid, knownIds, now, deps.realtime, identity.clientId);
  return oid;
}

function loadDoc(db: Database, uid: string | undefined): DocumentRow | null {
  if (!uid) return null;
  const row = db.prepare('SELECT * FROM documents WHERE uid = ?').get(uid) as
    | DocumentRow
    | undefined;
  return row ?? null;
}

function authorizeRequest(c: Context, deps: AppDeps, doc: DocumentRow) {
  const sessionToken = parseCookie(c.req.raw.headers.get('cookie'), SESSION_COOKIE);
  return authorize(deps.db, doc, c.req.raw.headers, sessionToken);
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

  const history = await deps.store.history(doc.path);
  const latest = history[0];
  const parent = history[1];
  if (!latest || !parent) return new Set<string>();

  return new Set(
    accepted
      .filter((row) => row.accepted_oid === latest.oid)
      .map((row) => row.id),
  );
}

function toThreadWire(
  row: ThreadRow,
  replies: CommentRow[],
  decision: ReturnType<typeof authorize>,
  reopenableAccepted: Set<string>,
): Record<string, unknown> {
  const state = threadState(row);
  const resolution = threadResolution(row);
  const rootAuthor = row.author_client_id;
  const viewerId = decision.ok ? (decision.identity?.clientId ?? null) : null;
  const isRootAuthor = viewerId !== null && viewerId === rootAuthor;
  const isAdmin = decision.ok && decision.role === 'admin';
  const proposal = isProposalRow(row);
  const canReply = decision.ok && canComment(decision.role);
  const canRootEdit = viewerId !== null && viewerId === row.author_client_id;
  const canRootDelete = canRootEdit || isAdmin;

  return {
    id: row.id,
    state,
    resolution,
    link_status: row.link_status,
    anchor: {
      block_id: row.anchor_block_id,
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
      resolve:
        !proposal &&
        state === 'open' &&
        (isRootAuthor || isAdmin),
      accept:
        proposal &&
        state === 'open' &&
        decision.ok &&
        canEdit(decision.role) &&
        row.link_status !== 'orphaned' &&
        row.anchor_block_id !== null,
      reject:
        proposal &&
        state === 'open' &&
        decision.ok &&
        (canEdit(decision.role) || isRootAuthor),
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
    root: {
      id: row.id,
      body: row.body,
      author: {
        client_id: row.author_client_id,
        display_name: row.author_display_name,
      },
      capabilities: {
        edit: canRootEdit,
        delete: canRootDelete,
      },
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    proposal: proposal
      ? {
          anchor_kind: row.anchor_kind,
          source_snapshot: row.source_snapshot,
          proposed_text: row.proposed_text,
        }
      : null,
    replies: replies.map((reply) => ({
      id: reply.id,
      body: reply.body,
      author: {
        client_id: reply.author_client_id,
        display_name: reply.author_display_name,
      },
      capabilities: {
        edit: viewerId !== null && viewerId === reply.author_client_id,
        delete:
          (viewerId !== null && viewerId === reply.author_client_id) || isAdmin,
      },
      created_at: reply.created_at,
      updated_at: reply.updated_at,
    })),
  };
}

function threadState(row: ThreadRow): ThreadState {
  if (isProposalRow(row)) return row.proposal_status === 'open' ? 'open' : 'resolved';
  return row.resolved_at === null ? 'open' : 'resolved';
}

function threadResolution(row: ThreadRow): { kind: ResolutionKind; at: number; by_name: string | null } | null {
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

function isProposalRow(row: ThreadRow): boolean {
  return row.proposal_status !== null;
}

function locateDocumentBlocks(doc: DocumentRow, source: string): Map<string, BlockSourceRange> {
  return doc.format === 'asciidoc' ? locateAllBlocksAsciidoc(source) : locateAllBlocks(source);
}

function readProposalBlockSource(
  doc: DocumentRow,
  source: string,
  blockId: string,
): string | null {
  const range =
    locateDocumentBlocks(doc, source).get(blockId) ??
    (doc.format === 'asciidoc' ? null : locateBlockSource(source, blockId));
  return range ? source.slice(range.start, range.end) : null;
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

function findBlockBySourceSpan(
  blocks: Map<string, BlockSourceRange>,
  start: number,
  end: number,
): { id: string; range: BlockSourceRange; confidence: 'linked' | 'low-confidence' } | null {
  let exact: { id: string; range: BlockSourceRange } | null = null;
  let sameStart: { id: string; range: BlockSourceRange } | null = null;
  let container: { id: string; range: BlockSourceRange } | null = null;
  let overlap:
    | { id: string; range: BlockSourceRange; amount: number; span: number }
    | null = null;

  for (const [id, range] of blocks) {
    if (range.start === start && range.end === end) {
      exact = { id, range };
      break;
    }
    if (range.start === start) {
      if (!sameStart || Math.abs(range.end - end) < Math.abs(sameStart.range.end - end)) {
        sameStart = { id, range };
      }
    }
    if (range.start <= start && range.end >= end) {
      if (!container || range.end - range.start < container.range.end - container.range.start) {
        container = { id, range };
      }
    }
    const amount = Math.min(range.end, end) - Math.max(range.start, start);
    if (amount > 0) {
      const span = range.end - range.start;
      if (!overlap || amount > overlap.amount || (amount === overlap.amount && span < overlap.span)) {
        overlap = { id, range, amount, span };
      }
    }
  }

  if (exact) return { ...exact, confidence: 'linked' };
  if (sameStart) return { ...sameStart, confidence: 'linked' };
  if (container) return { ...container, confidence: 'linked' };
  if (overlap) return { id: overlap.id, range: overlap.range, confidence: 'low-confidence' };
  return null;
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

function asOptionalBody(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= 5000 ? trimmed : null;
}

function asThreadRootBody(v: unknown, allowEmpty: boolean): string | undefined {
  if (v === null && allowEmpty) return '';
  if (typeof v !== 'string') return undefined;
  const trimmed = v.trim();
  if (trimmed.length === 0) return allowEmpty ? '' : undefined;
  if (trimmed.length > 5000) return undefined;
  return trimmed;
}

function asRespondAction(v: unknown): RespondAction | null {
  return v === 'resolve' || v === 'accept' || v === 'reject' || v === 'reopen' ? v : null;
}

function asAnchor(v: unknown): {
  blockId: string;
  quote: string;
  prefix: string;
  suffix: string;
  startOffset: number;
  endOffset: number;
  headingPath: string[] | null;
  sectionIndex: number | null;
  sectionIndexPath: number[] | null;
} | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  const blockId = asString(a.block_id);
  const quote = typeof a.quote === 'string' ? a.quote : null;
  if (!blockId || quote === null) return null;
  const headingPath = Array.isArray(a.heading_path)
    ? a.heading_path.filter((s): s is string => typeof s === 'string')
    : null;
  const sectionIndexPath = Array.isArray(a.section_index_path)
    ? a.section_index_path.filter((n): n is number => typeof n === 'number')
    : null;
  return {
    blockId,
    quote,
    prefix: typeof a.prefix === 'string' ? a.prefix : '',
    suffix: typeof a.suffix === 'string' ? a.suffix : '',
    startOffset: typeof a.start_offset === 'number' ? a.start_offset : 0,
    endOffset: typeof a.end_offset === 'number' ? a.end_offset : quote.length,
    headingPath,
    sectionIndex: typeof a.section_index === 'number' ? a.section_index : null,
    sectionIndexPath,
  };
}

function asProposal(v: unknown): { anchorKind: string | null; proposedText: string } | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object') return null;
  const proposal = v as Record<string, unknown>;
  const proposedText = typeof proposal.proposed_text === 'string' ? proposal.proposed_text : null;
  if (proposedText === null || proposedText.length === 0 || proposedText.length > 20000) return null;
  return {
    anchorKind: typeof proposal.anchor_kind === 'string' ? proposal.anchor_kind : null,
    proposedText,
  };
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
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
