import { describe, expect, test } from 'bun:test';
import { render } from '../src/index.js';

describe('grid tables', () => {
  test('renders a basic grid table with header and body', async () => {
    const md = `
+---------+---------+
| Header1 | Header2 |
+=========+=========+
| a       | b       |
+---------+---------+
| c       | d       |
+---------+---------+
`;
    const r = await render(md);
    expect(r.html).toContain('<table class="grid-table">');
    expect(r.html).toContain('<thead>');
    expect(r.html).toContain('<th>Header1</th>');
    expect(r.html).toContain('<th>Header2</th>');
    expect(r.html).toContain('<td>a</td>');
    expect(r.html).toContain('<td>d</td>');
  });

  test('renders multi-line cells with block content (lists)', async () => {
    const md = `
+-------+---------+
| key   | value   |
+=======+=========+
| x     | - one   |
|       | - two   |
+-------+---------+
`;
    const r = await render(md);
    expect(r.html).toContain('<ul>');
    expect(r.html).toContain('<li>one</li>');
    expect(r.html).toContain('<li>two</li>');
  });

  test('picks up column alignment from the header separator', async () => {
    const md = `
+-------+-------+-------+
| L     | C     | R     |
+:======+:=====:+======:+
| a     | b     | c     |
+-------+-------+-------+
`;
    const r = await render(md);
    expect(r.html).toContain('align="left"');
    expect(r.html).toContain('align="center"');
    expect(r.html).toContain('align="right"');
  });

  test('renders a header-less grid table (no === separator)', async () => {
    const md = `
+-----+-----+
| a   | b   |
+-----+-----+
| c   | d   |
+-----+-----+
`;
    const r = await render(md);
    expect(r.html).toContain('<table class="grid-table">');
    expect(r.html).not.toContain('<thead>');
    expect(r.html).toContain('<td>a</td>');
    expect(r.html).toContain('<td>d</td>');
  });

  test('leaves grid-table-looking content inside a fenced code block untouched', async () => {
    const md = [
      '```',
      '+---+---+',
      '| a | b |',
      '+---+---+',
      '```',
    ].join('\n');
    const r = await render(md);
    // Inside a code block, the raw source should survive as text.
    expect(r.html).toContain('+---+---+');
    // And should NOT have been wrapped in <table class="grid-table">.
    expect(r.html).not.toContain('grid-table');
  });

  test('malformed grid table is left as source', async () => {
    const md = `+---+---+\n| only one row`;
    const r = await render(md);
    expect(r.html).not.toContain('grid-table');
  });

  test('grid table coexists with a GFM pipe table in the same document', async () => {
    const md = `
| Pipe | Table |
|------|-------|
| a    | b     |

+------+-------+
| Grid | Table |
+======+=======+
| c    | d     |
+------+-------+
`;
    const r = await render(md);
    // GFM pipe table — has our data-block attribute
    expect(r.html).toMatch(/<table[^>]*data-block=/);
    expect(r.html).toContain('<table class="grid-table">');
    // GFM pipe-table cells now carry data-subblock (proposal targeting).
    expect(r.html).toMatch(/<td[^>]*data-subblock=[^>]*>a<\/td>/);
    expect(r.html).toContain('<th>Grid</th>');
  });
});
