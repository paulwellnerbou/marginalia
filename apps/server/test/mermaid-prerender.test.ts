/**
 * Unit tests for `prerasterizeMermaid` — the PDF mmdr-path helper
 * that walks rendered HTML and replaces `<div class="mermaid">…</div>`
 * blocks with the resolver's output (typically inline SVG) — and for
 * `demoteLiveMermaidBlocks`, the EPUB-side disposal of whatever the
 * resolver couldn't render.
 */
import { describe, expect, test } from 'bun:test';

import {
  countLiveMermaidBlocks,
  demoteLiveMermaidBlocks,
  prerasterizeMermaid,
} from '../src/export/html-envelope.js';

const MD_DIV = (idx: number, body: string): string =>
  `<div class="mermaid" data-block-kind="mermaid" data-mermaid-index="${idx}" data-mermaid-mode="client">${body}</div>`;

describe('prerasterizeMermaid', () => {
  test('replaces a single mermaid div with the resolver output', async () => {
    const html = `<h1>Doc</h1>\n${MD_DIV(0, 'graph TD\n  A --&gt; B')}\n<p>End.</p>`;
    let calledIndex = -1;
    let calledSource = '';
    const out = await prerasterizeMermaid(html, async (source, index) => {
      calledIndex = index;
      calledSource = source;
      return {
        bytes: new TextEncoder().encode('<svg id="d0"><text>diagram</text></svg>'),
        mime: 'image/svg+xml',
      };
    });
    expect(calledIndex).toBe(0);
    // HTML entities decoded back to the original source.
    expect(calledSource).toBe('graph TD\n  A --> B');
    // Original div replaced with the SVG, surrounding HTML intact.
    expect(out).toContain('<div class="mermaid mermaid-prerendered"><svg id="d0">');
    expect(out).not.toContain('data-mermaid-index="0"');
    expect(out).toContain('<h1>Doc</h1>');
    expect(out).toContain('<p>End.</p>');
  });

  test('preserves divs whose resolver returns null (fallback to in-page runtime)', async () => {
    const html = MD_DIV(0, 'graph TD\n A --&gt; B');
    const out = await prerasterizeMermaid(html, async () => null);
    // Untouched — caller will let the in-page mermaid runtime handle it.
    expect(out).toBe(html);
  });

  test('renders multiple diagrams and maintains body structure', async () => {
    const html =
      `<h1>Title</h1>\n` +
      `${MD_DIV(0, 'graph TD\nA --&gt; B')}\n` +
      `<p>Between.</p>\n` +
      `${MD_DIV(1, 'graph LR\nX --&gt; Y')}\n` +
      `<p>End.</p>`;
    const seen: number[] = [];
    const out = await prerasterizeMermaid(html, async (_source, index) => {
      seen.push(index);
      return {
        bytes: new TextEncoder().encode(`<svg id="d${index}"/>`),
        mime: 'image/svg+xml',
      };
    });
    expect(seen.sort()).toEqual([0, 1]);
    expect(out).toContain('<svg id="d0"/>');
    expect(out).toContain('<svg id="d1"/>');
    expect(out).toContain('<p>Between.</p>');
    // Both originals gone.
    expect(out).not.toContain('data-mermaid-index="0"');
    expect(out).not.toContain('data-mermaid-index="1"');
  });

  test('handles asciidoc-style mermaid divs (extra attrs in any order)', async () => {
    // Asciidoc plugin adds a `data-block` attr; the helper should
    // still match and find the index attribute regardless of order.
    const html = `<div class="mermaid" data-block-kind="mermaid" data-block="abc123" data-mermaid-index="0" data-mermaid-mode="client">graph TD\nA --&gt; B</div>`;
    let called = 0;
    await prerasterizeMermaid(html, async () => {
      called += 1;
      return {
        bytes: new TextEncoder().encode('<svg/>'),
        mime: 'image/svg+xml',
      };
    });
    expect(called).toBe(1);
  });

  test('mixes resolved and unresolved blocks correctly', async () => {
    // First block resolves, second returns null → should keep the
    // second untouched while replacing the first.
    const html = `${MD_DIV(0, 'graph TD\nA --&gt; B')}\n${MD_DIV(1, 'graph LR\nX --&gt; Y')}`;
    const out = await prerasterizeMermaid(html, async (_s, idx) =>
      idx === 0
        ? { bytes: new TextEncoder().encode('<svg id="ok"/>'), mime: 'image/svg+xml' }
        : null,
    );
    expect(out).toContain('<svg id="ok"/>');
    // Second block stays as the original div.
    expect(out).toContain('data-mermaid-index="1"');
  });

  test('embeds PNG bytes as a data URL inside an img tag', async () => {
    const html = MD_DIV(0, 'graph TD\nA --&gt; B');
    // Tiny synthetic PNG bytes (real validity not required — the
    // helper just base64-encodes whatever we hand it).
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const out = await prerasterizeMermaid(html, async () => ({
      bytes,
      mime: 'image/png',
    }));
    expect(out).toContain('<img src="data:image/png;base64,');
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('data-mermaid-index="0"');
  });

  test('decodes the small set of HTML entities (& < > " \\")', async () => {
    // Ampersands are tricky — they must come last during decode so
    // `&amp;lt;` doesn't double-decode to `<`.
    const html = MD_DIV(0, 'sequenceDiagram\nA-&gt;&gt;B: &quot;hi &amp;lt; bye&quot;');
    let captured = '';
    await prerasterizeMermaid(html, async (s) => {
      captured = s;
      return { bytes: new TextEncoder().encode('<svg/>'), mime: 'image/svg+xml' };
    });
    expect(captured).toBe('sequenceDiagram\nA->>B: "hi &lt; bye"');
  });

  test('no-op when there are no mermaid divs', async () => {
    const html = '<h1>Hello</h1><p>World</p>';
    let calls = 0;
    const out = await prerasterizeMermaid(html, async () => {
      calls += 1;
      return null;
    });
    expect(calls).toBe(0);
    expect(out).toBe(html);
  });

  test('countLiveMermaidBlocks ignores prerendered wrappers', async () => {
    // The PDF route uses this to decide whether the export envelope
    // needs the mermaid UMD inlined. A naive `class="mermaid"`
    // count would report > 0 even after every block was
    // prerasterized (the wrapper retains the class for styling),
    // negating the optimisation. The helper must instead key on
    // `data-mermaid-(index|mode)`, which only un-prerendered blocks
    // carry.
    const bodyBefore =
      '<h1>Doc</h1>\n' +
      MD_DIV(0, 'graph TD\nA --&gt; B') +
      '\n<p>Mid.</p>\n' +
      MD_DIV(1, 'graph LR\nX --&gt; Y') +
      '\n<p>End.</p>';
    expect(countLiveMermaidBlocks(bodyBefore)).toBe(2);

    const allResolved = await prerasterizeMermaid(bodyBefore, async () => ({
      bytes: new TextEncoder().encode('<svg/>'),
      mime: 'image/svg+xml',
    }));
    // Both diagrams pre-rasterized → no live blocks remain even
    // though the `mermaid` class survives on the wrapper for styling.
    expect(allResolved).toContain('mermaid-prerendered');
    expect(allResolved).toContain('class="mermaid mermaid-prerendered"');
    expect(countLiveMermaidBlocks(allResolved)).toBe(0);

    // Mixed: index 0 resolves, index 1 falls through. One live
    // block remains → the envelope still needs the mermaid runtime.
    const partial = await prerasterizeMermaid(bodyBefore, async (_s, idx) =>
      idx === 0 ? { bytes: new TextEncoder().encode('<svg/>'), mime: 'image/svg+xml' } : null,
    );
    expect(countLiveMermaidBlocks(partial)).toBe(1);
  });

  test('bounds parallelism via the concurrency option', async () => {
    // Five diagrams + concurrency 2 → high-watermark ≤ 2 inflight.
    // Without a bound, all five would resolve simultaneously and
    // fan out into five subprocesses / browser contexts.
    const html = Array.from({ length: 5 }, (_, i) =>
      MD_DIV(i, `graph TD\nA${i} --&gt; B${i}`),
    ).join('\n');
    let inFlight = 0;
    let highWatermark = 0;
    await prerasterizeMermaid(
      html,
      async () => {
        inFlight += 1;
        highWatermark = Math.max(highWatermark, inFlight);
        // Yield twice so concurrent calls really overlap when
        // allowed; without this every await would settle in the
        // same microtask and inFlight would never exceed 1.
        await new Promise((r) => setTimeout(r, 5));
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { bytes: new TextEncoder().encode('<svg/>'), mime: 'image/svg+xml' };
      },
      { concurrency: 2 },
    );
    expect(highWatermark).toBeLessThanOrEqual(2);
    // Sanity floor: pool actually achieved >1 in flight (otherwise
    // the test passes trivially via accidental sequentialisation).
    expect(highWatermark).toBeGreaterThan(1);
  });
});

describe('demoteLiveMermaidBlocks', () => {
  test('rewrites a leftover mermaid div as a code listing', () => {
    const html = `<h1>Doc</h1>\n${MD_DIV(0, 'graph TD\n  A --&gt; B')}\n<p>End.</p>`;
    const out = demoteLiveMermaidBlocks(html);
    // Escaping survives — the listing goes through the same XHTML
    // serializer as the rest of the chapter.
    expect(out).toContain('<pre class="mermaid-source"><code>graph TD\n  A --&gt; B</code></pre>');
    expect(countLiveMermaidBlocks(out)).toBe(0);
    expect(out).toContain('<h1>Doc</h1>');
    expect(out).toContain('<p>End.</p>');
  });

  test('leaves already-prerendered blocks alone', () => {
    // The prerendered wrapper keeps the `mermaid` class but drops the
    // data-mermaid-* markers, so it must not be demoted back to text.
    const html = '<div class="mermaid mermaid-prerendered"><svg id="d0"/></div>';
    expect(demoteLiveMermaidBlocks(html)).toBe(html);
  });
});
