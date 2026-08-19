import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import type { ConflictSegment } from '../src/conflict.js';

const ALICE = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const BOB = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Bob' };
const DANA = { id: 'dddddddddddddddddddd', name: 'Dana' };
/** Invited, but only to read — distinct from a visitor with no invite at all. */
const RUTH = { id: 'rrrrrrrrrrrrrrrrrrrr', name: 'Ruth' };

interface ThreadShape {
  id: string;
  link_status: string;
  capabilities: { accept: boolean; resolve_conflict: boolean };
  proposal: { proposed_text: string | null } | null;
}

interface ConflictShape {
  scope: 'block' | 'document';
  status: 'clean' | 'conflict';
  current: string;
  base: string;
  proposed: string;
  merged: string | null;
  segments: ConflictSegment[] | null;
  empty: boolean;
}

const MIDDLE = 'The middle paragraph.';

const DOC = `# Guide

Intro paragraph.

${MIDDLE}

Closing paragraph.
`;

/**
 * Conflict discovery and resolution for edit proposals. The shape every
 * test builds on: Bob proposes a change to one block, Alice saves a
 * different change to the *same* block, and the proposal can no longer
 * be merged as written.
 *
 * Both sides extend the block rather than replacing it. A block's id is
 * a hash of its text and its anchor is re-found by quote, so a wholesale
 * rewrite orphans the proposal before it can ever conflict — that is a
 * different failure with its own repair path.
 */
describe('proposal conflict resolution', () => {
  let dir: string;
  let app: App;
  let adminToken = '';
  const inviteByClientId = new Map<string, string>();

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-conflict-'));
    app = await createApp(loadConfig({ dataDir: dir, port: 0 }));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function rawHeadersFor(c: { id: string; name: string }): Headers {
    return new Headers({
      'content-type': 'application/json',
      [CLIENT_HEADER]: c.id,
      [CLIENT_NAME_HEADER]: c.name,
    });
  }

  function headersFor(c: { id: string; name: string }): Headers {
    const h = rawHeadersFor(c);
    const tok = inviteByClientId.get(c.id);
    if (tok) h.set(INVITE_HEADER, tok);
    return h;
  }

  function asAdmin(): Headers {
    const h = rawHeadersFor(ALICE);
    h.set(INVITE_HEADER, adminToken);
    return h;
  }

  async function createInvite(
    uid: string,
    displayName: string,
    role: 'admin' | 'editor' | 'collaborator' | 'reader',
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
    inviteByClientId.set(DANA.id, await createInvite(j.uid, DANA.name, 'editor'));
    inviteByClientId.set(RUTH.id, await createInvite(j.uid, RUTH.name, 'reader'));
    return j.uid;
  }

  async function blockIdFor(uid: string, text: string): Promise<string> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headersFor(ALICE) }),
    );
    const j = (await res.json()) as { rendered: { blocks: Array<{ id: string; text: string }> } };
    const block = j.rendered.blocks.find((b) => b.text === text);
    if (!block) throw new Error(`no block with text ${JSON.stringify(text)}`);
    return block.id;
  }

  async function propose(uid: string, quote: string, proposedText: string): Promise<string> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headersFor(BOB),
        body: JSON.stringify({
          anchor: { block_id: await blockIdFor(uid, quote), quote },
          proposal: { proposed_text: proposedText },
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

  async function source(uid: string): Promise<string> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: asAdmin() }),
    );
    const j = (await res.json()) as { source: string };
    return j.source;
  }

  async function conflictOf(
    uid: string,
    tid: string,
    who = BOB,
  ): Promise<{ status: number; body: ConflictShape & { error?: string } }> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${tid}/conflict`, {
        headers: headersFor(who),
      }),
    );
    return { status: res.status, body: (await res.json()) as ConflictShape & { error?: string } };
  }

  async function resolve(
    uid: string,
    tid: string,
    payload: { resolved_text?: string; comment?: string },
    who = BOB,
  ): Promise<{ status: number; thread?: ThreadShape; error?: string }> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${tid}/resolve`, {
        method: 'POST',
        headers: headersFor(who),
        body: JSON.stringify(payload),
      }),
    );
    const body = (await res.json()) as { thread?: ThreadShape; error?: string };
    return { status: res.status, ...body };
  }

  async function accept(uid: string, tid: string): Promise<{ status: number; error?: string }> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${tid}/respond`, {
        method: 'POST',
        headers: asAdmin(),
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
    const body = (await res.json()) as { error?: string };
    return { status: res.status, ...body };
  }

  async function threadOf(uid: string, tid: string, who = BOB): Promise<ThreadShape> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, { headers: headersFor(who) }),
    );
    const j = (await res.json()) as { threads: ThreadShape[] };
    const thread = j.threads.find((t) => t.id === tid);
    if (!thread) throw new Error(`thread ${tid} missing`);
    return thread;
  }

  /** Bob's proposal and Alice's save both extend the middle paragraph. */
  async function conflictedDoc(): Promise<{ uid: string; tid: string }> {
    const uid = await newDoc(DOC);
    const tid = await propose(uid, MIDDLE, `${MIDDLE} Bob adds a caveat.`);
    await save(uid, DOC.replace(MIDDLE, `${MIDDLE} Alice adds an example.`));
    return { uid, tid };
  }

  describe('GET /conflict', () => {
    test('reports a proposal that still merges cleanly', async () => {
      const uid = await newDoc(DOC);
      const tid = await propose(uid, MIDDLE, `${MIDDLE} Bob adds a caveat.`);
      await save(uid, DOC.replace('Intro paragraph.', 'Intro, revised elsewhere.'));

      const { status, body } = await conflictOf(uid, tid);

      expect(status).toBe(200);
      expect(body.status).toBe('clean');
      expect(body.scope).toBe('block');
      expect(body.merged).toBe(`${MIDDLE} Bob adds a caveat.`);
      expect(body.segments).toBeNull();
      expect(body.empty).toBe(false);
    });

    test('scopes the three sides to the proposal’s own block', async () => {
      const { uid, tid } = await conflictedDoc();

      const { body } = await conflictOf(uid, tid);

      expect(body.status).toBe('conflict');
      expect(body.base).toBe(MIDDLE);
      expect(body.current).toBe(`${MIDDLE} Alice adds an example.`);
      expect(body.proposed).toBe(`${MIDDLE} Bob adds a caveat.`);
      // Untouched blocks are not dragged in as merge context.
      expect(body.current).not.toContain('Intro paragraph.');
    });

    test('returns the conflicting hunk with all three sides', async () => {
      const { uid, tid } = await conflictedDoc();

      const { body } = await conflictOf(uid, tid);

      const hunks = (body.segments ?? []).filter((s) => s.kind === 'conflict');
      expect(hunks).toHaveLength(1);
      const hunk = hunks[0];
      if (!hunk || hunk.kind !== 'conflict') throw new Error('expected one conflict hunk');
      expect(hunk.current).toBe(`${MIDDLE} Alice adds an example.`);
      expect(hunk.proposed).toBe(`${MIDDLE} Bob adds a caveat.`);
      expect(hunk.auto).toBeNull();
    });

    test('flags a proposal the document has already absorbed', async () => {
      const uid = await newDoc(DOC);
      const tid = await propose(uid, MIDDLE, `${MIDDLE} Agreed wording.`);
      await save(uid, DOC.replace(MIDDLE, `${MIDDLE} Agreed wording.`));

      const { body } = await conflictOf(uid, tid);

      expect(body.status).toBe('clean');
      expect(body.empty).toBe(true);
    });

    test('is closed to readers, who could not act on it anyway', async () => {
      const { uid, tid } = await conflictedDoc();
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads/${tid}/conflict`, {
          headers: headersFor(RUTH),
        }),
      );

      // Forbidden, not unauthorized: Ruth is a known participant, she
      // just has no use for a merge she could never act on.
      expect(res.status).toBe(403);
    });

    test('is closed to a visitor with no invite at all', async () => {
      const { uid, tid } = await conflictedDoc();
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads/${tid}/conflict`, {
          headers: rawHeadersFor(DANA),
        }),
      );

      // Documents are invite-only unless created otherwise, so an
      // unaccompanied client id gets no further than the door.
      expect(res.status).toBe(401);
    });
  });

  describe('POST /resolve without a resolution', () => {
    test('takes the merge git can make and leaves the proposal acceptable', async () => {
      const uid = await newDoc(DOC);
      const tid = await propose(uid, MIDDLE, `${MIDDLE} Bob adds a caveat.`);
      await save(uid, DOC.replace('Intro paragraph.', 'Intro, revised elsewhere.'));

      const resolved = await resolve(uid, tid, {});

      expect(resolved.status).toBe(200);
      expect(resolved.thread?.link_status).toBe('linked');
      expect(await accept(uid, tid)).toMatchObject({ status: 200 });
      const after = await source(uid);
      expect(after).toContain(`${MIDDLE} Bob adds a caveat.`);
      expect(after).toContain('Intro, revised elsewhere.');
    });

    test('refuses to guess when the two edits genuinely disagree', async () => {
      const { uid, tid } = await conflictedDoc();

      const resolved = await resolve(uid, tid, {});

      expect(resolved.status).toBe(409);
      expect(resolved.error).toBe('proposal-conflict');
    });

    test('refuses a resolution that would leave the document unchanged', async () => {
      const uid = await newDoc(DOC);
      const tid = await propose(uid, MIDDLE, `${MIDDLE} Agreed wording.`);
      await save(uid, DOC.replace(MIDDLE, `${MIDDLE} Agreed wording.`));

      const resolved = await resolve(uid, tid, {});

      expect(resolved.status).toBe(409);
      expect(resolved.error).toBe('proposal-resolution-empty');
    });
  });

  describe('POST /resolve with a resolution', () => {
    test('rebases the proposal onto current main and clears the conflict', async () => {
      const { uid, tid } = await conflictedDoc();

      const settled = `${MIDDLE} Alice adds an example. Bob adds a caveat.`;
      const resolved = await resolve(uid, tid, { resolved_text: settled });

      expect(resolved.status).toBe(200);
      expect(resolved.thread?.link_status).toBe('linked');
      expect(resolved.thread?.capabilities.accept).toBe(false); // Bob cannot accept
      expect(resolved.thread?.proposal?.proposed_text).toBe(settled);
    });

    test('the rebased proposal accepts as an ordinary merge', async () => {
      const { uid, tid } = await conflictedDoc();
      await resolve(uid, tid, { resolved_text: `${MIDDLE} Settled wording.` });

      expect(await accept(uid, tid)).toMatchObject({ status: 200 });

      const after = await source(uid);
      expect(after).toContain(`${MIDDLE} Settled wording.`);
      expect(after).not.toContain('Alice adds an example');
      expect(after).not.toContain('Bob adds a caveat');
    });

    test('records the resolution note as a reply on the thread', async () => {
      const { uid, tid } = await conflictedDoc();

      const resolved = await resolve(uid, tid, {
        resolved_text: `${MIDDLE} Settled wording.`,
        comment: 'Kept Alice’s subject, Bob’s verb.',
      });

      expect(resolved.status).toBe(200);
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads`, { headers: headersFor(BOB) }),
      );
      const j = (await res.json()) as {
        threads: Array<{ id: string; comments: Array<{ body: string }> }>;
      };
      const thread = j.threads.find((t) => t.id === tid);
      expect(thread?.comments.at(-1)?.body).toBe('Kept Alice’s subject, Bob’s verb.');
    });

    test('an editor who is not the author may resolve', async () => {
      const { uid, tid } = await conflictedDoc();

      const resolved = await resolve(uid, tid, { resolved_text: `${MIDDLE} Editor’s call.` }, DANA);

      expect(resolved.status).toBe(200);
      expect(resolved.thread?.link_status).toBe('linked');
    });

    test('an uninvited visitor may not', async () => {
      const { uid, tid } = await conflictedDoc();
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads/${tid}/resolve`, {
          method: 'POST',
          headers: rawHeadersFor(DANA),
          body: JSON.stringify({ resolved_text: 'nope' }),
        }),
      );

      // Documents are invite-only unless created otherwise, so this
      // never reaches the permission check.
      expect(res.status).toBe(401);
    });

    test('a reader may not', async () => {
      const { uid, tid } = await conflictedDoc();
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/threads/${tid}/resolve`, {
          method: 'POST',
          headers: headersFor(RUTH),
          body: JSON.stringify({ resolved_text: 'nope' }),
        }),
      );

      expect(res.status).toBe(403);
    });
  });

  describe('accept against a conflict', () => {
    test('pins the conflict on the thread so everyone sees it', async () => {
      const { uid, tid } = await conflictedDoc();

      expect(await accept(uid, tid)).toMatchObject({ status: 409, error: 'proposal-conflict' });

      const thread = await threadOf(uid, tid);
      expect(thread.link_status).toBe('conflict');
      expect(thread.capabilities.resolve_conflict).toBe(true);
    });

    test('resolving clears the pinned conflict and re-enables accept', async () => {
      const { uid, tid } = await conflictedDoc();
      await accept(uid, tid);

      await resolve(uid, tid, { resolved_text: `${MIDDLE} Settled wording.` });

      const thread = await threadOf(uid, tid, ALICE);
      expect(thread.link_status).toBe('linked');
      expect(thread.capabilities.accept).toBe(true);
    });
  });
});
