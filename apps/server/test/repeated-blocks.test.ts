import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { locateBlocks } from '@marginalia/renderer';
import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import type { DocumentRow } from '../src/db.js';
import { locateAnchorRange } from '../src/routes/edit-proposals.js';

/**
 * A line a manuscript repeats is one content-hash id on several blocks.
 * The anchor's stored section says which copy a proposal is about, and
 * the splice has to follow it — a diff two chapters away from the
 * comment it answers is the bug these guard against (#203).
 */

const CLIENT = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };

const SOURCE = `# Book

## Chapter 2

"Go on."

Prose in chapter two.

## Chapter 7

Prose in chapter seven.

"Go on."
`;

const REPLACEMENT = '"Go on. Another one?"';

interface RenderedBlock {
  id: string;
  text: string;
  headingPath: string[];
  sectionIndex: number;
  sectionIndexPath: number[];
}

describe('proposals on a repeated block', () => {
  let dir: string;
  let webDir: string;
  let app: App;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-rep-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-rep-web-'));
    writeFileSync(join(webDir, 'index.html'), '<!doctype html><div id="root"></div>');
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir }));
  });

  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  function headers(token?: string): Headers {
    return new Headers({
      'content-type': 'application/json',
      [CLIENT_HEADER]: CLIENT.id,
      [CLIENT_NAME_HEADER]: CLIENT.name,
      ...(token ? { [INVITE_HEADER]: token } : {}),
    });
  }

  async function upload(): Promise<{ uid: string; token: string }> {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ invite_only: false, markdown: SOURCE }),
      }),
    );
    expect(res.status).toBe(201);
    const created = (await res.json()) as { uid: string; admin_invite: { token: string } };
    return { uid: created.uid, token: created.admin_invite.token };
  }

  /** The two copies of the repeated line, as the viewer and the MCP server see them. */
  async function copiesOf(uid: string, token: string): Promise<RenderedBlock[]> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}`, { headers: headers(token) }),
    );
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { rendered: { blocks: RenderedBlock[] } };
    const copies = doc.rendered.blocks.filter((b) => b.text === '"Go on."');
    expect(copies.length).toBe(2);
    expect(copies[1]!.id).toBe(copies[0]!.id);
    return copies;
  }

  async function propose(
    uid: string,
    token: string,
    anchor: Record<string, unknown>,
  ): Promise<string> {
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ anchor, proposal: { proposed_text: REPLACEMENT } }),
      }),
    );
    expect(res.status).toBe(201);
    const { thread } = (await res.json()) as { thread: { id: string } };
    return thread.id;
  }

  test('a proposal anchored in chapter seven changes chapter seven, not the first copy', async () => {
    const { uid, token } = await upload();
    const seventh = (await copiesOf(uid, token))[1]!;
    expect(seventh.headingPath).toEqual(['Book', 'Chapter 7']);

    // What the viewer sends for a selection in chapter seven: the shared
    // id plus the section the selection was made in.
    const proposalId = await propose(uid, token, {
      block_id: seventh.id,
      quote: '"Go on."',
      heading_path: seventh.headingPath,
      section_index: seventh.sectionIndex,
      section_index_path: seventh.sectionIndexPath,
    });
    const expected = SOURCE.replace(
      'Prose in chapter seven.\n\n"Go on."',
      `Prose in chapter seven.\n\n${REPLACEMENT}`,
    );
    const doc = { uid, format: 'markdown' as const };
    expect(await app.store.readProposalTip(doc, proposalId)).toBe(expected);

    const diff = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${proposalId}/diff`, {
        headers: headers(token),
      }),
    );
    expect(diff.status).toBe(200);
    // The diff is scoped to the anchored block; the tip above and the
    // accepted source below are what show which copy that block was.
    expect(await diff.json()).toMatchObject({ before: '"Go on."', after: REPLACEMENT });

    const accept = await app.hono.fetch(
      new Request(`http://test/api/documents/${uid}/threads/${proposalId}/respond`, {
        method: 'POST',
        headers: headers(token),
        body: JSON.stringify({ action: 'accept' }),
      }),
    );
    expect(accept.status).toBe(200);
    expect(app.store.read(doc)).toBe(expected);
  });

  test('an anchor that stored no section still takes the first copy', async () => {
    const { uid, token } = await upload();
    const [first] = await copiesOf(uid, token);
    const proposalId = await propose(uid, token, { block_id: first!.id, quote: '"Go on."' });
    expect(await app.store.readProposalTip({ uid, format: 'markdown' }, proposalId)).toBe(
      SOURCE.replace('## Chapter 2\n\n"Go on."', `## Chapter 2\n\n${REPLACEMENT}`),
    );
  });
});

describe('locateAnchorRange on a repeated block', () => {
  const doc = { uid: 'doc', format: 'markdown' } as DocumentRow;

  function occurrencesOf(source: string, text: string) {
    const list = [...locateBlocks(source).occurrences.values()].find(
      (candidates) => candidates[0]!.text === text,
    );
    expect(list).toBeDefined();
    return list!;
  }

  test('picks the copy the anchor’s section names, and the first without one', () => {
    const [first, second] = occurrencesOf(SOURCE, '"Go on."');
    expect(
      locateAnchorRange(doc, SOURCE, second!.id, null, {
        headingPath: ['Book', 'Chapter 7'],
        sectionIndexPath: second!.sectionIndexPath,
      }),
    ).toMatchObject({ start: second!.start, end: second!.end });
    expect(locateAnchorRange(doc, SOURCE, second!.id, null, null)).toMatchObject({
      start: first!.start,
      end: first!.end,
    });
  });

  test('a span ends at the first copy of its end id after the start', () => {
    const md = 'Alpha.\n\n"Go on."\n\nBeta.\n\n"Go on."\n\nGamma.\n';
    const goOn = occurrencesOf(md, '"Go on."');
    const [beta] = occurrencesOf(md, 'Beta.');
    const forwards = locateAnchorRange(doc, md, beta!.id, goOn[0]!.id, null);
    expect(md.slice(forwards!.start, forwards!.end)).toBe('Beta.\n\n"Go on."');

    // The same span with its endpoints the other way round: the section
    // names the second copy as the start, and the end is the copy of
    // Beta nearest to it.
    const backwards = locateAnchorRange(doc, md, goOn[0]!.id, beta!.id, {
      headingPath: [],
      sectionIndexPath: goOn[1]!.sectionIndexPath,
    });
    expect(md.slice(backwards!.start, backwards!.end)).toBe('Beta.\n\n"Go on."');
  });
});
