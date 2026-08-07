import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type DiffSkip, diffLines } from '@marginalia/diff';
import { type DocLocator, GitStore } from '../src/git-store.js';

/**
 * Spike: serving render-ready diff lines straight from the store, instead of
 * shipping both revisions and matching them in the browser.
 *
 * What these pin is that the store addresses the right two blobs and hands
 * back the matcher's output unaltered — not parity with the browser, which
 * still runs its own LCS matcher and would not agree on every input. That
 * comparison only becomes meaningful once `apps/web` imports
 * `@marginalia/diff`; until then there is one implementation under test here,
 * deliberately.
 */
describe('GitStore.diffLinesAt', () => {
  let dir: string;
  let store: GitStore;
  const doc: DocLocator = { uid: 'diff-doc', format: 'markdown' };
  const alice = { displayName: 'Alice', clientId: 'alice' };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-difflines-'));
    store = new GitStore(dir);
    await store.init();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const BEFORE = '# Title\n\nThe quick brown fox.\n\nUnchanged tail.\n';
  const AFTER = '# Title\n\nThe quick red fox jumps.\n\nUnchanged tail.\n';

  test('returns the matcher output for the revision and its parent', async () => {
    await store.write(doc, BEFORE, alice, 'upload');
    const { oid } = await store.write(doc, AFTER, alice, 'update');

    const lines = await store.diffLinesAt(doc, oid);
    expect(lines).toEqual(diffLines(BEFORE, AFTER));
  });

  test('carries the word-level segments the diff view highlights', async () => {
    await store.write(doc, BEFORE, alice, 'upload');
    const { oid } = await store.write(doc, AFTER, alice, 'update');

    const lines = (await store.diffLinesAt(doc, oid)) ?? [];
    const added = lines.find((l) => l.op === 'add');
    expect(added?.segments?.some((s) => s.changed && s.text.includes('red'))).toBe(true);
  });

  test('elides unchanged runs beyond the context window', async () => {
    const tail = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    await store.write(doc, `${BEFORE}\n${tail}\n`, alice, 'upload');
    const { oid } = await store.write(doc, `${AFTER}\n${tail}\n`, alice, 'update');

    const full = (await store.diffLinesAt(doc, oid)) ?? [];
    const trimmed = (await store.diffLinesAt(doc, oid, { contextLines: 3 })) ?? [];

    expect(trimmed.length).toBeLessThan(full.length);
    // Every change survives; only distant unchanged lines are replaced by a
    // single skip carrying the count, so line numbering stays reconstructable.
    expect(trimmed.filter((l) => l.op === 'add' || l.op === 'remove')).toEqual(
      full.filter((l) => l.op === 'add' || l.op === 'remove'),
    );
    const skipped = trimmed
      .filter((l): l is DiffSkip => l.op === 'skip')
      .reduce((n, l) => n + l.skipped, 0);
    expect(trimmed.filter((l) => l.op !== 'skip').length + skipped).toBe(full.length);
  });

  test('returns null for an unknown oid', async () => {
    await store.write(doc, BEFORE, alice, 'upload');
    expect(await store.diffLinesAt(doc, 'x'.repeat(40))).toBeNull();
  });
});
