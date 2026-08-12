import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';

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
  end_block_id?: string | null;
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
  hidden?: boolean;
  body: string;
  author: { client_id: string; display_name: string };
  capabilities: { edit: boolean; delete: boolean; hide?: boolean; react?: boolean };
  reactions?: Array<{ emoji: string; count: number; reacted: boolean; authors: string[] }>;
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
    repair: boolean;
    reopen: boolean;
  };
  comments: [ThreadCommentNodeShape, ...ThreadCommentNodeShape[]];
  answered_by_thread_ids: string[];
  proposal: { whole_document?: boolean; answers_thread_id?: string | null } | null;
}

function threadRootToComment(thread: ThreadShape): Record<string, unknown> {
  const opener = thread.comments[0];
  return {
    id: thread.id,
    parent_id: null,
    parent_proposal_id: null,
    anchor: thread.anchor,
    author: opener.author,
    body: opener.body,
    link_status: thread.link_status,
    resolved_at: thread.resolution?.kind === 'resolve' ? thread.resolution.at : null,
    resolved_by_name: thread.resolution?.kind === 'resolve' ? thread.resolution.by_name : null,
    created_at: opener.created_at,
    updated_at: opener.updated_at,
  };
}

function threadReplyToComment(
  thread: ThreadShape,
  reply: ThreadCommentNodeShape,
): Record<string, unknown> {
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
    for (const reply of thread.comments.slice(1))
      comments.push(threadReplyToComment(thread, reply));
  }
  comments.sort(
    (a, b) =>
      ((a.created_at as number | undefined) ?? 0) - ((b.created_at as number | undefined) ?? 0),
  );
  return comments;
}

function findThreadComment(thread: ThreadShape, commentId: string): Record<string, unknown> | null {
  if (thread.id === commentId) return threadRootToComment(thread);
  const reply = thread.comments.slice(1).find((entry) => entry.id === commentId);
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
        // Not invite-only: the anonymous-visitor cases below need a
        // document a stranger can still read.
        body: JSON.stringify({ markdown, invite_only: false }),
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
    const comment = json.created_reply_id
      ? findThreadComment(json.thread, json.created_reply_id)
      : null;
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

  test('hidden comments are visible only to their author and can be unhidden', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);
    const created = await addComment(
      uid,
      ALICE,
      { block_id: blockId, quote: 'Title' },
      'Review the whole chapter @Bob',
    );
    const threadId = (created.body.comment as { id: string }).id;

    const hideRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}`, {
        method: 'PATCH',
        headers: headersFor(ALICE),
        body: JSON.stringify({ hidden: true }),
      }),
    );
    expect(hideRes.status).toBe(200);
    const hidden = (await hideRes.json()) as { thread: ThreadShape };
    expect(hidden.thread.comments[0].hidden).toBe(true);
    expect(hidden.thread.comments[0].capabilities.hide).toBe(true);

    const aliceList = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads?state=all`, {
        headers: headersFor(ALICE),
      }),
    );
    const aliceBody = (await aliceList.json()) as {
      threads: ThreadShape[];
      counts: { total: number };
    };
    expect(aliceBody.threads.map((thread) => thread.id)).toContain(threadId);
    expect(aliceBody.counts.total).toBe(1);

    // Privacy is based on authorship, not role: even a different admin
    // must not be able to inspect the hidden thread.
    const bobAsAdmin = asAdmin(BOB);
    const bobList = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads?state=all`, {
        headers: bobAsAdmin,
      }),
    );
    const bobBody = (await bobList.json()) as {
      threads: ThreadShape[];
      counts: { total: number };
      pending_mentions: string[];
    };
    expect(bobBody.threads).toHaveLength(0);
    expect(bobBody.counts.total).toBe(0);
    expect(bobBody.pending_mentions).not.toContain(threadId);

    const direct = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads?thread_id=${threadId}`, {
        headers: bobAsAdmin,
      }),
    );
    expect(((await direct.json()) as { threads: ThreadShape[] }).threads).toHaveLength(0);

    const reply = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}/respond`, {
        method: 'POST',
        headers: bobAsAdmin,
        body: JSON.stringify({ body: 'I should not see this' }),
      }),
    );
    expect(reply.status).toBe(404);

    const answerProposal = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: bobAsAdmin,
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          body: 'Attempt to act on a private request',
          proposal: {
            proposed_text: '# Revised title',
            answers_thread_id: threadId,
          },
        }),
      }),
    );
    expect(answerProposal.status).toBe(400);
    expect((await answerProposal.json()) as { error: string }).toEqual({
      error: 'answers-thread-not-found',
    });

    const bundleRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/export`, { headers: bobAsAdmin }),
    );
    const bundle = (await bundleRes.json()) as { comments: Array<{ id: string }> };
    expect(bundle.comments.map((comment) => comment.id)).not.toContain(threadId);

    const unhideRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}`, {
        method: 'PATCH',
        headers: headersFor(ALICE),
        body: JSON.stringify({ hidden: false }),
      }),
    );
    expect(unhideRes.status).toBe(200);
    const visibleToBob = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads?state=all`, {
        headers: headersFor(BOB),
      }),
    );
    expect(
      ((await visibleToBob.json()) as { threads: ThreadShape[] }).threads.map(
        (thread) => thread.id,
      ),
    ).toContain(threadId);
  });

  test('hides an individual reply without hiding the rest of its thread', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);
    const created = await addComment(
      uid,
      ALICE,
      { block_id: blockId, quote: 'Title' },
      'Visible opener',
    );
    const threadId = (created.body.comment as { id: string }).id;
    const replied = await addReply(uid, BOB, threadId, 'Private follow-up @Alice');
    const replyId = (replied.body.comment as { id: string }).id;

    const hideRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}/comments/${replyId}`, {
        method: 'PATCH',
        headers: headersFor(BOB),
        body: JSON.stringify({ hidden: true }),
      }),
    );
    expect(hideRes.status).toBe(200);
    const bobThread = ((await hideRes.json()) as { thread: ThreadShape }).thread;
    expect(bobThread.comments).toHaveLength(2);
    expect(bobThread.comments[1]?.hidden).toBe(true);
    expect(bobThread.comments[1]?.capabilities.hide).toBe(true);

    const aliceList = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads?state=all`, {
        headers: headersFor(ALICE),
      }),
    );
    const aliceThread = ((await aliceList.json()) as { threads: ThreadShape[] }).threads[0];
    expect(aliceThread?.id).toBe(threadId);
    expect(aliceThread?.comments.map((comment) => comment.id)).toEqual([threadId]);

    const hiddenReplyLink = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads?thread_id=${replyId}`, {
        headers: headersFor(ALICE),
      }),
    );
    expect(((await hiddenReplyLink.json()) as { threads: ThreadShape[] }).threads).toHaveLength(0);

    const adminDelete = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}/comments/${replyId}`, {
        method: 'DELETE',
        headers: asAdmin(ALICE),
      }),
    );
    expect(adminDelete.status).toBe(404);

    const bundleRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/export`, { headers: headersFor(ALICE) }),
    );
    const bundle = (await bundleRes.json()) as { comments: Array<{ id: string }> };
    expect(bundle.comments.map((comment) => comment.id)).toEqual([threadId]);

    const unhideRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}/comments/${replyId}`, {
        method: 'PATCH',
        headers: headersFor(BOB),
        body: JSON.stringify({ hidden: false }),
      }),
    );
    expect(unhideRes.status).toBe(200);

    const visibleAgain = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads?state=all`, {
        headers: headersFor(ALICE),
      }),
    );
    expect(
      ((await visibleAgain.json()) as { threads: ThreadShape[] }).threads[0]?.comments.map(
        (comment) => comment.id,
      ),
    ).toEqual([threadId, replyId]);
  });

  test('rejects nested replies (only one level)', async () => {
    const uid = await newDoc('# Title\n');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hi');
    const topId = (r1.body as { comment: { id: string } }).comment.id;

    const r2 = await addReply(uid, BOB, topId, 'reply');
    const replyId = (r2.body as { comment: { id: string } }).comment.id;

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
    const replyId = (reply.body as { comment: { id: string } }).comment.id;

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

  test('re-anchoring: a quote spanning two children of one block stays linked', async () => {
    // The browser hands us a quote it read out of the DOM, so it carries the
    // whitespace between `</h2>` and `<p>`. Nothing in the block map is
    // allowed to lack that whitespace: the blockquote is the innermost
    // commentable element here (its heading and paragraph carry no
    // `data-block`), so a selection running from one child into the next has
    // no narrower block to fall back to, and a block map built from the
    // source AST — where the two children abut with no separator — cannot
    // contain the quote at all. The comment orphans on its first save.
    const source = '# Top\n\n> ## Quoted heading\n>\n> Body inside the quote.\n\nPlain para.\n';
    const uid = await newDoc(source);
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const j = (await res.json()) as {
      rendered: { blocks: Array<{ id: string; text: string; kind: string }> };
    };
    const quoteBlock = j.rendered.blocks.find((b) => b.kind === 'blockquote')!;
    expect(quoteBlock.text).toBe('Quoted heading Body inside the quote.');

    await addComment(
      uid,
      ALICE,
      { block_id: quoteBlock.id, quote: 'heading Body inside', prefix: 'Quoted ' },
      'spans the heading and the body',
    );

    const put = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, {
        method: 'PUT',
        headers: asAdmin(),
        body: JSON.stringify({ markdown: source.replace('# Top', '# Renamed') }),
      }),
    );
    expect(put.status).toBe(200);

    const comments = await list(uid, ALICE);
    expect(comments[0]!.link_status).toBe('linked');
    // Offset into the rendered text: "Quoted " is 7 characters, the last of
    // which is the whitespace the source AST does not have.
    expect((comments[0]!.anchor as ThreadAnchorShape).start_offset).toBe(7);
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

  describe('multi-block anchors', () => {
    const SPAN_DOC = '# Title\n\nAlpha one.\n\nBravo two.\n\nCharlie three.\n';
    const SPAN_SEPARATOR = '\n\n';

    async function paragraphIds(uid: string): Promise<string[]> {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
      );
      const j = (await res.json()) as {
        rendered: { blocks: Array<{ id: string; kind: string }> };
      };
      return j.rendered.blocks.filter((b) => b.kind === 'paragraph').map((b) => b.id);
    }

    /** Comment spanning all three paragraphs, each covered whole. */
    async function addSpan(uid: string, ids: string[]): Promise<string> {
      const fragments = ['Alpha one.', 'Bravo two.', 'Charlie three.'];
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads`, {
          method: 'POST',
          headers: headersFor(ALICE),
          body: JSON.stringify({
            anchor: {
              block_id: ids[0],
              end_block_id: ids[2],
              quote: fragments.join(SPAN_SEPARATOR),
              prefix: '',
              suffix: '',
              start_offset: 0,
              end_offset: fragments[2]!.length,
            },
            body: 'spans three paragraphs',
          }),
        }),
      );
      expect(res.status).toBe(201);
      const j = (await res.json()) as { thread: ThreadShape };
      return j.thread.id;
    }

    async function save(uid: string, markdown: string): Promise<void> {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}`, {
          method: 'PUT',
          headers: asAdmin(),
          body: JSON.stringify({ markdown }),
        }),
      );
      expect(res.status).toBe(200);
    }

    async function anchorOf(uid: string): Promise<ThreadAnchorShape> {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads`, { headers: headersFor(ALICE) }),
      );
      const j = (await res.json()) as { threads: ThreadShape[] };
      return j.threads[0]!.anchor;
    }

    test('round-trips end_block_id and the joined quote', async () => {
      const uid = await newDoc(SPAN_DOC);
      const ids = await paragraphIds(uid);
      await addSpan(uid, ids);

      const anchor = await anchorOf(uid);
      expect(anchor.block_id).toBe(ids[0]!);
      expect(anchor.end_block_id).toBe(ids[2]!);
      expect(anchor.quote!.split(SPAN_SEPARATOR)).toEqual([
        'Alpha one.',
        'Bravo two.',
        'Charlie three.',
      ]);
      expect(anchor.end_offset).toBe('Charlie three.'.length);
    });

    test('stays linked when only the text between the endpoints changes', async () => {
      const uid = await newDoc(SPAN_DOC);
      const ids = await paragraphIds(uid);
      await addSpan(uid, ids);

      await save(uid, '# Title\n\nAlpha one.\n\nBravo two, rewritten.\n\nCharlie three.\n');

      const anchor = await anchorOf(uid);
      expect(anchor.block_id).toBe(ids[0]!);
      expect(anchor.end_block_id).toBe(ids[2]!);
      const threads = await list(uid, ALICE);
      expect(threads[0]!.link_status).toBe('linked');
    });

    test('collapses onto the head when the last block disappears', async () => {
      const uid = await newDoc(SPAN_DOC);
      const ids = await paragraphIds(uid);
      await addSpan(uid, ids);

      await save(uid, '# Title\n\nAlpha one.\n\nBravo two.\n');

      const anchor = await anchorOf(uid);
      expect(anchor.block_id).toBe(ids[0]!);
      expect(anchor.end_block_id).toBeNull();
      // The quote is rewritten so it still describes `block_id` alone.
      expect(anchor.quote).toBe('Alpha one.');
      const threads = await list(uid, ALICE);
      expect(threads[0]!.link_status).toBe('low-confidence');
    });

    test('collapses onto the tail when the first block disappears', async () => {
      const uid = await newDoc(SPAN_DOC);
      const ids = await paragraphIds(uid);
      await addSpan(uid, ids);

      await save(uid, '# Title\n\nBravo two.\n\nCharlie three.\n');

      const anchor = await anchorOf(uid);
      expect(anchor.block_id).toBe(ids[2]!);
      expect(anchor.end_block_id).toBeNull();
      expect(anchor.quote).toBe('Charlie three.');
      const threads = await list(uid, ALICE);
      expect(threads[0]!.link_status).toBe('low-confidence');
    });

    test('orphans when both endpoints disappear', async () => {
      const uid = await newDoc(SPAN_DOC);
      const ids = await paragraphIds(uid);
      await addSpan(uid, ids);

      await save(uid, '# Title\n\nBravo two.\n');

      const anchor = await anchorOf(uid);
      expect(anchor.block_id).toBeNull();
      expect(anchor.end_block_id).toBeNull();
      const threads = await list(uid, ALICE);
      expect(threads[0]!.link_status).toBe('orphaned');
    });

    test('collapses when an edit reverses the endpoints', async () => {
      const uid = await newDoc(SPAN_DOC);
      const ids = await paragraphIds(uid);
      await addSpan(uid, ids);

      // Same blocks, opposite order: the span no longer runs forwards.
      await save(uid, '# Title\n\nCharlie three.\n\nBravo two.\n\nAlpha one.\n');

      const anchor = await anchorOf(uid);
      expect(anchor.block_id).toBe(ids[0]!);
      expect(anchor.end_block_id).toBeNull();
      expect(anchor.quote).toBe('Alpha one.');
      const threads = await list(uid, ALICE);
      expect(threads[0]!.link_status).toBe('low-confidence');
    });

    test('single-block comments are unaffected by span handling', async () => {
      const uid = await newDoc(SPAN_DOC);
      const ids = await paragraphIds(uid);
      await addComment(uid, ALICE, { block_id: ids[1]!, quote: 'Bravo' }, 'c');

      await save(uid, '# New Title\n\nAlpha one.\n\nBravo two.\n\nCharlie three.\n');

      const anchor = await anchorOf(uid);
      expect(anchor.block_id).toBe(ids[1]!);
      expect(anchor.end_block_id).toBeNull();
      expect(anchor.quote).toBe('Bravo');
      const threads = await list(uid, ALICE);
      expect(threads[0]!.link_status).toBe('linked');
    });
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
    expect(thread?.comments.slice(1)).toEqual([]);
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

  test('proposal can set block text to empty string', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: {
            block_id: blockId,
            quote: 'Title',
            start_offset: 0,
            end_offset: 5,
          },
          proposal: {
            anchor_kind: 'heading',
            proposed_text: '',
          },
        }),
      }),
    );

    expect(res.status).toBe(201);
    const created = (await res.json()) as { thread: ThreadShape };
    expect(created.thread.proposal).toBeDefined();
    const diffRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${created.thread.id}/diff`, {
        headers: headersFor(BOB),
      }),
    );
    expect(diffRes.status).toBe(200);
    expect(((await diffRes.json()) as { after: string }).after).toBe('');

    const acceptRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${created.thread.id}/respond`, {
        method: 'POST',
        headers: asAdmin(),
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
    expect(acceptRes.status).toBe(200);
    const stored = app.db
      .prepare(
        `SELECT anchor_start_offset, anchor_end_offset
           FROM comments
          WHERE id = ?`,
      )
      .get(created.thread.id) as {
      anchor_start_offset: number | null;
      anchor_end_offset: number | null;
    };
    expect(stored).toEqual({ anchor_start_offset: 0, anchor_end_offset: 5 });
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

  test('orphaned proposal repair uses git merge placement to restore its anchor', async () => {
    const uid = await newDoc('**alpha**\n\nbeta\n');
    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const docJson = (await docRes.json()) as {
      rendered: { blocks: Array<{ id: string; text: string }> };
    };
    const alpha = docJson.rendered.blocks.find((block) => block.text === 'alpha');
    expect(alpha).toBeDefined();
    if (!alpha) throw new Error('alpha block missing');

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: alpha.id, quote: 'alpha' },
          proposal: { proposed_text: 'ALPHA' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposed = (await proposeRes.json()) as { thread: ThreadShape };

    const updateRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, {
        method: 'PUT',
        headers: asAdmin(),
        body: JSON.stringify({ markdown: '**alpha**\n\nbeta\n\noutro\n' }),
      }),
    );
    expect(updateRes.status).toBe(200);

    app.db
      .prepare(
        `UPDATE comments
            SET link_status = 'orphaned',
                anchor_block_id = NULL,
                anchor_end_block_id = NULL
          WHERE id = ?`,
      )
      .run(proposed.thread.id);

    const repairRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${proposed.thread.id}/repair`, {
        method: 'POST',
        headers: headersFor(BOB),
      }),
    );
    expect(repairRes.status).toBe(200);
    const repaired = (await repairRes.json()) as { thread: ThreadShape };
    expect(repaired.thread.link_status).toBe('linked');
    expect(repaired.thread.anchor.block_id).toBeString();
    expect(repaired.thread.anchor.quote).toBe('**alpha**');
    expect(repaired.thread.capabilities.repair).toBe(false);

    const beforeAcceptRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: asAdmin() }),
    );
    const beforeAccept = (await beforeAcceptRes.json()) as { source: string };
    expect(beforeAccept.source).toBe('**alpha**\n\nbeta\n\noutro\n');

    const acceptRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${proposed.thread.id}/respond`, {
        method: 'POST',
        headers: asAdmin(),
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
    expect(acceptRes.status).toBe(200);

    const afterRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: asAdmin() }),
    );
    const after = (await afterRes.json()) as { source: string };
    expect(after.source).toBe('ALPHA\n\nbeta\n\noutro\n');
  });

  test('conflicting proposal repair falls back to original line number anchor', async () => {
    const uid = await newDoc('# Welcome\n\nThreaded comments you can resolve\n\nTail\n');
    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const docJson = (await docRes.json()) as {
      rendered: { blocks: Array<{ id: string; text: string }> };
    };
    const target = docJson.rendered.blocks.find(
      (block) => block.text === 'Threaded comments you can resolve',
    );
    expect(target).toBeDefined();
    if (!target) throw new Error('target block missing');

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: target.id, quote: 'Threaded comments you can resolve' },
          proposal: { proposed_text: 'Threaded comments you can resolve or reject' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposed = (await proposeRes.json()) as { thread: ThreadShape };

    const updateRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, {
        method: 'PUT',
        headers: asAdmin(),
        body: JSON.stringify({ markdown: '# Welcome\n\nThese comments you can resolve\n\nTail\n' }),
      }),
    );
    expect(updateRes.status).toBe(200);

    app.db
      .prepare(
        `UPDATE comments
            SET link_status = 'orphaned',
                anchor_block_id = NULL,
                anchor_end_block_id = NULL
          WHERE id = ?`,
      )
      .run(proposed.thread.id);

    const repairRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${proposed.thread.id}/repair`, {
        method: 'POST',
        headers: headersFor(BOB),
      }),
    );
    expect(repairRes.status).toBe(200);
    const repaired = (await repairRes.json()) as { thread: ThreadShape };
    expect(repaired.thread.link_status).toBe('conflict');
    expect(repaired.thread.anchor.block_id).toBeString();
    expect(repaired.thread.anchor.quote).toBe('These comments you can resolve');
    expect(repaired.thread.capabilities.accept).toBe(false);
    expect(repaired.thread.capabilities.repair).toBe(false);

    const acceptRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${proposed.thread.id}/respond`, {
        method: 'POST',
        headers: asAdmin(),
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
    expect(acceptRes.status).toBe(409);
    expect(await acceptRes.json()).toEqual({ error: 'proposal-conflict' });
  });

  test('accept answers 503 proposal-merge-unavailable when the merge tool is missing', async () => {
    // A deployment without `git` cannot run the three-way merge that
    // backs accept. That must not come back as 409 proposal-conflict:
    // the proposal is fine and the user has nothing to fix.
    // Sequentially accepted siblings build the criss-cross history that
    // iso-git's merge refuses, which is the only route to the native
    // fallback — and the shape a busy review document ends up in.
    const paras = [1, 2, 3, 4, 5, 6].map((n) => `Para ${n} baseline.`);
    const uid = await newDoc(`# Welcome\n\n${paras.join('\n\n')}\n`);

    const blockFor = async (text: string) => {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
      );
      const json = (await res.json()) as {
        rendered: { blocks: Array<{ id: string; text: string }> };
      };
      const block = json.rendered.blocks.find((b) => b.text === text);
      if (!block) throw new Error(`missing block: ${text}`);
      return block.id;
    };
    const propose = async (text: string, replacement: string) => {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads`, {
          method: 'POST',
          headers: headersFor(BOB),
          body: JSON.stringify({
            anchor: { block_id: await blockFor(text), quote: text },
            proposal: { proposed_text: replacement },
          }),
        }),
      );
      expect(res.status).toBe(201);
      return ((await res.json()) as { thread: ThreadShape }).thread.id;
    };
    const accept = (id: string) =>
      app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads/${id}/respond`, {
          method: 'POST',
          headers: asAdmin(),
          body: JSON.stringify({ action: 'accept' }),
        }),
      );

    const ids: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      ids.push(await propose(`Para ${n} baseline.`, `Para ${n} edited.`));
    }
    for (const n of [0, 1]) expect((await accept(ids[n]!)).status).toBe(200);

    // Branched off the intermediate merge commit, so accepting the rest
    // leaves this one with several merge bases.
    const late = await propose('Para 6 baseline.', 'Para 6 edited.');
    for (const n of [2, 3, 4]) expect((await accept(ids[n]!)).status).toBe(200);

    const realPath = process.env.PATH;
    process.env.PATH = join(dir, 'no-binaries-here');
    try {
      const res = await accept(late);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'proposal-merge-unavailable' });
    } finally {
      // Assigning `undefined` back would leave the key defined (and under
      // Node would set the literal string "undefined"), so an unset PATH
      // has to be restored by deleting it.
      if (realPath === undefined) delete process.env.PATH;
      else process.env.PATH = realPath;
    }

    // Nothing was recorded against the proposal: with git back it
    // accepts normally.
    expect((await accept(late)).status).toBe(200);
  });

  test('multi-block proposal: rejects table-cell endpoints as orphaned', async () => {
    // A table-cell id sneaking in as the end of a multi-block range
    // would splice mid-row through `|` pipes and corrupt the table.
    // The server must refuse to resolve such a range. (List-item
    // endpoints are accepted — see the test below.)
    const uid = await newDoc(
      '# H\n\n| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n\nTrailing paragraph.\n',
    );
    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const docJson = (await docRes.json()) as {
      rendered: { html: string; blocks: Array<{ id: string; text: string }> };
    };
    const heading = docJson.rendered.blocks[0]!;
    // Pull a sub-block id (table cell) from the rendered HTML.
    const subBlockId = docJson.rendered.html.match(/data-subblock="([^"]+)"/)?.[1];
    expect(subBlockId).toBeDefined();

    // Multi-block range across a table cell is structurally invalid
    // (`canMergeMultiBlock` rejects table-cell endpoints). Phase 3
    // makes the branch + base metadata mandatory at create time, so
    // the locator's null result becomes a 400 at create rather than
    // an orphan at accept.
    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: {
            block_id: heading.id,
            end_block_id: subBlockId,
            quote: 'H',
          },
          proposal: { anchor_kind: 'heading', proposed_text: 'corrupt' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(400);
    expect(await proposeRes.json()).toEqual({ error: 'anchor-block-not-found' });
  });

  test('over-long anchor.quote / prefix / suffix is rejected with anchor-too-long', async () => {
    const uid = await newDoc('# Title\n');
    const blockId = await firstBlockId(uid);
    const oversizeQuote = 'q'.repeat(60001);
    const oversizeContext = 'c'.repeat(1025);

    const cases = [
      { anchor: { block_id: blockId, quote: oversizeQuote }, label: 'quote' },
      { anchor: { block_id: blockId, quote: 'Title', prefix: oversizeContext }, label: 'prefix' },
      { anchor: { block_id: blockId, quote: 'Title', suffix: oversizeContext }, label: 'suffix' },
    ];
    for (const { anchor } of cases) {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads`, {
          method: 'POST',
          headers: headersFor(BOB),
          body: JSON.stringify({ anchor, body: 'note' }),
        }),
      );
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'anchor-too-long' });
    }
  });

  test('proposed_text exceeding the size limit returns proposal-text-too-long', async () => {
    const uid = await newDoc('# Title\n');
    const blockId = await firstBlockId(uid);
    const tooLong = 'x'.repeat(60001);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          proposal: { anchor_kind: 'heading', proposed_text: tooLong },
        }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'proposal-text-too-long' });
  });

  test('multi-block proposal: stores end_block_id, accept splices the whole span and clears the column', async () => {
    const uid = await newDoc('Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n');

    // Pull all rendered top-level block IDs.
    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const docJson = (await docRes.json()) as {
      rendered: { blocks: Array<{ id: string; text: string }> };
    };
    const [alpha, beta, gamma] = docJson.rendered.blocks;
    expect(alpha?.text).toContain('Alpha');
    expect(beta?.text).toContain('Beta');
    expect(gamma?.text).toContain('Gamma');

    // Multi-block proposal spanning Alpha → Gamma.
    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: {
            block_id: alpha!.id,
            end_block_id: gamma!.id,
            quote: 'Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.',
          },
          proposal: { anchor_kind: 'paragraph', proposed_text: 'REPLACED.' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposed = (await proposeRes.json()) as {
      thread: ThreadShape & { anchor: ThreadAnchorShape & { end_block_id: string | null } };
    };
    expect(proposed.thread.anchor.block_id).toBe(alpha!.id);
    expect(proposed.thread.anchor.end_block_id).toBe(gamma!.id);

    // Accept by admin → all three paragraphs collapse to "REPLACED."
    const acceptRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${proposed.thread.id}/respond`, {
        method: 'POST',
        headers: asAdmin(),
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
    expect(acceptRes.status).toBe(200);

    // The document now contains exactly the proposed_text where the
    // three paragraphs used to be (no leftover Beta).
    const afterRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const after = (await afterRes.json()) as { source: string };
    expect(after.source.trim()).toBe('REPLACED.');

    // Post-accept the proposal anchor collapses to single-block: the
    // server clears `anchor_end_block_id` so a future reopen / read
    // doesn't carry stale endpoints.
    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads?thread_id=${proposed.thread.id}`, {
        headers: headersFor(ALICE),
      }),
    );
    const listJson = (await listRes.json()) as {
      threads: Array<ThreadShape & { anchor: ThreadAnchorShape & { end_block_id: string | null } }>;
    };
    const accepted = listJson.threads.find((t) => t.id === proposed.thread.id);
    expect(accepted).toBeDefined();
    expect(accepted!.anchor.end_block_id).toBeNull();
  });

  test('multi-block proposal: a save that breaks the span orphans it, never shrinks it', async () => {
    // A proposal's quote is also `\n\n`-joined, but it is a snapshot of
    // the spliced source, not a per-block fragment list. Comment
    // re-anchoring must leave it alone: collapsing it onto its head
    // would leave the proposal open and quietly re-targeted at one
    // paragraph, so accepting it would replace the wrong span.
    const uid = await newDoc('Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.\n');
    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const docJson = (await docRes.json()) as {
      rendered: { blocks: Array<{ id: string; text: string }> };
    };
    const [alpha, , gamma] = docJson.rendered.blocks;

    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: {
            block_id: alpha!.id,
            end_block_id: gamma!.id,
            quote: 'Alpha paragraph.\n\nBeta paragraph.\n\nGamma paragraph.',
          },
          proposal: { anchor_kind: 'paragraph', proposed_text: 'REPLACED.' },
        }),
      }),
    );
    expect(proposeRes.status).toBe(201);
    const proposalId = ((await proposeRes.json()) as { thread: ThreadShape }).thread.id;

    // Rewrite the span's last paragraph: its content-hash id changes, so
    // the far endpoint no longer resolves.
    const put = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, {
        method: 'PUT',
        headers: asAdmin(),
        body: JSON.stringify({
          markdown: 'Alpha paragraph.\n\nBeta paragraph.\n\nDelta paragraph.\n',
        }),
      }),
    );
    expect(put.status).toBe(200);

    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, { headers: headersFor(ALICE) }),
    );
    const { threads } = (await listRes.json()) as { threads: ThreadShape[] };
    const proposal = threads.find((t) => t.id === proposalId);
    expect(proposal).toBeDefined();
    expect(proposal!.link_status).toBe('orphaned');
  });

  test('multi-block proposal: list-item endpoints span the items and splice cleanly', async () => {
    // List items have line-aligned source ranges, so a multi-listItem
    // span is a clean splice (unlike table cells, which would slice
    // across `|` pipes). Selecting a subset of items in the UI emits
    // first→last list-item ids, and accepting the proposal must replace
    // exactly those items, leaving surrounding list items intact.
    const uid = await newDoc('Intro paragraph.\n\n- one\n- two\n- three\n- four\n\nOutro.\n');

    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const docJson = (await docRes.json()) as {
      rendered: { html: string };
    };
    const subBlockIds = [...docJson.rendered.html.matchAll(/data-subblock="([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(subBlockIds.length).toBe(4);
    const [, two, three] = subBlockIds;

    // Multi-block proposal spanning items "two" → "three". Items
    // "one" and "four" must be untouched.
    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: {
            block_id: two,
            end_block_id: three,
            quote: 'two\nthree',
          },
          proposal: { anchor_kind: 'listItem', proposed_text: '- TWO\n- THREE\n' },
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

    const afterRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const after = (await afterRes.json()) as { source: string };
    expect(after.source).toContain('- one\n');
    expect(after.source).toContain('- TWO\n');
    expect(after.source).toContain('- THREE\n');
    expect(after.source).toContain('- four\n');
    expect(after.source).not.toMatch(/- two\b/);
    expect(after.source).not.toMatch(/- three\b/);
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
      new Request(`http://test/api/documents/${uid}/threads?thread_id=${proposed.thread.id}`, {
        headers: headersFor(BOB),
      }),
    );
    const bobBody = (await bobList.json()) as {
      threads: Array<{ id: string; comments: [{ capabilities: { delete: boolean } }] }>;
    };
    expect(
      bobBody.threads.find((thread) => thread.id === proposed.thread.id)?.comments[0].capabilities
        .delete,
    ).toBe(false);

    const adminList = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads?thread_id=${proposed.thread.id}`, {
        headers: asAdmin(),
      }),
    );
    const adminBody = (await adminList.json()) as {
      threads: Array<{ id: string; comments: [{ capabilities: { delete: boolean } }] }>;
    };
    expect(
      adminBody.threads.find((thread) => thread.id === proposed.thread.id)?.comments[0].capabilities
        .delete,
    ).toBe(true);
  });

  /** Bob proposes `proposed_text` for the doc's first block, admin accepts. */
  async function acceptedProposal(uid: string, rationale: string, proposedText: string) {
    const blockId = await firstBlockId(uid);
    const proposeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: blockId, quote: 'Title' },
          body: rationale,
          proposal: { anchor_kind: 'heading', proposed_text: proposedText },
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
    return proposed.thread.id;
  }

  test('deleting an accepted proposal keeps the history attribution', async () => {
    const uid = await newDoc('# Title');
    const threadId = await acceptedProposal(uid, 'Sharper title', '# Better title');

    const bobDelete = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}`, {
        method: 'DELETE',
        headers: headersFor(BOB),
      }),
    );
    expect(bobDelete.status).toBe(403);
    expect(((await bobDelete.json()) as { error: string }).error).toBe('forbidden-accepted');

    const adminDelete = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}`, {
        method: 'DELETE',
        headers: asAdmin(),
      }),
    );
    expect(adminDelete.status).toBe(204);

    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, { headers: asAdmin() }),
    );
    const listBody = (await listRes.json()) as { threads: ThreadShape[] };
    expect(listBody.threads.find((t) => t.id === threadId)).toBeUndefined();

    const historyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/history`, { headers: asAdmin() }),
    );
    expect(historyRes.status).toBe(200);
    const { history } = (await historyRes.json()) as {
      history: Array<{
        action: string;
        proposal: {
          id: string;
          author: { display_name: string };
          summary: string;
          deleted: boolean;
        } | null;
      }>;
    };
    const acceptEntry = history.find((e) => e.action === 'accept-proposal');
    expect(acceptEntry?.proposal).toMatchObject({
      id: threadId,
      author: { display_name: BOB.name },
      summary: 'Sharper title',
      deleted: true,
    });

    // The accepted tip stays reachable via its branch ref.
    expect(await app.store.readProposalTip({ uid, format: 'markdown' as const }, threadId)).toBe(
      '# Better title',
    );
  });

  test('reverting an accept after the proposal thread was deleted does not resurrect it', async () => {
    const uid = await newDoc('# Title');
    const threadId = await acceptedProposal(uid, 'Sharper title', '# Better title');

    const adminDelete = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}`, {
        method: 'DELETE',
        headers: asAdmin(),
      }),
    );
    expect(adminDelete.status).toBe(204);

    const historyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/history`, { headers: asAdmin() }),
    );
    const { history } = (await historyRes.json()) as { history: Array<{ oid: string }> };

    const revertRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/history/${history[0]!.oid}/revert`, {
        method: 'POST',
        headers: asAdmin(),
      }),
    );
    expect(revertRes.status).toBe(200);
    const revert = (await revertRes.json()) as { reopened_proposal_id: string | null };
    expect(revert.reopened_proposal_id).toBeNull();

    const docRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: asAdmin() }),
    );
    expect(((await docRes.json()) as { source: string }).source).toBe('# Title');

    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, { headers: asAdmin() }),
    );
    const listBody = (await listRes.json()) as { threads: ThreadShape[] };
    expect(listBody.threads.find((t) => t.id === threadId)).toBeUndefined();
  });

  /** Export `uid`, import the bundle back, and hand over the new doc's admin headers. */
  async function roundTrip(uid: string): Promise<{
    bundle: { document: { source: string }; comments: unknown[]; history: unknown };
    serialized: string;
    imported: { uid: string; imported_comments: number };
    headers: Headers;
  }> {
    const exportRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/export`, { headers: asAdmin() }),
    );
    expect(exportRes.status).toBe(200);
    const bundle = (await exportRes.json()) as {
      document: { source: string };
      comments: unknown[];
      history: unknown;
    };
    const serialized = JSON.stringify(bundle);

    const importRes = await app.hono.fetch(
      new Request('http://test/api/documents/import', {
        method: 'POST',
        headers: rawHeadersFor(ALICE),
        body: serialized,
      }),
    );
    expect(importRes.status).toBe(201);
    const imported = (await importRes.json()) as {
      uid: string;
      imported_comments: number;
      admin_invite: { token: string };
    };
    const headers = rawHeadersFor(ALICE);
    headers.set(INVITE_HEADER, imported.admin_invite.token);
    return { bundle, serialized, imported, headers };
  }

  /**
   * The bundle is emitted as JSON fragments around a streamed packfile
   * rather than serialized whole, so the seams are worth pinning: a
   * mis-spliced fragment yields either invalid JSON or a plausible
   * bundle missing a field, and only the second one gets past a
   * round-trip test.
   */
  test('the streamed bundle is well-formed and keeps its field order', async () => {
    const uid = await newDoc('# Title');
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/export`, { headers: asAdmin() }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toContain('.marginalia.json');

    const bundle = JSON.parse(await res.text()) as Record<string, unknown>;
    expect(Object.keys(bundle)).toEqual([
      'version',
      'kind',
      'exported_at',
      'document',
      'representation',
      'comments',
      'history',
      'participants',
    ]);
    expect(bundle.version).toBe(5);
    expect(Object.keys(bundle.history as object)).toEqual(['pack_base64', 'head_oid', 'commits']);
    // Base64 with no interior padding — the tell that chunks were
    // encoded independently instead of across the byte stream.
    const packBase64 = (bundle.history as { pack_base64: string }).pack_base64;
    expect(packBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(Buffer.from(packBase64, 'base64').subarray(0, 4).toString()).toBe('PACK');
  });

  test('a deleted comment thread leaves no trace in a bundle', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);
    const added = await addComment(uid, BOB, { block_id: blockId, quote: 'Title' }, 'secret note');
    const threadId = (added.body as { comment: { id: string } }).comment.id;

    const deleteRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}`, {
        method: 'DELETE',
        headers: asAdmin(),
      }),
    );
    expect(deleteRes.status).toBe(204);

    // A plain comment decorates no history entry, so nothing about it
    // needs to survive — not the body, not the id.
    const { bundle, serialized, imported } = await roundTrip(uid);
    expect(bundle.comments).toHaveLength(0);
    expect(serialized).not.toContain(threadId);
    expect(serialized).not.toContain('secret note');
    expect(imported.imported_comments).toBe(0);
  });

  test('a deleted accepted proposal keeps its history attribution through a round-trip', async () => {
    const uid = await newDoc('# Title');
    const threadId = await acceptedProposal(uid, 'Sharper title', '# Better title');

    const deleteRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${threadId}`, {
        method: 'DELETE',
        headers: asAdmin(),
      }),
    );
    expect(deleteRes.status).toBe(204);

    const { bundle, imported, headers } = await roundTrip(uid);
    expect(bundle.document.source).toBe('# Better title');
    // The tombstone travels so the accept commit stays attributable, but
    // it is not a comment anyone can see.
    expect(bundle.comments).toHaveLength(1);
    expect(imported.imported_comments).toBe(0);

    const listRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}/threads`, { headers }),
    );
    const listBody = (await listRes.json()) as { threads: ThreadShape[] };
    expect(listBody.threads).toHaveLength(0);

    const historyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}/history`, { headers }),
    );
    const { history } = (await historyRes.json()) as {
      history: Array<{
        action: string;
        proposal: { author: { display_name: string }; summary: string; deleted: boolean } | null;
      }>;
    };
    const accepted = history.find((e) => e.action === 'accept-proposal');
    expect(accepted?.proposal).toMatchObject({
      author: { display_name: BOB.name },
      summary: 'Sharper title',
      deleted: true,
    });
  });

  test('a bundle round-trip preserves the full document history', async () => {
    const uid = await newDoc('# Title');
    await acceptedProposal(uid, 'Sharper title', '# Better title');

    const beforeRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/history`, { headers: asAdmin() }),
    );
    const before = (await beforeRes.json()) as {
      history: Array<{
        oid: string;
        action: string;
        actor: { display_name: string | null };
        timestamp: number;
      }>;
    };
    expect(before.history.map((e) => e.action)).toEqual(['accept-proposal', 'upload']);

    const { imported, headers } = await roundTrip(uid);
    const afterRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}/history`, { headers }),
    );
    const after = (await afterRes.json()) as {
      history: Array<{
        oid: string;
        action: string;
        actor: { display_name: string | null };
        timestamp: number;
        proposal: { author: { display_name: string }; deleted: boolean } | null;
      }>;
    };

    // Same commits, same identities, same times — not a re-upload.
    expect(after.history.map((e) => e.oid)).toEqual(before.history.map((e) => e.oid));
    expect(after.history.map((e) => e.action)).toEqual(['accept-proposal', 'upload']);
    expect(after.history.map((e) => e.timestamp)).toEqual(before.history.map((e) => e.timestamp));
    expect(after.history.map((e) => e.actor.display_name)).toEqual(
      before.history.map((e) => e.actor.display_name),
    );
    // A live (undeleted) proposal keeps its attribution too.
    expect(after.history[0]?.proposal).toMatchObject({
      author: { display_name: BOB.name },
      deleted: false,
    });

    // Historical diffs are real, not reconstructed.
    const diffRes = await app.hono.fetch(
      new Request(
        `http://test/api/documents/${imported.uid}/history/${after.history[0]!.oid}/diff`,
        { headers },
      ),
    );
    expect(diffRes.status).toBe(200);
    const diff = (await diffRes.json()) as { before: string; after: string };
    expect(diff.before).toBe('# Title');
    expect(diff.after).toBe('# Better title');
  });

  test('an oversized participant roster is capped rather than rejected', async () => {
    const uid = await newDoc('# Title');
    await acceptedProposal(uid, 'Sharper title', '# Better title');

    const exportRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/export`, { headers: asAdmin() }),
    );
    const bundle = (await exportRes.json()) as Record<string, unknown> & {
      participants: Array<{ client_id: string; display_name: string }>;
    };
    // Bob (the real proposal author) stays inside the retained slice;
    // padding pushes the roster well past the cap so the endpoint has
    // to truncate instead of importing all of it.
    const padded = [
      ...bundle.participants,
      ...Array.from({ length: 5100 }, (_, i) => ({
        client_id: `padding-client-${i}`,
        display_name: `Padding ${i}`,
      })),
    ];

    const importRes = await app.hono.fetch(
      new Request('http://test/api/documents/import', {
        method: 'POST',
        headers: rawHeadersFor(ALICE),
        body: JSON.stringify({ ...bundle, participants: padded }),
      }),
    );
    expect(importRes.status).toBe(201);
    const imported = (await importRes.json()) as { uid: string; admin_invite: { token: string } };
    const headers = rawHeadersFor(ALICE);
    headers.set(INVITE_HEADER, imported.admin_invite.token);

    // The real participant's attribution survives the cap.
    const historyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${imported.uid}/history`, { headers }),
    );
    const { history } = (await historyRes.json()) as {
      history: Array<{ action: string; proposal: { author: { display_name: string } } | null }>;
    };
    expect(history.find((e) => e.action === 'accept-proposal')?.proposal?.author.display_name).toBe(
      BOB.name,
    );
  });

  test('an importable bundle without history still lands as a single upload', async () => {
    const uid = await newDoc('# Title');
    await acceptedProposal(uid, 'Sharper title', '# Better title');

    const exportRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/export`, { headers: asAdmin() }),
    );
    const bundle = (await exportRes.json()) as Record<string, unknown>;
    // Stand in for a pre-v5 bundle, a corrupt pack, and an oversized
    // one: all three must degrade to a plain import rather than either
    // failing it or decoding an unbounded buffer.
    const oversizedPack = {
      pack_base64: 'A'.repeat(90 * 1024 * 1024),
      head_oid: 'f'.repeat(40),
    };
    for (const history of [
      null,
      { pack_base64: 'bm90LWEtcGFjaw==', head_oid: 'f'.repeat(40) },
      oversizedPack,
    ]) {
      const importRes = await app.hono.fetch(
        new Request('http://test/api/documents/import', {
          method: 'POST',
          headers: rawHeadersFor(ALICE),
          body: JSON.stringify({ ...bundle, version: 4, history }),
        }),
      );
      expect(importRes.status).toBe(201);
      const imported = (await importRes.json()) as {
        uid: string;
        admin_invite: { token: string };
      };
      const headers = rawHeadersFor(ALICE);
      headers.set(INVITE_HEADER, imported.admin_invite.token);

      const docRes = await app.hono.fetch(
        new Request(`http://test/api/documents/${imported.uid}`, { headers }),
      );
      expect(((await docRes.json()) as { source: string }).source).toBe('# Better title');
      const historyRes = await app.hono.fetch(
        new Request(`http://test/api/documents/${imported.uid}/history`, { headers }),
      );
      const { history: entries } = (await historyRes.json()) as {
        history: Array<{ action: string }>;
      };
      expect(entries.map((e) => e.action)).toEqual(['upload']);
    }
  });

  /**
   * Dropping a history is a real loss for the importer, and until it is
   * said out loud the only trace is a server log nobody reading the
   * response ever sees. `absent` and `dropped` have to stay
   * distinguishable: one is every pre-v5 bundle, the other is a bundle
   * whose timeline we threw away.
   */
  test('an import reports whether the bundle history survived', async () => {
    const uid = await newDoc('# Title');
    await acceptedProposal(uid, 'Sharper title', '# Better title');
    const exportRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/export`, { headers: asAdmin() }),
    );
    const bundle = (await exportRes.json()) as Record<string, unknown>;

    const importWith = async (history: unknown) => {
      const res = await app.hono.fetch(
        new Request('http://test/api/documents/import', {
          method: 'POST',
          headers: rawHeadersFor(ALICE),
          body: JSON.stringify({ ...bundle, history }),
        }),
      );
      expect(res.status).toBe(201);
      return (await res.json()) as { imported_history: string };
    };

    expect((await importWith(bundle.history)).imported_history).toBe('restored');
    expect((await importWith(null)).imported_history).toBe('absent');
    expect(
      (await importWith({ pack_base64: 'bm90LWEtcGFjaw==', head_oid: 'f'.repeat(40) }))
        .imported_history,
    ).toBe('dropped');
  });

  /**
   * The reason a pack was refused is the whole diagnosis — a truncated
   * transfer, corrupt bytes, and a missing head commit are three
   * different problems that all reach this one line.
   */
  test('a refused history pack logs why, not just that', async () => {
    const uid = await newDoc('# Title');
    const exportRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/export`, { headers: asAdmin() }),
    );
    const bundle = (await exportRes.json()) as Record<string, unknown>;
    const good = bundle.history as { pack_base64: string; head_oid: string };
    // Truncated mid-pack: indexes far enough to look like a pack, then
    // fails its trailing checksum.
    const truncated = Buffer.from(good.pack_base64, 'base64');
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(String(args[0]));
    try {
      for (const history of [
        { ...good, pack_base64: truncated.subarray(0, truncated.length - 8).toString('base64') },
        { ...good, head_oid: '0'.repeat(40) },
        { pack_base64: good.pack_base64, head_oid: 'nonsense' },
      ]) {
        const res = await app.hono.fetch(
          new Request('http://test/api/documents/import', {
            method: 'POST',
            headers: rawHeadersFor(ALICE),
            body: JSON.stringify({ ...bundle, history }),
          }),
        );
        expect(res.status).toBe(201);
      }
    } finally {
      console.warn = original;
    }

    expect(warnings).toHaveLength(3);
    for (const line of warnings) {
      expect(line).toContain('seeding a fresh repo');
      // One line each: git's own errors run to several paragraphs of
      // bug-report boilerplate, which is unreadable in a container log.
      expect(line).not.toContain('\n');
    }
    // Each names its own cause rather than sharing one generic sentence.
    expect(warnings[0]).toContain('Packfile payload corrupted');
    expect(warnings[1]).toContain(`Could not find ${'0'.repeat(40)}`);
    expect(warnings[2]).toContain('head oid is malformed');
  });

  test('resolving a reply is rejected', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'top');
    const topId = (r1.body as { comment: { id: string } }).comment.id;

    const replyRes = await addReply(uid, BOB, topId, 'reply');
    const replyId = (replyRes.body as { comment: { id: string } }).comment.id;

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
    expect(thread.capabilities.resolve).toBe(true); // author may resolve
    expect(thread.capabilities.accept).toBe(false); // not a proposal
    expect(thread.capabilities.reject).toBe(false); // not a proposal
    expect(thread.capabilities.reopen).toBe(false); // not yet resolved

    // Opener comment node (comments[0])
    expect(thread.comments[0].id).toBe(thread.id);
    expect(thread.comments[0].body).toBe('First comment');
    expect(thread.comments[0].author.client_id).toBe(ALICE.id);
    expect(thread.comments[0].author.display_name).toBe('Alice');
    expect(typeof thread.comments[0].created_at).toBe('number');
    expect(typeof thread.comments[0].updated_at).toBe('number');
    expect(thread.comments[0].capabilities.edit).toBe(true); // own comment
    expect(thread.comments[0].capabilities.delete).toBe(true); // own comment

    // No proposal, no replies on creation
    expect(thread.proposal).toBeNull();
    expect(thread.comments).toHaveLength(1);
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
    const original = {
      before: '# Title\n\nA paragraph.\n',
      after: '# Better title\n\nA paragraph.\n',
    };
    const diffRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${thread.id}/diff`, {
        headers: headersFor(BOB),
      }),
    );
    expect(diffRes.status).toBe(200);
    // Bob is a collaborator — no edit permission, so mergeable defaults
    // to null (skips the dry-run merge). Opt in with ?mergeable=1 below.
    expect(await diffRes.json()).toEqual({
      before: '# Title',
      after: '# Better title',
      original,
      mergeable: null,
    });
    const mergeableRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${thread.id}/diff?mergeable=1`, {
        headers: headersFor(BOB),
      }),
    );
    expect(mergeableRes.status).toBe(200);
    expect(await mergeableRes.json()).toEqual({
      before: '# Title',
      after: '# Better title',
      original,
      mergeable: 'clean',
    });

    // Admin (edit-capable) gets a non-null mergeable status by default —
    // no `?mergeable=1` needed. Locks in the editor-default contract.
    const adminRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${thread.id}/diff`, {
        headers: headersFor(ALICE),
      }),
    );
    expect(adminRes.status).toBe(200);
    expect(await adminRes.json()).toEqual({
      before: '# Title',
      after: '# Better title',
      original,
      mergeable: 'clean',
    });

    // Reader can read the diff but is denied the `?mergeable=1` opt-in:
    // computing it under the per-doc lock is too expensive to expose to
    // a role that can't act on the result.
    const carolReaderInvite = await createInvite(uid, 'Carol', 'reader');
    inviteByClientId.set(CAROL.id, carolReaderInvite);
    const readerRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${thread.id}/diff?mergeable=1`, {
        headers: headersFor(CAROL),
      }),
    );
    expect(readerRes.status).toBe(200);
    expect(await readerRes.json()).toEqual({
      before: '# Title',
      after: '# Better title',
      original,
      mergeable: null,
    });

    // Capabilities: Bob is collaborator → can propose/reject own, but not accept (needs editor)
    expect(thread.capabilities.accept).toBe(false); // collaborator cannot accept
    expect(thread.capabilities.reject).toBe(true); // root author may reject

    expect(thread.comments).toHaveLength(1);
  });

  test('thread shape: replies appear in thread.comments with correct shape', async () => {
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
    expect(thread.comments).toHaveLength(2);

    const reply = thread.comments[1]!;
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
      expect(Array.isArray(thread.comments)).toBe(true);
      expect(thread.comments.length).toBeGreaterThan(0);
      expect(typeof thread.comments[0].body).toBe('string');
      expect(thread.capabilities).toBeDefined();
    }
  });

  test('rename propagation: unambiguous @mentions get rewritten; duplicated ones are left alone', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);

    // Alice mentions Bob (unambiguous — only one "Bob" in the doc).
    const c1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hello @Bob');
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
    await addCommentAs(uid, CAROL, 'Bobby', { block_id: blockId, quote: 'Title' }, 'me too');
    // Alice mentions @Bobby — ambiguous now.
    const c2 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, '@Bobby look');
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

  describe('emoji reactions', () => {
    async function listThreads(uid: string, who: typeof ALICE) {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads`, { headers: headersFor(who) }),
      );
      const j = (await res.json()) as { threads: ThreadShape[] };
      return j.threads;
    }

    async function react(
      uid: string,
      threadId: string,
      commentId: string,
      who: typeof ALICE,
      emoji: string,
    ): Promise<{ status: number; thread: ThreadShape | null }> {
      const res = await app.hono.fetch(
        new Request(
          `http://test/api/documents/${uid}/threads/${threadId}/comments/${commentId}/reactions`,
          {
            method: 'POST',
            headers: headersFor(who),
            body: JSON.stringify({ emoji }),
          },
        ),
      );
      if (res.status !== 200) return { status: res.status, thread: null };
      const json = (await res.json()) as { thread: ThreadShape };
      return { status: res.status, thread: json.thread };
    }

    test('add and toggle a reaction on the thread opener', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hi');
      const cid = (r1.body as { comment: { id: string } }).comment.id;

      // Bob reacts with 👍
      const a = await react(uid, cid, cid, BOB, '👍');
      expect(a.status).toBe(200);
      expect(a.thread!.comments[0].reactions).toEqual([
        { emoji: '👍', count: 1, reacted: true, authors: ['Bob'] },
      ]);

      // Alice (different user) sees the reaction but `reacted: false`
      const aliceList = await listThreads(uid, ALICE);
      const seen = aliceList[0]!.comments[0].reactions!;
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual({ emoji: '👍', count: 1, reacted: false, authors: ['Bob'] });

      // Bob toggles again — reaction is removed
      const b = await react(uid, cid, cid, BOB, '👍');
      expect(b.status).toBe(200);
      expect(b.thread!.comments[0].reactions).toEqual([]);
    });

    test('multiple users + multiple emojis on the same comment', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hi');
      const cid = (r1.body as { comment: { id: string } }).comment.id;

      await react(uid, cid, cid, ALICE, '👍');
      await react(uid, cid, cid, BOB, '👍');
      await react(uid, cid, cid, BOB, '🎉');

      const list = await listThreads(uid, BOB);
      const reactions = list[0]!.comments[0].reactions!;
      const byEmoji = new Map(reactions.map((r) => [r.emoji, r]));
      expect(byEmoji.get('👍')).toEqual({
        emoji: '👍',
        count: 2,
        reacted: true,
        authors: ['Alice', 'Bob'],
      });
      expect(byEmoji.get('🎉')).toEqual({
        emoji: '🎉',
        count: 1,
        reacted: true,
        authors: ['Bob'],
      });
    });

    test('reactions on replies are scoped to the reply', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hi');
      const tid = (r1.body as { comment: { id: string } }).comment.id;
      const r2 = await addReply(uid, BOB, tid, 'reply');
      const replyId = (r2.body as { comment: { id: string } }).comment.id;

      await react(uid, tid, replyId, ALICE, '❤️');

      const list = await listThreads(uid, ALICE);
      expect(list[0]!.comments[0].reactions).toEqual([]);
      const reply = list[0]!.comments[1]!;
      expect(reply.reactions).toEqual([
        { emoji: '❤️', count: 1, reacted: true, authors: ['Alice'] },
      ]);
    });

    test('rejects invalid emoji input', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hi');
      const cid = (r1.body as { comment: { id: string } }).comment.id;

      const empty = await react(uid, cid, cid, BOB, '');
      expect(empty.status).toBe(400);

      const tooLong = await react(uid, cid, cid, BOB, 'x'.repeat(64));
      expect(tooLong.status).toBe(400);

      const whitespace = await react(uid, cid, cid, BOB, 'a b');
      expect(whitespace.status).toBe(400);
    });

    test('readers cannot react', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hi');
      const cid = (r1.body as { comment: { id: string } }).comment.id;

      // Anonymous (no invite) is a reader by default.
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads/${cid}/comments/${cid}/reactions`, {
          method: 'POST',
          headers: rawHeadersFor(BOB),
          body: JSON.stringify({ emoji: '👍' }),
        }),
      );
      expect(res.status).toBe(403);
    });

    test('react targets must belong to the thread', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'first');
      const r2 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'second');
      const t1 = (r1.body as { comment: { id: string } }).comment.id;
      const t2 = (r2.body as { comment: { id: string } }).comment.id;

      // Mismatched (tid vs cid): t2 is its own thread, not a reply under t1.
      const cross = await react(uid, t1, t2, BOB, '👍');
      expect(cross.status).toBe(404);
    });

    test('thread node capabilities expose `react: true` for collaborators', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hi');
      await addReply(uid, BOB, (r1.body as { comment: { id: string } }).comment.id, 'reply');

      const list = await listThreads(uid, BOB);
      for (const node of list[0]!.comments) {
        expect(node.capabilities.react).toBe(true);
      }
    });
  });
  describe('listing filters resolved threads out', () => {
    interface ListShape {
      threads: ThreadShape[];
      counts: { total: number; open: number; resolved: number };
    }

    async function list(uid: string, query = ''): Promise<ListShape> {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads${query}`, {
          headers: headersFor(ALICE),
        }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as ListShape;
    }

    async function resolve(uid: string, threadId: string): Promise<void> {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads/${threadId}/respond`, {
          method: 'POST',
          headers: asAdmin(),
          body: JSON.stringify({ action: 'resolve' }),
        }),
      );
      expect(res.status).toBe(200);
    }

    async function comment(uid: string, blockId: string, body: string): Promise<string> {
      const res = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, body);
      return (res.body as { comment: { id: string } }).comment.id;
    }

    /** A document with one resolved thread and one still open. */
    async function seedOneOfEach(): Promise<{ uid: string; closed: string; open: string }> {
      const uid = await newDoc('# Title\n\nA paragraph.\n');
      const blockId = await firstBlockId(uid);
      const closed = await comment(uid, blockId, 'settled');
      const open = await comment(uid, blockId, 'live');
      await resolve(uid, closed);
      return { uid, closed, open };
    }

    test('the default list is open threads only, and says how many it withheld', async () => {
      const { uid, open } = await seedOneOfEach();

      const listed = await list(uid);
      expect(listed.threads.map((t) => t.id)).toEqual([open]);
      expect(listed.counts).toEqual({ total: 2, open: 1, resolved: 1 });
    });

    test('state=resolved and state=all reach the archive', async () => {
      const { uid, closed, open } = await seedOneOfEach();

      expect((await list(uid, '?state=resolved')).threads.map((t) => t.id)).toEqual([closed]);
      expect((await list(uid, '?state=all')).threads.map((t) => t.id).sort()).toEqual(
        [closed, open].sort(),
      );
    });

    test('an accepted proposal counts as resolved', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const created = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads`, {
          method: 'POST',
          headers: headersFor(ALICE),
          body: JSON.stringify({
            anchor: { block_id: blockId, quote: 'Title' },
            body: 'rationale',
            proposal: { proposed_text: '# Fixed' },
          }),
        }),
      );
      const proposalId = ((await created.json()) as { thread: ThreadShape }).thread.id;
      expect((await list(uid)).threads.map((t) => t.id)).toEqual([proposalId]);

      const accepted = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads/${proposalId}/respond`, {
          method: 'POST',
          headers: asAdmin(),
          body: JSON.stringify({ action: 'accept' }),
        }),
      );
      expect(accepted.status).toBe(200);

      const after = await list(uid);
      expect(after.threads).toHaveLength(0);
      expect(after.counts).toEqual({ total: 1, open: 0, resolved: 1 });
      expect((await list(uid, '?state=resolved')).threads.map((t) => t.id)).toEqual([proposalId]);
    });

    test('thread_id fetches a resolved thread, and outranks the state filter', async () => {
      const { uid, closed } = await seedOneOfEach();

      const byId = await list(uid, `?thread_id=${closed}`);
      expect(byId.threads.map((t) => t.id)).toEqual([closed]);
      expect(byId.threads[0]!.state).toBe('resolved');
      // Counts stay document-wide so a by-id caller can still see there
      // is more where that came from.
      expect(byId.counts).toEqual({ total: 2, open: 1, resolved: 1 });

      const contradicted = await list(uid, `?thread_id=${closed}&state=open`);
      expect(contradicted.threads.map((t) => t.id)).toEqual([closed]);
    });

    test('thread_id accepts the id of a reply, not just the opener', async () => {
      const { uid, closed } = await seedOneOfEach();
      const reply = await addReply(uid, ALICE, closed, 'one last word');
      const replyId = (reply.body as { comment: { id: string } }).comment.id;

      const byReply = await list(uid, `?thread_id=${replyId}`);
      expect(byReply.threads.map((t) => t.id)).toEqual([closed]);
      expect(byReply.threads[0]!.comments.map((c) => c.id)).toContain(replyId);
    });

    test('an unknown thread_id lists nothing rather than everything', async () => {
      const { uid } = await seedOneOfEach();

      expect((await list(uid, '?thread_id=nope')).threads).toHaveLength(0);
    });

    test('an unrecognised state is rejected instead of silently ignored', async () => {
      const { uid, closed } = await seedOneOfEach();

      async function statusOf(query: string): Promise<number> {
        const res = await app.hono.fetch(
          new Request(`http://test/api/documents/${uid}/threads${query}`, {
            headers: headersFor(ALICE),
          }),
        );
        if (res.status === 400) {
          expect((await res.json()) as { error: string }).toEqual({ error: 'invalid-state' });
        }
        return res.status;
      }

      expect(await statusOf('?state=everything')).toBe(400);
      // Deliberately still a 400 alongside thread_id, which decides the
      // selection but does not make a misspelt state worth answering:
      // ignoring it would hide the typo until thread_id left the query.
      expect(await statusOf(`?thread_id=${closed}&state=everything`)).toBe(400);
    });

    test('replies come back with the thread they belong to, filtered or not', async () => {
      const { uid, open } = await seedOneOfEach();
      await addReply(uid, ALICE, open, 'first');
      await addReply(uid, BOB, open, 'second');

      const listed = await list(uid);
      expect(listed.threads[0]!.comments.map((comment) => comment.body)).toEqual([
        'live',
        'first',
        'second',
      ]);
    });
  });

  describe('proposals answering a comment', () => {
    /** Create a proposal thread, optionally linked to the comment it answers. */
    async function propose(
      uid: string,
      who: typeof ALICE,
      blockId: string,
      proposedText: string,
      answersThreadId?: string,
    ): Promise<{ status: number; id: string | null }> {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads`, {
          method: 'POST',
          headers: headersFor(who),
          body: JSON.stringify({
            anchor: { block_id: blockId, quote: 'Title' },
            body: 'rationale',
            proposal: {
              proposed_text: proposedText,
              ...(answersThreadId ? { answers_thread_id: answersThreadId } : {}),
            },
          }),
        }),
      );
      const json = (await res.json()) as { thread?: ThreadShape };
      return { status: res.status, id: json.thread?.id ?? null };
    }

    async function respond(uid: string, threadId: string, action: string) {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads/${threadId}/respond`, {
          method: 'POST',
          headers: asAdmin(),
          body: JSON.stringify({ action }),
        }),
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    }

    // `state=all`: these cases follow a comment and the proposal
    // answering it through acceptance, which resolves both.
    async function threadsOf(uid: string): Promise<ThreadShape[]> {
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads?state=all`, {
          headers: headersFor(ALICE),
        }),
      );
      return ((await res.json()) as { threads: ThreadShape[] }).threads;
    }

    async function seedComment(uid: string, blockId: string): Promise<string> {
      const res = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'please fix');
      return (res.body.comment as { id: string }).id;
    }

    test('records the link in both directions', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const commentId = await seedComment(uid, blockId);

      const proposal = await propose(uid, ALICE, blockId, '# Fixed', commentId);
      expect(proposal.status).toBe(201);

      const threads = await threadsOf(uid);
      const comment = threads.find((t) => t.id === commentId)!;
      const proposalThread = threads.find((t) => t.id === proposal.id)!;

      expect(proposalThread.proposal?.answers_thread_id).toBe(commentId);
      expect(comment.answered_by_thread_ids).toEqual([proposal.id as string]);
      // A proposal is not itself a request, so nothing answers it.
      expect(proposalThread.answered_by_thread_ids).toEqual([]);
    });

    test('a proposal with no link reports null, not a dangling id', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const proposal = await propose(uid, ALICE, blockId, '# Fixed');

      const threads = await threadsOf(uid);
      expect(threads.find((t) => t.id === proposal.id)!.proposal?.answers_thread_id).toBeNull();
    });

    test('one comment can collect several proposals, oldest first', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const commentId = await seedComment(uid, blockId);

      const first = await propose(uid, ALICE, blockId, '# One', commentId);
      const second = await propose(uid, ALICE, blockId, '# Two', commentId);

      const threads = await threadsOf(uid);
      const comment = threads.find((t) => t.id === commentId)!;
      expect(comment.answered_by_thread_ids).toEqual([first.id as string, second.id as string]);
    });

    test('rejects a link to a reply or to nothing', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const commentId = await seedComment(uid, blockId);
      const reply = await addReply(uid, ALICE, commentId, 'a reply');
      const replyId = (reply.body.comment as { id: string }).id;

      // A reply is not a request in its own right.
      expect((await propose(uid, ALICE, blockId, '# X', replyId)).status).toBe(400);
      expect((await propose(uid, ALICE, blockId, '# X', 'nonexistent')).status).toBe(400);
    });

    test('rejects a link to a thread in another document', async () => {
      // The other document first: newDoc resets the per-doc invite tokens.
      const other = await newDoc('# Title\n');
      const otherComment = await seedComment(other, await firstBlockId(other));

      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      expect((await propose(uid, ALICE, blockId, '# X', otherComment)).status).toBe(400);
    });

    test('only reports the proposals for the threads asked about', async () => {
      const uid = await newDoc('# Title\n\nA paragraph.\n');
      const blockId = await firstBlockId(uid);

      // Two independent comments, each answered by its own proposal, so a
      // query that ignored the requested ids would cross-report them.
      const firstComment = await seedComment(uid, blockId);
      const secondComment = await seedComment(uid, blockId);
      const firstProposal = await propose(uid, ALICE, blockId, '# One', firstComment);
      const secondProposal = await propose(uid, ALICE, blockId, '# Two', secondComment);

      const threads = await threadsOf(uid);
      expect(threads.find((t) => t.id === firstComment)!.answered_by_thread_ids).toEqual([
        firstProposal.id as string,
      ]);
      expect(threads.find((t) => t.id === secondComment)!.answered_by_thread_ids).toEqual([
        secondProposal.id as string,
      ]);
    });

    test('a deleted proposal stops answering its comment', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const commentId = await seedComment(uid, blockId);
      const proposal = await propose(uid, ALICE, blockId, '# Fixed', commentId);

      await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads/${proposal.id}`, {
          method: 'DELETE',
          headers: asAdmin(),
        }),
      );

      const threads = await threadsOf(uid);
      expect(threads.find((t) => t.id === commentId)!.answered_by_thread_ids).toEqual([]);
    });

    test('accepting the proposal resolves the comment it answers', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const commentId = await seedComment(uid, blockId);
      const proposal = await propose(uid, ALICE, blockId, '# Fixed', commentId);

      const accept = await respond(uid, proposal.id as string, 'accept');
      expect(accept.status).toBe(200);
      expect(accept.body.resolved_answered_thread_id).toBe(commentId);

      const threads = await threadsOf(uid);
      const comment = threads.find((t) => t.id === commentId)!;
      const acceptedProposal = threads.find((t) => t.id === proposal.id)!;
      expect(comment.state).toBe('resolved');
      expect(comment.resolution?.kind).toBe('resolve');
      expect(comment.link_status).toBe('linked');
      expect(comment.anchor.quote).toBe('Fixed');
      expect(comment.anchor.block_id).toBe(acceptedProposal.anchor.block_id);
      expect(acceptedProposal.link_status).toBe('linked');
      expect(acceptedProposal.anchor.quote).toBe('Fixed');

      // An unrelated later save used to re-run both anchors against their
      // pre-accept quote ("Title") and orphan them immediately. Their new
      // snapshot describes the paragraph produced by the proposal, so it
      // remains stable like any other anchor.
      const save = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}`, {
          method: 'PUT',
          headers: asAdmin(),
          body: JSON.stringify({ markdown: '# Fixed\n\nUnrelated paragraph.\n' }),
        }),
      );
      expect(save.status).toBe(200);

      const afterSave = await threadsOf(uid);
      const savedComment = afterSave.find((t) => t.id === commentId)!;
      const savedProposal = afterSave.find((t) => t.id === proposal.id)!;
      expect(savedComment.link_status).toBe('linked');
      expect(savedComment.anchor.quote).toBe('Fixed');
      expect(savedProposal.link_status).toBe('linked');
      expect(savedProposal.anchor.quote).toBe('Fixed');
    });

    test('rejecting the proposal leaves the comment open', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const commentId = await seedComment(uid, blockId);
      const proposal = await propose(uid, ALICE, blockId, '# Fixed', commentId);

      await respond(uid, proposal.id as string, 'reject');

      const threads = await threadsOf(uid);
      // The request stands — it just wasn't answered this way.
      expect(threads.find((t) => t.id === commentId)!.state).toBe('open');
    });

    test('accepting leaves an already-resolved comment credited to its resolver', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const commentId = await seedComment(uid, blockId);
      const proposal = await propose(uid, ALICE, blockId, '# Fixed', commentId);

      await respond(uid, commentId, 'resolve');
      const accept = await respond(uid, proposal.id as string, 'accept');
      expect(accept.body.resolved_answered_thread_id).toBeNull();
    });

    test('an unlinked proposal resolves nothing on accept', async () => {
      const uid = await newDoc('# Title\n');
      const blockId = await firstBlockId(uid);
      const proposal = await propose(uid, ALICE, blockId, '# Fixed');

      const accept = await respond(uid, proposal.id as string, 'accept');
      expect(accept.body.resolved_answered_thread_id).toBeNull();
    });
  });
});
