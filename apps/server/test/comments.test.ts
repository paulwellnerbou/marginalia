import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type App } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';

const ALICE = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const BOB = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Bob' };
const CAROL = { id: 'cccccccccccccccccccc', name: 'Carol' };

function rawHeadersFor(c: { id: string; name: string }): Headers {
  return new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: c.id,
    [CLIENT_NAME_HEADER]: c.name,
  });
}

interface ThreadAnchorShape {
  block_id: string | null;
  quote: string | null;
  prefix: string;
  suffix: string;
  start_offset: number | null;
  end_offset: number | null;
  heading_path: string[] | null;
  section_index: number | null;
  section_index_path: number[] | null;
}

interface ThreadCommentNodeShape {
  id: string;
  body: string;
  author: { client_id: string; display_name: string };
  capabilities: { edit: boolean; delete: boolean };
  created_at: number;
  updated_at: number;
}

interface ThreadShape {
  id: string;
  state: 'open' | 'resolved';
  resolution: { kind: 'resolve' | 'accept' | 'reject'; at: number; by_name: string | null } | null;
  link_status: string;
  anchor: ThreadAnchorShape;
  capabilities: {
    reply: boolean;
    resolve: boolean;
    accept: boolean;
    reject: boolean;
    reopen: boolean;
  };
  root: ThreadCommentNodeShape;
  proposal: { anchor_kind: string | null; source_snapshot: string | null; proposed_text: string } | null;
  replies: ThreadCommentNodeShape[];
}

function threadRootToComment(thread: ThreadShape): Record<string, unknown> {
  return {
    id: thread.id,
    parent_id: null,
    parent_proposal_id: null,
    anchor: thread.anchor,
    author: thread.root.author,
    body: thread.root.body,
    link_status: thread.link_status,
    resolved_at: thread.resolution?.kind === 'resolve' ? thread.resolution.at : null,
    resolved_by_name: thread.resolution?.kind === 'resolve' ? thread.resolution.by_name : null,
    created_at: thread.root.created_at,
    updated_at: thread.root.updated_at,
  };
}

function threadReplyToComment(thread: ThreadShape, reply: ThreadCommentNodeShape): Record<string, unknown> {
  return {
    id: reply.id,
    parent_id: thread.proposal ? null : thread.id,
    parent_proposal_id: thread.proposal ? thread.id : null,
    anchor: null,
    author: reply.author,
    body: reply.body,
    link_status: null,
    resolved_at: null,
    resolved_by_name: null,
    created_at: reply.created_at,
    updated_at: reply.updated_at,
  };
}

function flattenThreadComments(threads: ThreadShape[]): Array<Record<string, unknown>> {
  const comments: Array<Record<string, unknown>> = [];
  for (const thread of threads) {
    if (!thread.proposal) comments.push(threadRootToComment(thread));
    for (const reply of thread.replies) comments.push(threadReplyToComment(thread, reply));
  }
  comments.sort(
    (a, b) =>
      ((a.created_at as number | undefined) ?? 0) - ((b.created_at as number | undefined) ?? 0),
  );
  return comments;
}

function findThreadComment(thread: ThreadShape, commentId: string): Record<string, unknown> | null {
  if (thread.id === commentId) return threadRootToComment(thread);
  const reply = thread.replies.find((entry) => entry.id === commentId);
  return reply ? threadReplyToComment(thread, reply) : null;
}

describe('threads API', () => {
  let dir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-cm-'));
    app = await createApp(loadConfig({ dataDir: dir, port: 0 }));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Alice uploads a doc and receives her admin invite token. The default
   * setup also mints standing collaborator invites for Bob and Carol so
   * `headersFor(BOB|CAROL)` can act as authenticated commenters without
   * each test body having to plumb invite tokens around. Tests that need
   * the genuine "anonymous visitor" behavior use `rawHeadersFor` and the
   * `addCommentRaw` helper.
   *
   * After ACCESS_CONTROL Step 2, an unauthenticated visitor is always a
   * reader (the old `editable_by_anyone` toggle is gone), so non-reader
   * rights MUST come from an invite.
   */
  let adminToken = '';
  const inviteByClientId = new Map<string, string>();
  async function newDoc(markdown: string): Promise<string> {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: rawHeadersFor(ALICE),
        body: JSON.stringify({ markdown }),
      }),
    );
    const j = (await res.json()) as { uid: string; admin_invite: { token: string } };
    adminToken = j.admin_invite.token;
    inviteByClientId.clear();
    inviteByClientId.set(ALICE.id, adminToken);
    inviteByClientId.set(BOB.id, await createInvite(j.uid, BOB.name, 'collaborator'));
    inviteByClientId.set(CAROL.id, await createInvite(j.uid, CAROL.name, 'collaborator'));
    return j.uid;
  }

  /** Headers for `who` with their per-doc invite token attached, if any. */
  function headersFor(c: { id: string; name: string }): Headers {
    const h = rawHeadersFor(c);
    const tok = inviteByClientId.get(c.id);
    if (tok) h.set(INVITE_HEADER, tok);
    return h;
  }

  /** Alias kept for readability where the test specifically wants to flag
   *  "this request is acting as the doc admin". */
  function asAdmin(c: typeof ALICE = ALICE): Headers {
    const h = rawHeadersFor(c);
    h.set(INVITE_HEADER, adminToken);
    return h;
  }

  async function createInvite(
    uid: string,
    displayName: string,
    role: 'admin' | 'editor' | 'collaborator' | 'reader' = 'collaborator',
  ): Promise<string> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/invites`, {
        method: 'POST',
        headers: asAdmin(),
        body: JSON.stringify({ display_name: displayName, role }),
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { invite: { token: string } };
    return body.invite.token;
  }

  async function firstBlockId(uid: string): Promise<string> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const j = (await res.json()) as { rendered: { blocks: Array<{ id: string; text: string }> } };
    return j.rendered.blocks[0]!.id;
  }

  async function addComment(
    uid: string,
    who: typeof ALICE,
    anchor: { block_id: string; quote: string; prefix?: string; suffix?: string },
    body: string,
  ) {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(who),
        body: JSON.stringify({ anchor, body }),
      }),
    );
    const json = (await res.json()) as { thread: ThreadShape };
    return {
      status: res.status,
      body: { comment: threadRootToComment(json.thread) },
    };
  }

  async function addReply(uid: string, who: typeof ALICE, threadId: string, body: string) {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}/respond`, {
        method: 'POST',
        headers: headersFor(who),
        body: JSON.stringify({ body }),
      }),
    );
    const json = (await res.json()) as { thread: ThreadShape; created_reply_id: string | null };
    const comment = json.created_reply_id ? findThreadComment(json.thread, json.created_reply_id) : null;
    return {
      status: res.status,
      body: { comment },
    };
  }

  /** Like addComment but skips invite attachment — for tests that exercise
   *  the truly-anonymous (reader) authorization path. */
  async function addCommentRaw(
    uid: string,
    who: typeof ALICE,
    anchor: { block_id: string; quote: string },
    body: string,
  ) {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: rawHeadersFor(who),
        body: JSON.stringify({ anchor, body }),
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  async function list(uid: string, who: typeof ALICE) {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, { headers: headersFor(who) }),
    );
    const j = (await res.json()) as { threads: ThreadShape[] };
    return flattenThreadComments(j.threads);
  }

  test('create, list, and reply', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);

    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'Hi');
    expect(r1.status).toBe(201);
    const top = (r1.body as { comment: { id: string; parent_id: string | null } }).comment;
    expect(top.parent_id).toBeNull();

    // Reply by Bob
    const r2 = await addReply(uid, BOB, top.id, 'Me too');
    expect(r2.status).toBe(200);

    const comments = await list(uid, ALICE);
    expect(comments).toHaveLength(2);
    expect(comments[1]!.parent_id).toBe(top.id);
    expect(comments[1]!.anchor).toBeNull();
  });

  test('rejects nested replies (only one level)', async () => {
    const uid = await newDoc('# Title\n');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hi');
    const topId = (r1.body as { comment: { id: string } }).comment.id;

    const r2 = await addReply(uid, BOB, topId, 'reply');
    const replyId = ((r2.body as { comment: { id: string } }).comment).id;

    const r3 = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${replyId}/respond`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ body: 'nope' }),
      }),
    );
    expect(r3.status).toBe(404);
  });

  test('author edits own comment; others cannot', async () => {
    const uid = await newDoc('# Title\n');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hi');
    const cid = (r1.body as { comment: { id: string } }).comment.id;

    const editByBob = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}`, {
        method: 'PATCH',
        headers: headersFor(BOB),
        body: JSON.stringify({ body: 'hacked' }),
      }),
    );
    expect(editByBob.status).toBe(403);

    const editByAlice = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}`, {
        method: 'PATCH',
        headers: headersFor(ALICE),
        body: JSON.stringify({ body: 'updated' }),
      }),
    );
    expect(editByAlice.status).toBe(200);
  });

  test('reply author can edit their reply; admin can delete it', async () => {
    const uid = await newDoc('# Title\n');
    const blockId = await firstBlockId(uid);
    const root = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'top');
    const threadId = (root.body as { comment: { id: string } }).comment.id;

    const reply = await addReply(uid, BOB, threadId, 'reply');
    expect(reply.status).toBe(200);
    const replyId = ((reply.body as { comment: { id: string } }).comment).id;

    const editByAlice = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}/comments/${replyId}`, {
        method: 'PATCH',
        headers: headersFor(ALICE),
        body: JSON.stringify({ body: 'not allowed' }),
      }),
    );
    expect(editByAlice.status).toBe(403);

    const editByBob = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}/comments/${replyId}`, {
        method: 'PATCH',
        headers: headersFor(BOB),
        body: JSON.stringify({ body: 'updated reply' }),
      }),
    );
    expect(editByBob.status).toBe(200);

    const deleteByAdmin = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}/comments/${replyId}`, {
        method: 'DELETE',
        headers: asAdmin(),
      }),
    );
    expect(deleteByAdmin.status).toBe(204);

    const comments = await list(uid, ALICE);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.id).toBe(threadId);
  });

  test('admin (doc owner) can delete any comment, but not edit others', async () => {
    const uid = await newDoc('# Title\n');
    const blockId = await firstBlockId(uid);

    // Bob comments (as a reader — this document was not editable_by_anyone
    // but comments still go through; admin role only matters for edits).
    const r1 = await addComment(uid, BOB, { block_id: blockId, quote: 'Title' }, 'bob says');
    const cid = (r1.body as { comment: { id: string } }).comment.id;

    // Alice (admin, via invite) tries to edit — forbidden (can only edit own).
    const editRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}`, {
        method: 'PATCH',
        headers: asAdmin(),
        body: JSON.stringify({ body: 'admin edit' }),
      }),
    );
    expect(editRes.status).toBe(403);

    // Alice deletes as admin — allowed.
    const delRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}`, {
        method: 'DELETE',
        headers: asAdmin(),
      }),
    );
    expect(delRes.status).toBe(204);

    const after = await list(uid, ALICE);
    expect(after).toHaveLength(0);
  });

  test('re-anchoring: confident match when surrounding text changes', async () => {
    const uid = await newDoc('# Title\n\nThe quick brown fox jumps.\n');
    const block = await (async () => {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
      );
      const j = (await res.json()) as {
        rendered: { blocks: Array<{ id: string; text: string; kind: string }> };
      };
      return j.rendered.blocks.find((b) => b.kind === 'paragraph')!;
    })();

    await addComment(uid, ALICE, { block_id: block.id, quote: 'brown fox' }, 'fox comment');

    // Edit unrelated block (title); paragraph unchanged.
    const put = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, {
        method: 'PUT',
        headers: asAdmin(),
        body: JSON.stringify({ markdown: '# New Title\n\nThe quick brown fox jumps.\n' }),
      }),
    );
    expect(put.status).toBe(200);

    const comments = await list(uid, ALICE);
    expect(comments[0]!.link_status).toBe('linked');
  });

  test('re-anchoring: low-confidence when block changes but quote still elsewhere', async () => {
    const uid = await newDoc('# Title\n\nThe quick brown fox.\n');
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const j = (await res.json()) as {
      rendered: { blocks: Array<{ id: string; text: string; kind: string }> };
    };
    const para = j.rendered.blocks.find((b) => b.kind === 'paragraph')!;

    await addComment(uid, ALICE, { block_id: para.id, quote: 'brown fox' }, 'c');

    // Replace the paragraph entirely; move "brown fox" into a new block.
    await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, {
        method: 'PUT',
        headers: asAdmin(),
        body: JSON.stringify({
          markdown: '# Title\n\nA different sentence now.\n\nBut the brown fox still lives.\n',
        }),
      }),
    );

    const comments = await list(uid, ALICE);
    expect(comments[0]!.link_status).toBe('low-confidence');
  });

  test('re-anchoring: orphaned when quote disappears entirely', async () => {
    const uid = await newDoc('# Title\n\nThe quick brown fox.\n');
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const j = (await res.json()) as {
      rendered: { blocks: Array<{ id: string; text: string; kind: string }> };
    };
    const para = j.rendered.blocks.find((b) => b.kind === 'paragraph')!;

    await addComment(uid, ALICE, { block_id: para.id, quote: 'brown fox' }, 'c');

    await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, {
        method: 'PUT',
        headers: asAdmin(),
        body: JSON.stringify({ markdown: '# Title\n\nSomething completely different.\n' }),
      }),
    );

    const comments = await list(uid, ALICE);
    expect(comments[0]!.link_status).toBe('orphaned');
  });

  test('identity required to post', async () => {
    const uid = await newDoc('# Hi');
    const blockId = await firstBlockId(uid);
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Hi' }, body: 'x' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  // ACCESS_CONTROL Step 2: an anonymous visitor (no invite header) is
  // always a reader and cannot post. The previous "editable_by_anyone"
  // toggle that elevated such visitors to editor was retired.
  test('anonymous visitor (no invite) cannot post a comment', async () => {
    const uid = await newDoc('# Public');
    const blockId = await firstBlockId(uid);
    const r = await addCommentRaw(uid, CAROL, { block_id: blockId, quote: 'Public' }, 'hey');
    expect(r.status).toBe(403);
  });

  // Default-scaffold counterpart: with a collaborator invite (auto-minted
  // by newDoc), Carol CAN post. Confirms invite-driven access works.
  test('collaborator invite lets a non-admin post a comment', async () => {
    const uid = await newDoc('# Public');
    const blockId = await firstBlockId(uid);
    const r = await addComment(uid, CAROL, { block_id: blockId, quote: 'Public' }, 'looks good');
    expect(r.status).toBe(201);
  });

  test('mentions return pending notifications once and include merged autocomplete names', async () => {
    const uid = await newDoc('# Title');
    const bobInvite = await createInvite(uid, 'Bob', 'collaborator');
    const blockId = await firstBlockId(uid);

    const created = await addComment(
      uid,
      ALICE,
      { block_id: blockId, quote: 'Title' },
      'hello @Bob',
    );
    expect(created.status).toBe(201);
    const cid = (created.body as { comment: { id: string } }).comment.id;

    const first = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: new Headers({
          [CLIENT_HEADER]: BOB.id,
          [INVITE_HEADER]: bobInvite,
        }),
      }),
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      mention_candidates: string[];
      pending_mentions: string[];
    };
    expect(firstBody.mention_candidates).toContain('Alice');
    expect(firstBody.mention_candidates).toContain('Bob');
    expect(firstBody.pending_mentions).toEqual([cid]);

    const second = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: new Headers({
          [CLIENT_HEADER]: BOB.id,
          [INVITE_HEADER]: bobInvite,
        }),
      }),
    );
    const secondBody = (await second.json()) as { pending_mentions: string[] };
    expect(secondBody.pending_mentions).toEqual([]);
  });

  test('thread list can skip consuming pending mentions', async () => {
    const uid = await newDoc('# Title');
    const bobInvite = await createInvite(uid, 'Bob', 'collaborator');
    const blockId = await firstBlockId(uid);

    const created = await addComment(
      uid,
      ALICE,
      { block_id: blockId, quote: 'Title' },
      'hello @Bob',
    );
    expect(created.status).toBe(201);
    const cid = (created.body as { comment: { id: string } }).comment.id;

    const peek = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads?consume_mentions=false`, {
        headers: new Headers({
          [CLIENT_HEADER]: BOB.id,
          [INVITE_HEADER]: bobInvite,
        }),
      }),
    );
    expect(peek.status).toBe(200);
    const peekBody = (await peek.json()) as { pending_mentions: string[] };
    expect(peekBody.pending_mentions).toEqual([]);

    const consume = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: new Headers({
          [CLIENT_HEADER]: BOB.id,
          [INVITE_HEADER]: bobInvite,
        }),
      }),
    );
    const consumeBody = (await consume.json()) as { pending_mentions: string[] };
    expect(consumeBody.pending_mentions).toEqual([cid]);
  });

  test('editing a comment only creates a mention notification once per person', async () => {
    const uid = await newDoc('# Title');
    const carolInvite = await createInvite(uid, 'Carol', 'collaborator');
    const blockId = await firstBlockId(uid);

    const created = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hello');
    expect(created.status).toBe(201);
    const cid = (created.body as { comment: { id: string } }).comment.id;

    const edit = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}`, {
        method: 'PATCH',
        headers: headersFor(ALICE),
        body: JSON.stringify({ body: 'hello @Carol' }),
      }),
    );
    expect(edit.status).toBe(200);

    const first = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: new Headers({
          [CLIENT_HEADER]: CAROL.id,
          [INVITE_HEADER]: carolInvite,
        }),
      }),
    );
    const firstBody = (await first.json()) as { pending_mentions: string[] };
    expect(firstBody.pending_mentions).toEqual([cid]);

    const editAgain = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}`, {
        method: 'PATCH',
        headers: headersFor(ALICE),
        body: JSON.stringify({ body: 'hello again @Carol' }),
      }),
    );
    expect(editAgain.status).toBe(200);

    const second = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: new Headers({
          [CLIENT_HEADER]: CAROL.id,
          [INVITE_HEADER]: carolInvite,
        }),
      }),
    );
    const secondBody = (await second.json()) as { pending_mentions: string[] };
    expect(secondBody.pending_mentions).toEqual([]);
  });

  test('@all mentions every other known person once', async () => {
    const uid = await newDoc('# Title');
    const bobInvite = await createInvite(uid, 'Bob', 'collaborator');
    const carolInvite = await createInvite(uid, 'Carol', 'collaborator');
    const blockId = await firstBlockId(uid);

    const created = await addComment(
      uid,
      ALICE,
      { block_id: blockId, quote: 'Title' },
      'hello @all',
    );
    expect(created.status).toBe(201);
    const cid = (created.body as { comment: { id: string } }).comment.id;

    const bobList = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: new Headers({
          [CLIENT_HEADER]: BOB.id,
          [INVITE_HEADER]: bobInvite,
        }),
      }),
    );
    const bobBody = (await bobList.json()) as { pending_mentions: string[] };
    expect(bobBody.pending_mentions).toEqual([cid]);

    const carolList = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: new Headers({
          [CLIENT_HEADER]: CAROL.id,
          [INVITE_HEADER]: carolInvite,
        }),
      }),
    );
    const carolBody = (await carolList.json()) as { pending_mentions: string[] };
    expect(carolBody.pending_mentions).toEqual([cid]);
  });

  test('root comment author can resolve and unresolve a top-level thread', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'question');
    const cid = (r1.body as { comment: { id: string } }).comment.id;

    const resolveRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}/respond`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ action: 'resolve' }),
      }),
    );
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()) as {
      thread: {
        resolution: { kind: string; at: number; by_name: string | null } | null;
      };
    };
    expect(resolved.thread.resolution?.kind).toBe('resolve');
    expect(resolved.thread.resolution?.at).toBeGreaterThan(0);
    expect(resolved.thread.resolution?.by_name).toBe('Alice');

    const reopenRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}/respond`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ action: 'reopen' }),
      }),
    );
    expect(reopenRes.status).toBe(200);
    const reopened = (await reopenRes.json()) as {
      thread: { resolution: { at: number } | null };
    };
    expect(reopened.thread.resolution).toBeNull();
  });

  test('invalid reply body rejects a combined response without changing state', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'question');
    const cid = (r1.body as { comment: { id: string } }).comment.id;

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}/respond`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ action: 'resolve', body: 'x'.repeat(5001) }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-body' });

    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: headersFor(ALICE),
      }),
    );
    const listed = (await listRes.json()) as { threads: ThreadShape[] };
    const thread = listed.threads.find((entry) => entry.id === cid);
    expect(thread?.state).toBe('open');
    expect(thread?.replies).toEqual([]);
  });

  test('admin can resolve a top-level thread they did not author', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, BOB, { block_id: blockId, quote: 'Title' }, 'question');
    const cid = (r1.body as { comment: { id: string } }).comment.id;

    const resolveRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}/respond`, {
        method: 'POST',
        headers: asAdmin(),
        body: JSON.stringify({ action: 'resolve' }),
      }),
    );
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()) as {
      thread: {
        resolution: { kind: string; at: number; by_name: string | null } | null;
      };
    };
    expect(resolved.thread.resolution?.kind).toBe('resolve');
    expect(resolved.thread.resolution?.at).toBeGreaterThan(0);
    expect(resolved.thread.resolution?.by_name).toBe('Alice');
  });

  test('non-admins cannot resolve someone else’s top-level thread', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'question');
    const cid = (r1.body as { comment: { id: string } }).comment.id;

    const resolveRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${cid}/respond`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({ action: 'resolve' }),
      }),
    );
    expect(resolveRes.status).toBe(403);
  });

  // Role gate matrix for root thread creation and proposal creation:
  // collaborator must be allowed by both; reader must be rejected by both.
  test('collaborator invite: can comment AND can propose; reader cannot', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);

    // Bob's collaborator invite is auto-minted by `newDoc`; `headersFor(BOB)`
    // attaches it. Carol gets a fresh reader-role invite explicitly so she
    // overrides her default collaborator slot for this scenario.
    const carolReaderInvite = await createInvite(uid, 'Carol', 'reader');
    inviteByClientId.set(CAROL.id, carolReaderInvite);

    // Bob (collaborator) can comment.
    const commentRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Title' }, body: 'note' }),
      }),
    );
    expect(commentRes.status).toBe(201);

    // Bob (collaborator) can propose an edit.
    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          proposal: {
            anchor_kind: 'heading',
            proposed_text: '# Better title',
          },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);

    // Carol (reader) cannot comment.
    const carolComment = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(CAROL),
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Title' }, body: 'no' }),
      }),
    );
    expect(carolComment.status).toBe(403);

    // Carol (reader) cannot propose.
    const carolPropose = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(CAROL),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          proposal: {
            anchor_kind: 'heading',
            proposed_text: '# Nope',
          },
        }),
      }),
    );
    expect(carolPropose.status).toBe(403);
  });

  test('invalid proposal payload returns proposal validation error', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          proposal: { anchor_kind: 'heading' },
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'proposal-text-required' });
  });

  test('invalid proposal rationale is rejected instead of silently dropped', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          body: 'x'.repeat(5001),
          proposal: {
            anchor_kind: 'heading',
            proposed_text: '# Better title',
          },
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid-body' });
  });

  test('proposal replies are stored with parent_proposal_id', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          proposal: {
            anchor_kind: 'heading',
            proposed_text: '# Better title',
          },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposed = (await proposeRes.json()) as { thread: ThreadShape };

    const replyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${proposed.thread.id}/respond`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ body: 'Looks good' }),
      }),
    );
    expect(replyRes.status).toBe(200);
    const replyBody = (await replyRes.json()) as {
      created_reply_id: string;
    };
    const row = app.db
      .prepare(
        `SELECT parent_id, parent_proposal_id
           FROM comments
          WHERE id = ?`,
      )
      .get(replyBody.created_reply_id) as {
      parent_id: string | null;
      parent_proposal_id: string | null;
    };
    expect(row).toEqual({
      parent_id: null,
      parent_proposal_id: proposed.thread.id,
    });
  });

  test('accepted proposal authors cannot delete unless they are admin', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          proposal: {
            anchor_kind: 'heading',
            proposed_text: '# Better title',
          },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposed = (await proposeRes.json()) as { thread: ThreadShape };

    const acceptRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${proposed.thread.id}/respond`, {
        method: 'POST',
        headers: asAdmin(),
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
    expect(acceptRes.status).toBe(200);

    const bobList = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: headersFor(BOB),
      }),
    );
    const bobBody = (await bobList.json()) as {
      threads: Array<{ id: string; root: { capabilities: { delete: boolean } } }>;
    };
    expect(
      bobBody.threads.find((thread) => thread.id === proposed.thread.id)?.root.capabilities.delete,
    ).toBe(false);

    const adminList = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: asAdmin(),
      }),
    );
    const adminBody = (await adminList.json()) as {
      threads: Array<{ id: string; root: { capabilities: { delete: boolean } } }>;
    };
    expect(
      adminBody.threads.find((thread) => thread.id === proposed.thread.id)?.root.capabilities.delete,
    ).toBe(true);
  });

  test('resolving a reply is rejected', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'top');
    const topId = (r1.body as { comment: { id: string } }).comment.id;

    const replyRes = await addReply(uid, BOB, topId, 'reply');
    const replyId = ((replyRes.body as { comment: { id: string } }).comment).id;

    const resolveRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${replyId}/respond`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({ action: 'resolve' }),
      }),
    );
    expect(resolveRes.status).toBe(404);
  });

  // --- ACCESS_CONTROL Step 4: per-document users + rename propagation ---

  /** Wrapper that replays `addComment` but with a rewritten display name
   *  in the outbound headers. Drives the rename path in authorize(). */
  async function addCommentAs(
    uid: string,
    who: typeof ALICE,
    newName: string,
    anchor: { block_id: string; quote: string },
    body: string,
  ) {
    const h = headersFor(who);
    h.set(CLIENT_NAME_HEADER, newName);
    return app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ anchor, body }),
      }),
    );
  }

  test('rename propagation: old comments authored by the same client_id follow the new display name', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);

    // Bob posts as "Bob" (matches his auto-minted named invite).
    const first = await addComment(uid, BOB, { block_id: blockId, quote: 'Title' }, 'first');
    expect(first.status).toBe(201);
    const firstId = (first.body as { comment: { id: string } }).comment.id;

    // Bob renames himself: the client sends a new x-marginalia-client-name
    // header. authorize() detects the diff against doc_users and fires
    // propagateRename, which UPDATEs author_display_name on all of Bob's
    // prior comments.
    const renamed = await addCommentAs(
      uid,
      BOB,
      'Bobby',
      { block_id: blockId, quote: 'Title' },
      'second',
    );
    expect(renamed.status).toBe(201);

    const listRes = await list(uid, ALICE);
    const byBob = listRes.filter((c) => {
      const author = c.author as { client_id: string };
      return author.client_id === BOB.id;
    });
    expect(byBob.map((c) => (c.author as { display_name: string }).display_name)).toEqual([
      'Bobby',
      'Bobby',
    ]);
    // Original comment id stays; only its author_display_name changed.
    expect(byBob.find((c) => c.id === firstId)).toBeDefined();
  });

  // --- Direct thread-shape assertions ---
  //
  // The helpers above (flattenThreadComments, addComment, list, …) map thread
  // responses back to the legacy flat-comment shape. The tests below skip that
  // mapping entirely and assert directly on the wire shape returned by the API,
  // so regressions in the new thread structure are caught independently of the
  // compatibility shim.

  test('thread shape: comment creation response matches expected wire shape', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          body: 'First comment',
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { thread } = (await res.json()) as { thread: ThreadShape };

    // Top-level identity and state
    expect(typeof thread.id).toBe('string');
    expect(thread.state).toBe('open');
    expect(thread.resolution).toBeNull();
    expect(thread.link_status).toBe('linked');

    // Anchor shape
    expect(thread.anchor.block_id).toBe(blockId);
    expect(thread.anchor.quote).toBe('Title');
    expect(thread.anchor.prefix).toBe('');
    expect(thread.anchor.suffix).toBe('');

    // Thread-level capabilities (Alice is the root author and also admin here)
    expect(thread.capabilities.reply).toBe(true);
    expect(thread.capabilities.resolve).toBe(true);   // author may resolve
    expect(thread.capabilities.accept).toBe(false);   // not a proposal
    expect(thread.capabilities.reject).toBe(false);   // not a proposal
    expect(thread.capabilities.reopen).toBe(false);   // not yet resolved

    // Root comment node
    expect(thread.root.id).toBe(thread.id);
    expect(thread.root.body).toBe('First comment');
    expect(thread.root.author.client_id).toBe(ALICE.id);
    expect(thread.root.author.display_name).toBe('Alice');
    expect(typeof thread.root.created_at).toBe('number');
    expect(typeof thread.root.updated_at).toBe('number');
    expect(thread.root.capabilities.edit).toBe(true);   // own comment
    expect(thread.root.capabilities.delete).toBe(true); // own comment

    // No proposal, no replies on creation
    expect(thread.proposal).toBeNull();
    expect(thread.replies).toHaveLength(0);
  });

  test('thread shape: proposal field is populated for proposal threads', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          body: 'Please rename',
          proposal: { anchor_kind: 'heading', proposed_text: '# Better title' },
        }),
      }),
    );
    expect(res.status).toBe(201);
    const { thread } = (await res.json()) as { thread: ThreadShape };

    expect(thread.state).toBe('open');
    expect(thread.resolution).toBeNull();
    expect(thread.proposal).not.toBeNull();
    expect(thread.proposal!.proposed_text).toBe('# Better title');
    expect(thread.proposal!.anchor_kind).toBe('heading');

    // Capabilities: Bob is collaborator → can propose/reject own, but not accept (needs editor)
    expect(thread.capabilities.accept).toBe(false); // collaborator cannot accept
    expect(thread.capabilities.reject).toBe(true);  // root author may reject

    expect(thread.replies).toHaveLength(0);
  });

  test('thread shape: replies appear in thread.replies with correct shape', async () => {
    const uid = await newDoc('# Title\n');
    const blockId = await firstBlockId(uid);

    const createRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Title' }, body: 'top' }),
      }),
    );
    const { thread: created } = (await createRes.json()) as { thread: ThreadShape };

    const replyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${created.id}/respond`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({ body: 'my reply' }),
      }),
    );
    expect(replyRes.status).toBe(200);
    const { thread } = (await replyRes.json()) as { thread: ThreadShape; created_reply_id: string };

    expect(thread.state).toBe('open');
    expect(thread.replies).toHaveLength(1);

    const reply = thread.replies[0]!;
    expect(reply.body).toBe('my reply');
    expect(reply.author.client_id).toBe(BOB.id);
    expect(reply.author.display_name).toBe('Bob');
    expect(typeof reply.created_at).toBe('number');
    // Response is for Bob's request → he owns the reply
    expect(reply.capabilities.edit).toBe(true);
    expect(reply.capabilities.delete).toBe(true);
  });

  test('thread shape: resolve sets state and resolution; reopen restores open state', async () => {
    const uid = await newDoc('# Title\n');
    const blockId = await firstBlockId(uid);

    const createRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Title' }, body: 'question' }),
      }),
    );
    const { thread: created } = (await createRes.json()) as { thread: ThreadShape };

    const resolveRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${created.id}/respond`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ action: 'resolve' }),
      }),
    );
    expect(resolveRes.status).toBe(200);
    const { thread: resolved } = (await resolveRes.json()) as { thread: ThreadShape };

    expect(resolved.state).toBe('resolved');
    expect(resolved.resolution).not.toBeNull();
    expect(resolved.resolution!.kind).toBe('resolve');
    expect(resolved.resolution!.by_name).toBe('Alice');
    expect(resolved.resolution!.at).toBeGreaterThan(0);
    // Resolve gone; reopen now available to author/admin
    expect(resolved.capabilities.resolve).toBe(false);
    expect(resolved.capabilities.reopen).toBe(true);

    const reopenRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${created.id}/respond`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ action: 'reopen' }),
      }),
    );
    expect(reopenRes.status).toBe(200);
    const { thread: reopened } = (await reopenRes.json()) as { thread: ThreadShape };

    expect(reopened.state).toBe('open');
    expect(reopened.resolution).toBeNull();
    expect(reopened.capabilities.resolve).toBe(true);
    expect(reopened.capabilities.reopen).toBe(false);
  });

  test('thread shape: GET /threads response envelope', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);

    await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Title' }, body: 'first' }),
      }),
    );
    await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Title' }, body: 'second' }),
      }),
    );

    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, { headers: headersFor(ALICE) }),
    );
    expect(listRes.status).toBe(200);
    const json = (await listRes.json()) as {
      threads: ThreadShape[];
      mention_candidates: string[];
      pending_mentions: string[];
    };

    // Envelope
    expect(Array.isArray(json.threads)).toBe(true);
    expect(json.threads).toHaveLength(2);
    expect(Array.isArray(json.mention_candidates)).toBe(true);
    expect(Array.isArray(json.pending_mentions)).toBe(true);

    // Each thread in the list has the required top-level fields
    for (const thread of json.threads) {
      expect(typeof thread.id).toBe('string');
      expect(['open', 'resolved']).toContain(thread.state);
      expect(thread.anchor).toBeDefined();
      expect(thread.anchor.block_id).toBe(blockId);
      expect(thread.root).toBeDefined();
      expect(typeof thread.root.body).toBe('string');
      expect(thread.capabilities).toBeDefined();
      expect(Array.isArray(thread.replies)).toBe(true);
    }
  });

  test('rename propagation: unambiguous @mentions get rewritten; duplicated ones are left alone', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);

    // Alice mentions Bob (unambiguous — only one "Bob" in the doc).
    const c1 = await addComment(
      uid,
      ALICE,
      { block_id: blockId, quote: 'Title' },
      'hello @Bob',
    );
    expect(c1.status).toBe(201);

    // Bob renames to "Bobby". The mention row targeting "Bob" should be
    // rewritten because no other client_id uses that name.
    await addCommentAs(uid, BOB, 'Bobby', { block_id: blockId, quote: 'Title' }, 'here');

    // Bob now fetches his pending mentions under his NEW name. If the
    // mention row wasn't rewritten, his GET would see zero pending
    // mentions (because target_display_name='Bob' doesn't match 'Bobby').
    const getRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: (() => {
          const h = headersFor(BOB);
          h.set(CLIENT_NAME_HEADER, 'Bobby');
          return h;
        })(),
      }),
    );
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as { pending_mentions: string[] };
    expect(body.pending_mentions.length).toBe(1);

    // Now the "duplicated name" branch: give Carol the name "Bobby" so
    // two users share it, then rename one. Mention rows for the OLD
    // name must NOT be rewritten (would steal the other user's mentions).
    //
    // Under ACCESS_CONTROL option 1, Carol's FIRST visit uses her named
    // invite's seed "Carol" (even if her header says "Bobby"), so we
    // first prime her doc_users row as "Carol" via a regular post, then
    // rename her to "Bobby" on a subsequent request.
    await addComment(uid, CAROL, { block_id: blockId, quote: 'Title' }, 'first as carol');
    await addCommentAs(
      uid,
      CAROL,
      'Bobby',
      { block_id: blockId, quote: 'Title' },
      'me too',
    );
    // Alice mentions @Bobby — ambiguous now.
    const c2 = await addComment(
      uid,
      ALICE,
      { block_id: blockId, quote: 'Title' },
      '@Bobby look',
    );
    expect(c2.status).toBe(201);

    // Bob renames back to "Bob" (leaving Carol as the only "Bobby").
    await addCommentAs(uid, BOB, 'Bob', { block_id: blockId, quote: 'Title' }, 'back');

    // Carol's pending-mentions fetch must still see the ambiguous mention:
    // we didn't rewrite target_display_name='Bobby' because Bob was not
    // the sole holder at rename time.
    const carolRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        headers: (() => {
          const h = headersFor(CAROL);
          h.set(CLIENT_NAME_HEADER, 'Bobby');
          return h;
        })(),
      }),
    );
    const carolBody = (await carolRes.json()) as { pending_mentions: string[] };
    // Carol should see the @Bobby mention (c2.id).
    const c2Id = (c2.body as { comment: { id: string } }).comment.id;
    expect(carolBody.pending_mentions).toContain(c2Id);
  });
});
