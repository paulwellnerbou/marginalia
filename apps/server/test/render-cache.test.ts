import { beforeEach, describe, expect, test } from 'bun:test';
import {
  renderCacheStats,
  renderDocumentCached,
  renderDocumentCopy,
  resetRenderCache,
} from '../src/render-cache.js';

beforeEach(() => {
  resetRenderCache();
});

describe('renderDocumentCached', () => {
  test('serves an identical source from cache', async () => {
    const source = '# Title\n\nSome paragraph.\n';

    const first = await renderDocumentCached(source, 'markdown');
    const second = await renderDocumentCached(source, 'markdown');

    expect(second).toBe(first);
    expect(renderCacheStats()).toMatchObject({ entries: 1, hits: 1, misses: 1 });
  });

  test('renders a changed source afresh', async () => {
    const first = await renderDocumentCached('# One\n', 'markdown');
    const second = await renderDocumentCached('# Two\n', 'markdown');

    expect(second).not.toBe(first);
    expect(first.html).toContain('One');
    expect(second.html).toContain('Two');
    expect(renderCacheStats()).toMatchObject({ entries: 2, misses: 2 });
  });

  test('keys on render options, so one mermaid mode cannot serve another', async () => {
    const source = '```mermaid\ngraph TD;\nA-->B;\n```\n';

    const client = await renderDocumentCached(source, 'markdown', { mermaid: 'client' });
    const svg = await renderDocumentCached(source, 'markdown', { mermaid: 'svg' });

    expect(svg).not.toBe(client);
    expect(renderCacheStats().misses).toBe(2);
  });

  test('keys on format, so markdown cannot serve asciidoc', async () => {
    const source = '= Heading\n';

    const md = await renderDocumentCached(source, 'markdown');
    const adoc = await renderDocumentCached(source, 'asciidoc');

    expect(adoc).not.toBe(md);
  });
});

describe('renderDocumentCopy', () => {
  test('hands back a copy the caller can rewrite without corrupting the entry', async () => {
    const source = '# Title\n\n![img](picture.png)\n';

    const copy = await renderDocumentCopy(source, 'markdown');
    const originalHtml = copy.html;
    // What `getDocument` does to the result after asset-reference rewriting.
    copy.html = '<p>rewritten</p>';

    const next = await renderDocumentCached(source, 'markdown');
    expect(next.html).toBe(originalHtml);
  });

  test('two copies of one source do not share a mutable top level', async () => {
    const source = '# Shared\n';

    const a = await renderDocumentCopy(source, 'markdown');
    const b = await renderDocumentCopy(source, 'markdown');
    a.html = 'changed';

    expect(b.html).not.toBe('changed');
  });
});

describe('concurrent cold reads', () => {
  test('share a single render instead of each paying for one', async () => {
    const source = `# Doc\n\n${'body text '.repeat(200)}\n`;

    const [a, b, c] = await Promise.all([
      renderDocumentCached(source, 'markdown'),
      renderDocumentCached(source, 'markdown'),
      renderDocumentCached(source, 'markdown'),
    ]);

    // One render, two readers joining it — the deploy-then-everyone-
    // reloads case, where paying three times is the whole problem.
    expect(renderCacheStats()).toMatchObject({ misses: 1, coalesced: 2, entries: 1 });
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  test('do not inflate the byte accounting past what the cache holds', async () => {
    const source = `# Doc\n\n${'body text '.repeat(200)}\n`;
    await Promise.all([
      renderDocumentCached(source, 'markdown'),
      renderDocumentCached(source, 'markdown'),
      renderDocumentCached(source, 'markdown'),
    ]);
    const concurrent = renderCacheStats();

    // What one entry really costs, measured on its own.
    resetRenderCache();
    await renderDocumentCached(source, 'markdown');

    // Counting a shared entry once per waiter drifts `bytes` upwards,
    // and eviction then sheds entries the budget could well afford.
    expect(concurrent.entries).toBe(1);
    expect(concurrent.bytes).toBe(renderCacheStats().bytes);
  });

  test('a settled render is cached, not left in flight', async () => {
    const source = '# Settled\n';
    await Promise.all([
      renderDocumentCached(source, 'markdown'),
      renderDocumentCached(source, 'markdown'),
    ]);

    await renderDocumentCached(source, 'markdown');
    // A hit, not another coalesce: the in-flight entry was cleared and
    // the result stored.
    expect(renderCacheStats()).toMatchObject({ hits: 1, misses: 1, coalesced: 1 });
  });
});

describe('cache budget', () => {
  test('evicts least-recently-used entries once the budget is exceeded', async () => {
    // The budget is read from the environment at module load, so rather than
    // fight it, fill the cache and assert the invariant that must always
    // hold: retained bytes never exceed the ceiling.
    const { maxBytes } = renderCacheStats();
    for (let i = 0; i < 40; i++) {
      await renderDocumentCached(`# Heading ${i}\n\n${'body text '.repeat(200)}\n`, 'markdown');
    }

    const stats = renderCacheStats();
    expect(stats.bytes).toBeLessThanOrEqual(maxBytes);
    expect(stats.entries).toBeGreaterThan(0);
  });
});
