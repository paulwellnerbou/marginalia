import { describe, expect, test } from 'bun:test';
import { locateAllBlocks, locateBlockSource, render } from '../src/index.js';

describe('locateBlockSource', () => {
  test('returns ranges that slice back to exact block sources — round-trips with remarkBlockIds', async () => {
    const md = `# Heading one

First paragraph.

## Heading two

Second paragraph with **bold**.

- list item A
- list item B

\`\`\`ts
const x: number = 1;
\`\`\`

> Quoted line.

| h1 | h2 |
|----|----|
| a  | b  |

---

Last paragraph.
`;

    const rendered = await render(md);
    // Every rendered block must be locatable, and its slice must match the
    // source span (up to trailing whitespace that mdast positions may omit).
    for (const info of rendered.blocks) {
      const range = locateBlockSource(md, info.id);
      expect(range).not.toBeNull();
      if (!range) continue;
      const slice = md.slice(range.start, range.end);
      expect(slice.trim().length).toBeGreaterThan(0);
      expect(range.kind).toBe(info.kind);
    }
  });

  test('handles a thematic break (no text)', () => {
    const md = 'para\n\n---\n\nafter';
    const map = locateAllBlocks(md);
    // thematicBreak is the only kind without visible text that's still
    // tracked; we expect exactly one such entry.
    const breakEntry = [...map.values()].find((r) => r.kind === 'thematicBreak');
    expect(breakEntry).toBeDefined();
    expect(md.slice(breakEntry!.start, breakEntry!.end)).toBe('---');
  });

  test('frontmatter is ignored, first real block locates correctly', () => {
    const md = `---
title: hi
---

Real paragraph.
`;
    const map = locateAllBlocks(md);
    const para = [...map.values()].find((r) => r.kind === 'paragraph');
    expect(para).toBeDefined();
    expect(md.slice(para!.start, para!.end)).toBe('Real paragraph.');
  });

  test('returns null for unknown block id', () => {
    expect(locateBlockSource('hello world\n', 'deadbeefdeadbeef')).toBeNull();
  });

  test('replacing a block by its range preserves the rest of the document', () => {
    const md = '# Title\n\nFirst.\n\nSecond.\n';
    const map = locateAllBlocks(md);
    const firstPara = [...map.entries()].find(([, r]) => r.text === 'First.');
    expect(firstPara).toBeDefined();
    const [, range] = firstPara!;
    const rewritten = md.slice(0, range.start) + 'First EDITED.' + md.slice(range.end);
    expect(rewritten).toBe('# Title\n\nFirst EDITED.\n\nSecond.\n');
  });

  test('locateAllBlocks matches block-ids from the renderer', async () => {
    const md = '# A\n\npara A\n\n## B\n\npara B\n';
    const rendered = await render(md);
    const map = locateAllBlocks(md);
    for (const info of rendered.blocks) {
      expect(map.has(info.id)).toBe(true);
    }
  });

  test('resolves individual list items', async () => {
    const md = '- first item\n- second item\n- third item\n';
    const rendered = await render(md);
    // Sub-block ids for list items are emitted as data-subblock="…".
    const ids = [...rendered.html.matchAll(/data-subblock="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBe(3);
    const map = locateAllBlocks(md);
    for (const id of ids) {
      const range = map.get(id);
      expect(range).toBeDefined();
      expect(md.slice(range!.start, range!.end)).toMatch(/^- \w+ item$/);
    }
  });

  test('resolves individual table cells', async () => {
    const md = '| h1 | h2 |\n|----|----|\n| a  | b  |\n';
    const rendered = await render(md);
    const ids = [...rendered.html.matchAll(/data-subblock="([^"]+)"/g)].map((m) => m[1]!);
    // 4 cells: 2 headers + 2 body cells.
    expect(ids.length).toBe(4);
    const map = locateAllBlocks(md);
    for (const id of ids) {
      expect(map.get(id)).toBeDefined();
    }
  });
});
