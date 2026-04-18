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

function headersFor(c: { id: string; name: string }): Headers {
  return new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: c.id,
    [CLIENT_NAME_HEADER]: c.name,
  });
}

describe('comments API', () => {
  let dir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-cm-'));
    app = await createApp(loadConfig({ dataDir: dir, port: 0 }));
  });

  afterEach(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * Alice uploads a doc and receives her admin invite token.
   *
   * Default `editable_by_anyone: true` so that random testers (Bob, Carol)
   * can comment without having to carry an explicit invite. The server now
   * gates comments on role ≥ commentor; a public reader cannot comment.
   * Tests that specifically want to exercise the public-reader case pass
   * `editableByAnyone: false` explicitly.
   */
  let adminToken = '';
  async function newDoc(markdown: string, editableByAnyone = true): Promise<string> {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ markdown, editable_by_anyone: editableByAnyone }),
      }),
    );
    const j = (await res.json()) as { uid: string; admin_invite: { token: string } };
    adminToken = j.admin_invite.token;
    return j.uid;
  }

  function asAdmin(c: typeof ALICE = ALICE): Headers {
    const h = headersFor(c);
    h.set(INVITE_HEADER, adminToken);
    return h;
  }

  async function createInvite(
    uid: string,
    displayName: string,
    role: 'admin' | 'editor' | 'collaborator' | 'commentor' | 'reader' = 'commentor',
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
      new Request(`http://test/api/documents/${uid}/comments`, {
        method: 'POST',
        headers: headersFor(who),
        body: JSON.stringify({ anchor, body }),
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  async function list(uid: string, who: typeof ALICE) {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments`, { headers: headersFor(who) }),
    );
    const j = (await res.json()) as { comments: Array<Record<string, unknown>> };
    return j.comments;
  }

  test('create, list, and reply', async () => {
    const uid = await newDoc('# Title\n\nA paragraph.\n');
    const blockId = await firstBlockId(uid);

    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'Hi');
    expect(r1.status).toBe(201);
    const top = (r1.body as { comment: { id: string; parent_id: string | null } }).comment;
    expect(top.parent_id).toBeNull();

    // Reply by Bob
    const r2 = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({ parent_id: top.id, body: 'Me too' }),
      }),
    );
    expect(r2.status).toBe(201);

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

    const r2 = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({ parent_id: topId, body: 'reply' }),
      }),
    );
    const replyId = ((await r2.json()) as { comment: { id: string } }).comment.id;

    const r3 = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ parent_id: replyId, body: 'nope' }),
      }),
    );
    expect(r3.status).toBe(400);
  });

  test('author edits own comment; others cannot', async () => {
    const uid = await newDoc('# Title\n');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hi');
    const cid = (r1.body as { comment: { id: string } }).comment.id;

    const editByBob = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments/${cid}`, {
        method: 'PUT',
        headers: headersFor(BOB),
        body: JSON.stringify({ body: 'hacked' }),
      }),
    );
    expect(editByBob.status).toBe(403);

    const editByAlice = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments/${cid}`, {
        method: 'PUT',
        headers: headersFor(ALICE),
        body: JSON.stringify({ body: 'updated' }),
      }),
    );
    expect(editByAlice.status).toBe(200);
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
      new Request(`http://test/api/documents/${uid}/comments/${cid}`, {
        method: 'PUT',
        headers: asAdmin(),
        body: JSON.stringify({ body: 'admin edit' }),
      }),
    );
    expect(editRes.status).toBe(403);

    // Alice deletes as admin — allowed.
    const delRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments/${cid}`, {
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
    expect(comments[0]!.status).toBe('active');
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
    expect(comments[0]!.status).toBe('low-confidence');
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
    expect(comments[0]!.status).toBe('orphaned');
  });

  test('identity required to post', async () => {
    const uid = await newDoc('# Hi');
    const blockId = await firstBlockId(uid);
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ anchor: { block_id: blockId, quote: 'Hi' }, body: 'x' }),
      }),
    );
    expect(res.status).toBe(400);
  });

  // A small sanity check that Carol (no role on the doc) can still read and
  // post comments — doc is public, comments are not restricted.
  test('reader on a non-editable public doc cannot post a comment', async () => {
    const uid = await newDoc('# Public', false);
    const blockId = await firstBlockId(uid);
    const r = await addComment(uid, CAROL, { block_id: blockId, quote: 'Public' }, 'hey');
    expect(r.status).toBe(403);
  });

  test('editable_by_anyone public doc: anyone posts comments as editor', async () => {
    const uid = await newDoc('# Public'); // default now: editable_by_anyone=true
    const blockId = await firstBlockId(uid);
    const r = await addComment(uid, CAROL, { block_id: blockId, quote: 'Public' }, 'looks good');
    expect(r.status).toBe(201);
  });

  test('mentions return pending notifications once and include merged autocomplete names', async () => {
    const uid = await newDoc('# Title');
    const bobInvite = await createInvite(uid, 'Bob', 'commentor');
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
      new Request(`http://test/api/documents/${uid}/comments`, {
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
      new Request(`http://test/api/documents/${uid}/comments`, {
        headers: new Headers({
          [CLIENT_HEADER]: BOB.id,
          [INVITE_HEADER]: bobInvite,
        }),
      }),
    );
    const secondBody = (await second.json()) as { pending_mentions: string[] };
    expect(secondBody.pending_mentions).toEqual([]);
  });

  test('editing a comment only creates a mention notification once per person', async () => {
    const uid = await newDoc('# Title');
    const carolInvite = await createInvite(uid, 'Carol', 'commentor');
    const blockId = await firstBlockId(uid);

    const created = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'hello');
    expect(created.status).toBe(201);
    const cid = (created.body as { comment: { id: string } }).comment.id;

    const edit = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments/${cid}`, {
        method: 'PUT',
        headers: headersFor(ALICE),
        body: JSON.stringify({ body: 'hello @Carol' }),
      }),
    );
    expect(edit.status).toBe(200);

    const first = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments`, {
        headers: new Headers({
          [CLIENT_HEADER]: CAROL.id,
          [INVITE_HEADER]: carolInvite,
        }),
      }),
    );
    const firstBody = (await first.json()) as { pending_mentions: string[] };
    expect(firstBody.pending_mentions).toEqual([cid]);

    const editAgain = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments/${cid}`, {
        method: 'PUT',
        headers: headersFor(ALICE),
        body: JSON.stringify({ body: 'hello again @Carol' }),
      }),
    );
    expect(editAgain.status).toBe(200);

    const second = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments`, {
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
    const bobInvite = await createInvite(uid, 'Bob', 'commentor');
    const carolInvite = await createInvite(uid, 'Carol', 'commentor');
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
      new Request(`http://test/api/documents/${uid}/comments`, {
        headers: new Headers({
          [CLIENT_HEADER]: BOB.id,
          [INVITE_HEADER]: bobInvite,
        }),
      }),
    );
    const bobBody = (await bobList.json()) as { pending_mentions: string[] };
    expect(bobBody.pending_mentions).toEqual([cid]);

    const carolList = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments`, {
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
      new Request(`http://test/api/documents/${uid}/comments/${cid}/resolve`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ resolved: true }),
      }),
    );
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()) as {
      comment: { resolved_at: number | null; resolved_by_name: string | null };
    };
    expect(resolved.comment.resolved_at).toBeGreaterThan(0);
    expect(resolved.comment.resolved_by_name).toBe('Alice');

    const reopenRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments/${cid}/resolve`, {
        method: 'POST',
        headers: headersFor(ALICE),
        body: JSON.stringify({ resolved: false }),
      }),
    );
    expect(reopenRes.status).toBe(200);
    const reopened = (await reopenRes.json()) as { comment: { resolved_at: number | null } };
    expect(reopened.comment.resolved_at).toBeNull();
  });

  test('admin can resolve a top-level thread they did not author', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, BOB, { block_id: blockId, quote: 'Title' }, 'question');
    const cid = (r1.body as { comment: { id: string } }).comment.id;

    const resolveRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments/${cid}/resolve`, {
        method: 'POST',
        headers: asAdmin(),
        body: JSON.stringify({ resolved: true }),
      }),
    );
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()) as {
      comment: { resolved_at: number | null; resolved_by_name: string | null };
    };
    expect(resolved.comment.resolved_at).toBeGreaterThan(0);
    expect(resolved.comment.resolved_by_name).toBe('Alice');
  });

  test('non-admins cannot resolve someone else’s top-level thread', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'question');
    const cid = (r1.body as { comment: { id: string } }).comment.id;

    const resolveRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments/${cid}/resolve`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({ resolved: true }),
      }),
    );
    expect(resolveRes.status).toBe(403);
  });

  test('resolving a reply is rejected', async () => {
    const uid = await newDoc('# Title');
    const blockId = await firstBlockId(uid);
    const r1 = await addComment(uid, ALICE, { block_id: blockId, quote: 'Title' }, 'top');
    const topId = (r1.body as { comment: { id: string } }).comment.id;

    const replyRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({ parent_id: topId, body: 'reply' }),
      }),
    );
    const replyId = ((await replyRes.json()) as { comment: { id: string } }).comment.id;

    const resolveRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/comments/${replyId}/resolve`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({ resolved: true }),
      }),
    );
    expect(resolveRes.status).toBe(400);
  });
});
