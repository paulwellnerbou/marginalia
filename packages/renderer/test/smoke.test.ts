import { describe, expect, test } from 'bun:test';
import { render } from '../src/index.js';

describe('render smoke', () => {
  test('renders a basic document with headings, paragraphs, and a table', async () => {
    const md = `---
title: Hello
author: Paul
---

# Welcome

This is a **test** document with a [link](https://example.com).

## Features

| Feature | Status |
|---------|--------|
| Tables  | yes    |
| Lists   | yes    |

\`\`\`ts
const x: number = 1;
\`\`\`
`;

    const result = await render(md);

    expect(result.html).toContain('<h1');
    expect(result.html).toContain('Welcome');
    expect(result.html).toContain('<table');
    expect(result.anchors).toHaveLength(2);
    expect(result.anchors[0]).toMatchObject({ level: 1, text: 'Welcome', id: 'welcome' });
    expect(result.anchors[1]).toMatchObject({ level: 2, text: 'Features', id: 'features' });
    expect(result.toc).toHaveLength(1);
    expect(result.toc[0]!.children).toHaveLength(1);
    expect(result.frontmatter).toEqual({ title: 'Hello', author: 'Paul' });
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.html).toContain('data-block=');
  });

  test('handles Unicode headings and deduplicates collisions', async () => {
    const md = `# Über Lösung 🚀

# Über Lösung 🚀

# 中文标题
`;
    const result = await render(md);

    expect(result.anchors[0]!.id).toBe('über-lösung');
    expect(result.anchors[1]!.id).toBe('über-lösung-2');
    expect(result.anchors[2]!.id).toBe('中文标题');
  });

  test('mermaid blocks are preserved as client-side pre elements', async () => {
    const md = '```mermaid\ngraph TD; A-->B;\n```\n';
    const result = await render(md);
    expect(result.mermaid).toHaveLength(1);
    expect(result.mermaid[0]!.source).toBe('graph TD; A-->B;');
    expect(result.html).toContain('class="mermaid"');
    expect(result.html).toContain('data-mermaid-index="0"');
  });

  test('collects image assets and warns on missing alt text', async () => {
    const md = `![a cat](cat.jpg)

![](nocat.jpg)
`;
    const result = await render(md);
    expect(result.assets).toHaveLength(2);
    expect(result.assets.map((a) => a.src)).toEqual(['cat.jpg', 'nocat.jpg']);
    expect(result.warnings.filter((w) => w.kind === 'missing-alt')).toHaveLength(1);
  });

  test('syntax-highlights fenced code blocks with a known language', async () => {
    const md = '```ts\nconst x = 1;\n```\n';
    const result = await render(md);
    expect(result.html).toContain('class="shiki language-ts"');
    expect(result.html).toContain('<span');
  });

  test('warns on unknown code language', async () => {
    const md = '```not-a-real-language\nfoo\n```\n';
    const result = await render(md);
    expect(result.warnings.some((w) => w.kind === 'unknown-language')).toBe(true);
  });

  test('block IDs are stable across edits elsewhere in the document', async () => {
    const mdA = '# Title\n\nParagraph one.\n\nParagraph two.\n';
    const mdB = '# Title\n\nParagraph one.\n\nParagraph two changed.\n';
    const a = await render(mdA);
    const b = await render(mdB);
    // First heading's block id is the same; first paragraph's is the same;
    // last paragraph's differs.
    expect(a.blocks[0]!.id).toBe(b.blocks[0]!.id);
    expect(a.blocks[1]!.id).toBe(b.blocks[1]!.id);
    expect(a.blocks[2]!.id).not.toBe(b.blocks[2]!.id);
  });

  test('sanitizes inline HTML (strips script)', async () => {
    const md = 'Hello <script>alert(1)</script> world';
    const result = await render(md);
    expect(result.html).not.toContain('<script');
    expect(result.html).toContain('Hello');
  });
});
