import { describe, expect, test } from 'bun:test';
import { scopeHtmlCss, scopeSelectorList } from '../src/html-css.js';
import {
  canMergeMultiBlock,
  exportDocx,
  extractDocumentTitle,
  locateBlockRangeHtml,
  locateBlocksHtml,
  renderDocument,
} from '../src/index.js';

const page = `<!doctype html>
<html lang="de" class="report">
<head>
<title>SMÄK Angebot</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow">
<link rel="stylesheet" href="https://evil.example/all.css">
<style>
:root { --bg: #fff; }
body { background: var(--bg); }
.fact .num { font-size: 2em; }
</style>
</head>
<body class="light">
<header class="bar"><span class="wordmark">SMÄK</span><nav><a href="#kosten">Kosten</a></nav></header>
<main>
  <section id="intro">
    <h1>Entwicklung</h1>
    <p class="lede">Das meiste haben wir.</p>
    <div class="facts">
      <div class="fact"><span class="num">8 <small>Sprachen</small></span><p>DE, EN</p></div>
    </div>
  </section>
  <section>
    <h2 id="kosten">Kosten</h2>
    <span class="note">loose inline text</span>
    <ul><li>Erstens<li>Zweitens</ul>
    <table><tr><th>Paket</th><td class="n">5</td></tr></table>
  </section>
</main>
</body>
</html>`;

describe('HTML documents: block model', () => {
  test('innermost elements with their own text become blocks, wrappers do not', async () => {
    const r = await renderDocument(page, 'html');
    const texts = r.blocks.map((b) => `${b.kind}:${b.text}`);
    expect(texts).toEqual([
      // `textContent`, as the browser reads it: adjacent elements run together.
      'block:SMÄKKosten',
      'heading:Entwicklung',
      'paragraph:Das meiste haben wir.',
      'block:8 SprachenDE, EN',
      'heading:Kosten',
      'item:Erstens',
      'item:Zweitens',
      'cell:Paket',
      'cell:5',
    ]);
    expect(r.blocks.every((b) => b.anchorable)).toBe(true);
  });

  test('a wrapper holding a heading is walked through even with loose text of its own', async () => {
    const r = await renderDocument(page, 'html');
    // The section with the stray <span> is not swallowed into one block.
    expect(r.toc.map((n) => n.text)).toEqual(['Entwicklung']);
    expect(r.toc[0]?.children.map((n) => n.text)).toEqual(['Kosten']);
    expect(r.blocks.find((b) => b.text === 'Zweitens')?.headingPath).toEqual([
      'Entwicklung',
      'Kosten',
    ]);
  });

  test('headings keep their own id and the others get a unique slug', async () => {
    const r = await renderDocument('<h2 id="kosten">A</h2><h2>Kosten</h2><h2>Kosten</h2>', 'html');
    expect(r.anchors.map((a) => a.id)).toEqual(['kosten', 'kosten-2', 'kosten-3']);
    expect(r.html).toContain('id="kosten-2"');
  });

  test('every rendered id resolves to a source range that slices back to its element', () => {
    const located = locateBlocksHtml(page);
    const slices = [...located.byId.values()].map((r) => page.slice(r.start, r.end));
    expect(slices).toContain('<p class="lede">Das meiste haben wir.</p>');
    expect(slices).toContain('<td class="n">5</td>');
    // `<li>` without an end tag ends where its content does.
    expect(slices).toContain('<li>Erstens');
  });

  test('renderer and locator agree on every id', async () => {
    const r = await renderDocument(page, 'html');
    const located = locateBlocksHtml(page);
    for (const block of r.blocks) expect(located.byId.has(block.id)).toBe(true);
    expect(located.byId.size).toBe(new Set(r.blocks.map((b) => b.id)).size);
  });

  test('a span covers both blocks and the markup between them', () => {
    const located = locateBlocksHtml(page);
    const id = (text: string) => [...located.byId].find(([, r]) => r.text === text)?.[0] ?? '';
    // Endpoints in either order.
    const span = locateBlockRangeHtml(page, id('5'), id('Erstens'));
    expect(span && page.slice(span.start, span.end)).toStartWith('<li>Erstens');
    expect(span && page.slice(span.start, span.end)).toEndWith('<td class="n">5</td>');
    expect(
      canMergeMultiBlock(
        { start: 0, end: 1, kind: 'cell', text: '' },
        { start: 2, end: 3, kind: 'tableCell', text: '' },
        'html',
      ),
    ).toBe(true);
  });

  test('a fragment without html/head/body renders the same way', async () => {
    const r = await renderDocument('<title>T</title><style>p{color:red}</style><p>Hi</p>', 'html');
    expect(r.frontmatter.title).toBe('T');
    expect(r.blocks.map((b) => b.text)).toEqual(['Hi']);
    expect(r.css).toContain('.mg-html-root p{color:red}');
    expect(r.html).not.toContain('color:red');
  });
});

describe('HTML documents: sanitizing', () => {
  test('keeps layout and styling, drops anything that runs', async () => {
    const r = await renderDocument(
      [
        '<script>alert(1)</script>',
        '<p style="color: red; background: url(javascript:alert(1))" onclick="x()">A</p>',
        '<a href="javascript:alert(1)">bad</a> <a href="#ok" target="_blank">ok</a>',
        '<img src="data:image/png;base64,AAAA" alt="ok">',
        '<img src="data:text/html;base64,AAAA" alt="bad">',
        '<iframe src="https://example.com"></iframe>',
        '<svg viewBox="0 0 10 10"><path d="M0 0L10 10" stroke="red"/></svg>',
        '<nav aria-label="Abschnitte"><a href="#a">a</a></nav>',
      ].join(''),
      'html',
    );
    expect(r.html).not.toContain('<script');
    expect(r.html).not.toContain('onclick');
    expect(r.html).not.toContain('javascript:');
    expect(r.html).not.toContain('<iframe');
    expect(r.html).not.toContain('data:text/html');
    expect(r.html).toContain('style="color: red"');
    expect(r.html).toContain('src="data:image/png;base64,AAAA"');
    expect(r.html).toContain('viewBox="0 0 10 10"');
    expect(r.html).toContain('d="M0 0L10 10"');
    expect(r.html).toContain('<nav aria-label="Abschnitte"');
  });

  test('wraps the body in the scope root, carrying html and body classes and the language', async () => {
    const r = await renderDocument(page, 'html');
    expect(r.html).toStartWith(
      '<div class="mg-html-root report light" data-html-doc="" lang="de">',
    );
  });
});

describe('HTML documents: stylesheet scoping', () => {
  test('root-ish selectors become the scope root, the rest is prefixed', () => {
    expect(scopeSelectorList(':root, html, body.dark > main, html body .x', null)).toBe(
      '.mg-html-root, .mg-html-root, .mg-html-root.dark > main, .mg-html-root .x',
    );
    expect(scopeSelectorList('a:is(.b, .c), td[data-x="a,b"]', null)).toBe(
      '.mg-html-root a:is(.b, .c), .mg-html-root td[data-x="a,b"]',
    );
    expect(scopeSelectorList('bodyguard p', null)).toBe('.mg-html-root bodyguard p');
  });

  test('colour-scheme queries follow the root data-theme instead of the OS', () => {
    const { css } = scopeHtmlCss(
      [
        '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg: #000 } .card { color: #fff } }',
        '@media (prefers-color-scheme: light) and (min-width: 600px) { p { color: #111 } }',
      ],
      [],
    );
    expect(css).not.toContain('prefers-color-scheme');
    expect(css).toContain(
      '.mg-html-root[data-theme="dark"]:not([data-theme="light"]) { --bg: #000 }',
    );
    expect(css).toContain('.mg-html-root[data-theme="dark"] .card');
    expect(css).toContain('@media (min-width: 600px) { .mg-html-root:not([data-theme="dark"]) p');
  });

  test('imports and links survive only for font services', () => {
    const { css, warnings } = scopeHtmlCss(
      [
        '@import url("https://fonts.bunny.net/css?family=x"); @import "https://evil.example/a.css"; p{}',
      ],
      ['https://fonts.googleapis.com/css2?family=Barlow', 'https://evil.example/all.css'],
    );
    expect(css).toContain('@import url("https://fonts.googleapis.com/css2?family=Barlow");');
    expect(css).toContain('@import url("https://fonts.bunny.net/css?family=x");');
    expect(css).not.toContain('evil.example');
    expect(warnings).toHaveLength(2);
    // Imports have to open the stylesheet to be honoured.
    expect(css.indexOf('@import')).toBe(0);
  });

  test('keyframes stay untouched, unsafe values go, and </style cannot close the element', () => {
    const { css } = scopeHtmlCss(
      [
        '@keyframes pulse { from { opacity: 0 } to { opacity: 1 } }',
        'p { width: expression(alert(1)); color: red }',
        'p::after { content: "</style><script>alert(1)</script>" }',
      ],
      [],
    );
    expect(css).toContain('from { opacity: 0 }');
    expect(css).not.toContain('expression');
    expect(css).toContain('color: red');
    expect(css).not.toMatch(/<\/style/i);
  });

  test('a stylesheet that does not parse is dropped with a warning', () => {
    const { css, warnings } = scopeHtmlCss(['p { color: red'], []);
    expect(css).not.toContain('color: red');
    expect(warnings).toHaveLength(1);
  });
});

describe('HTML documents: title', () => {
  test('<title> first, then the first <h1>', () => {
    expect(extractDocumentTitle(page, 'html')).toBe('SMÄK Angebot');
    expect(extractDocumentTitle('<h1>Big <em>news</em> &amp; more</h1>', 'html')).toBe(
      'Big news & more',
    );
    expect(extractDocumentTitle('<p>none</p>', 'html')).toBeNull();
  });
});

describe('HTML documents: DOCX', () => {
  test('layout wrappers and loose inline content still come out as headings, paragraphs and tables', async () => {
    const JSZip = (await import('jszip')).default;
    const buf = await exportDocx(page, { format: 'html' });
    const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')?.async('string');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toMatch(/w:val="Heading1"/);
    // The fact card's number and caption are separate paragraphs, not one run.
    expect(xml).toMatch(/8 <\/w:t>[\s\S]*?Sprachen[\s\S]*?<\/w:p>[\s\S]*?DE, EN/);
  });
});
