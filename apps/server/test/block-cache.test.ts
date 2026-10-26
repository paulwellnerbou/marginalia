import { beforeEach, describe, expect, test } from 'bun:test';
import {
  blockCacheStats,
  locateDocumentBlocksCached,
  resetBlockCache,
} from '../src/block-cache.js';

const DOC = `# Title

First paragraph.

Second paragraph.

Third paragraph.
`;

beforeEach(() => {
  resetBlockCache();
});

describe('locateDocumentBlocksCached', () => {
  test('parses a source once and serves the same map after', async () => {
    const first = await locateDocumentBlocksCached('markdown', DOC);
    const second = await locateDocumentBlocksCached('markdown', DOC);

    expect(second).toBe(first);
    expect(first.size).toBeGreaterThan(0);
    expect(blockCacheStats()).toMatchObject({ hits: 1, misses: 1, entries: 1 });
  });

  test('a changed source is parsed afresh', async () => {
    const before = await locateDocumentBlocksCached('markdown', DOC);
    const after = await locateDocumentBlocksCached('markdown', DOC.replace('Second', 'Rewritten'));

    expect(after).not.toBe(before);
    expect(blockCacheStats().misses).toBe(2);
  });

  test('the accept pattern pays one parse, not two', async () => {
    // Accepting a proposal locates blocks for the source before the merge
    // and after it. The "before" side of the next accept is this accept's
    // "after" side, so a reviewer working through a queue parses once per
    // accept rather than twice.
    const v1 = DOC;
    const v2 = DOC.replace('Second paragraph.', 'Second paragraph, revised.');
    const v3 = v2.replace('Third paragraph.', 'Third paragraph, revised.');

    await locateDocumentBlocksCached('markdown', v1); // first accept: pre  (miss)
    await locateDocumentBlocksCached('markdown', v2); // first accept: post (miss)
    await locateDocumentBlocksCached('markdown', v2); // second accept: pre  (hit)
    await locateDocumentBlocksCached('markdown', v3); // second accept: post (miss)

    expect(blockCacheStats()).toMatchObject({ hits: 1, misses: 3 });
  });

  test('format is part of the key, so markdown cannot serve asciidoc', async () => {
    const md = await locateDocumentBlocksCached('markdown', '= Heading\n\nBody.\n');
    const adoc = await locateDocumentBlocksCached('asciidoc', '= Heading\n\nBody.\n');

    expect(adoc).not.toBe(md);
  });

  test('keeps the cache bounded', async () => {
    for (let i = 0; i < 40; i++) {
      await locateDocumentBlocksCached('markdown', `# Doc ${i}\n\nParagraph ${i}.\n`);
    }

    expect(blockCacheStats().entries).toBeLessThanOrEqual(16);
    expect(blockCacheStats().entries).toBeGreaterThan(0);
  });

  test('an evicted source is re-parsed rather than lost', async () => {
    const first = await locateDocumentBlocksCached('markdown', DOC);
    for (let i = 0; i < 40; i++) {
      await locateDocumentBlocksCached('markdown', `# Filler ${i}\n\nText ${i}.\n`);
    }
    const again = await locateDocumentBlocksCached('markdown', DOC);

    expect(again).not.toBe(first);
    expect([...again.keys()]).toEqual([...first.keys()]);
  });
});
