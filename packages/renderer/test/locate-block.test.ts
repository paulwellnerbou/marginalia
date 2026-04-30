import { describe, expect, test } from 'bun:test';
import {
  locateAllBlocks,
  locateBlockRange,
  locateBlockSource,
  render,
} from '../src/index.js';

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

  test('resolves individual table cells — ranges exclude leading/trailing pipes', async () => {
    const md = '| h1 | h2 |\n|----|----|\n| a  | b  |\n';
    const rendered = await render(md);
    const ids = [...rendered.html.matchAll(/data-subblock="([^"]+)"/g)].map((m) => m[1]!);
    // 4 cells: 2 headers + 2 body cells.
    expect(ids.length).toBe(4);
    const map = locateAllBlocks(md);
    const sliced = ids.map((id) => {
      const r = map.get(id);
      expect(r).toBeDefined();
      return md.slice(r!.start, r!.end);
    });
    // The user-visible source should be just the cell's inline content —
    // pipes belong to the table structure, not to the cell.
    expect(sliced).toEqual(['h1', 'h2', 'a', 'b']);
  });

  test('replacing a table cell preserves the table structure', () => {
    const md = '| h1 | h2 |\n|----|----|\n| a  | b  |\n';
    const map = locateAllBlocks(md);
    const cellA = [...map.values()].find((r) => r.kind === 'tableCell' && r.text === 'a')!;
    const rewritten = md.slice(0, cellA.start) + 'AAA' + md.slice(cellA.end);
    // Pipes and the other cell are untouched.
    expect(rewritten).toBe('| h1 | h2 |\n|----|----|\n| AAA  | b  |\n');
  });

  test('duplicate-content table cells each get their own id and source range', async () => {
    // Two "Yes" cells and two "No" cells — the exact scenario that used to
    // strip `data-subblock` from every duplicate and bubble proposals up
    // to the enclosing table.
    const md = `| Feature | A | B |
|---------|---|---|
| Fast    | Yes | No |
| Safe    | Yes | No |
`;
    const rendered = await render(md);
    const ids = [...rendered.html.matchAll(/data-subblock="([^"]+)"/g)].map((m) => m[1]!);
    // 3 header cells + 6 body cells = 9 cells. Every one must carry an id.
    expect(ids.length).toBe(9);
    // All distinct — duplicate-content siblings no longer collapse.
    expect(new Set(ids).size).toBe(ids.length);

    const map = locateAllBlocks(md);
    // Each id resolves to exactly the text of one cell. Pull them in
    // document order, strip whitespace, and compare against the expected
    // left-to-right, top-to-bottom sequence.
    const sliced = ids.map((id) => map.get(id)!).map((r) => md.slice(r.start, r.end).trim());
    expect(sliced).toEqual(['Feature', 'A', 'B', 'Fast', 'Yes', 'No', 'Safe', 'Yes', 'No']);
  });

  test('duplicate-content list items each get their own id and source range', async () => {
    const md = `- todo
- todo
- done
- todo
`;
    const rendered = await render(md);
    const ids = [...rendered.html.matchAll(/data-subblock="([^"]+)"/g)].map((m) => m[1]!);
    expect(ids.length).toBe(4);
    expect(new Set(ids).size).toBe(4);

    const map = locateAllBlocks(md);
    const sliced = ids.map((id) => map.get(id)!).map((r) => md.slice(r.start, r.end));
    // Each returned range covers the single item the id was emitted from.
    // (mdast's list-item position includes the trailing newline — trim it.)
    expect(sliced.map((s) => s.trim())).toEqual(['- todo', '- todo', '- done', '- todo']);
  });

  test('duplicate cell replacement targets only the chosen cell', () => {
    const md = `| A | B |
|---|---|
| Yes | Yes |
`;
    // Two "Yes" cells. Ask for the SECOND id (suffixed `#2`) and replace it;
    // the first "Yes" must remain untouched.
    const map = locateAllBlocks(md);
    const cells = [...map.entries()].filter(([, r]) => r.kind === 'tableCell' && r.text === 'Yes');
    expect(cells.length).toBe(2);
    const [firstId, first] = cells[0]!;
    const [secondId, second] = cells[1]!;
    expect(firstId).not.toBe(secondId);
    expect(secondId).toMatch(/#2$/);
    expect(first.start).toBeLessThan(second.start); // document order

    const rewritten = md.slice(0, second.start) + 'NO' + md.slice(second.end);
    expect(rewritten).toBe(`| A | B |\n|---|---|\n| Yes | NO |\n`);
  });
});

describe('locateBlockRange', () => {
  // Three paragraphs, each its own top-level block. Ranges should
  // round-trip cleanly via the block IDs from `locateAllBlocks`.
  const md = `Alpha paragraph.

Beta paragraph.

Gamma paragraph.
`;

  test('null endId returns the start block range unchanged', () => {
    const ids = [...locateAllBlocks(md).keys()];
    const [a] = ids;
    const single = locateBlockRange(md, a!, null);
    expect(single).not.toBeNull();
    expect(md.slice(single!.start, single!.end).trim()).toBe('Alpha paragraph.');
  });

  test('endId === startId collapses to single-block range', () => {
    const ids = [...locateAllBlocks(md).keys()];
    const [a] = ids;
    const collapsed = locateBlockRange(md, a!, a!);
    const single = locateBlockRange(md, a!, null);
    expect(collapsed).toEqual(single);
  });

  test('multi-block range covers both endpoints plus inter-block whitespace', () => {
    const ids = [...locateAllBlocks(md).keys()];
    const [a, b, c] = ids;
    const range = locateBlockRange(md, a!, c!);
    expect(range).not.toBeNull();
    // Slicing the range yields all three paragraphs joined by their
    // original blank-line separators — no leading/trailing extra text.
    const sliced = md.slice(range!.start, range!.end);
    expect(sliced).toContain('Alpha paragraph.');
    expect(sliced).toContain('Beta paragraph.');
    expect(sliced).toContain('Gamma paragraph.');
    // Inter-block whitespace included
    expect(sliced).toMatch(/Alpha paragraph\.\n\nBeta paragraph\.\n\nGamma paragraph\./);
    // Bounds: start = paragraph A's start, end = paragraph C's end.
    expect(range!.start).toBe(locateBlockRange(md, a!, null)!.start);
    expect(range!.end).toBe(locateBlockRange(md, c!, null)!.end);
    // Multi-block sentinel: kind = 'multi', text = ''.
    expect(range!.kind).toBe('multi');
    expect(range!.text).toBe('');
    // Unused suppression
    void b;
  });

  test('reversed endpoints still produce the correct merged range (min/max)', () => {
    const ids = [...locateAllBlocks(md).keys()];
    const [a, , c] = ids;
    const forward = locateBlockRange(md, a!, c!);
    const reversed = locateBlockRange(md, c!, a!);
    expect(forward).not.toBeNull();
    expect(reversed).not.toBeNull();
    expect(reversed!.start).toBe(forward!.start);
    expect(reversed!.end).toBe(forward!.end);
  });

  test('returns null when either endpoint id is unknown', () => {
    const ids = [...locateAllBlocks(md).keys()];
    const [a] = ids;
    expect(locateBlockRange(md, a!, 'does-not-exist')).toBeNull();
    expect(locateBlockRange(md, 'does-not-exist', a!)).toBeNull();
  });
});
