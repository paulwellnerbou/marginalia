import { describe, expect, test } from 'bun:test';
import { scaleFontLengths, scopeHtmlCss, scopeSelectorList } from '../src/html-css.js';
import {
  canMergeMultiBlock,
  exportDocx,
  extractDocumentTitle,
  htmlSectionSpan,
  locateAnchorSpan,
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
    const { occurrences } = locateBlocksHtml(page);
    const id = (text: string) =>
      [...occurrences.values()].flat().find((o) => o.text === text)?.id ?? '';
    // Endpoints in either order.
    const span = locateAnchorSpan(occurrences, id('5'), id('Erstens'), null, 'html');
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

  test("a repeated cell resolves to the copy in the anchor's section, not the first", () => {
    const src =
      '<h2>A</h2><table><tr><td>ja</td></tr></table><h2>B</h2><table><tr><td>ja</td></tr></table>';
    const { occurrences } = locateBlocksHtml(src);
    const copies = [...occurrences.values()].flat().filter((o) => o.text === 'ja');
    expect(copies).toHaveLength(2);
    expect(copies[0]?.id).toBe(copies[1]?.id);
    const second = copies[1]!;
    const range = locateAnchorSpan(
      occurrences,
      second.id,
      null,
      { headingPath: second.headingPath, sectionIndexPath: second.sectionIndexPath },
      'html',
    );
    expect(range?.start).toBe(second.start);
    expect(range?.start).toBe(src.lastIndexOf('<td>ja</td>'));
  });

  test('a fragment without html/head/body renders the same way', async () => {
    const r = await renderDocument('<title>T</title><style>p{color:red}</style><p>Hi</p>', 'html');
    expect(r.frontmatter.title).toBe('T');
    expect(r.blocks.map((b) => b.text)).toEqual(['Hi']);
    expect(r.css).toContain('@scope (.mg-html-root) {\n:scope p{color:red}\n}');
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

  test('srcset keeps only what src would, and targeted links lose the opener', async () => {
    const r = await renderDocument(
      [
        '<img src="a.png" srcset="a.png 1x, data:image/png;base64,AA,BB 2x, data:text/html;base64,CC 3x, javascript:x 4x">',
        '<a href="https://example.com" target="_blank" rel="nofollow">x</a>',
      ].join(''),
      'html',
    );
    expect(r.html).toContain('srcset="a.png 1x, data:image/png;base64,AA,BB 2x"');
    expect(r.html).toContain('rel="nofollow noopener noreferrer"');
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
      ':scope, :scope, :scope.dark > main, :scope .x',
    );
    expect(scopeSelectorList('a:is(.b, .c), td[data-x="a,b"]', null)).toBe(
      ':scope a:is(.b, .c), :scope td[data-x="a,b"]',
    );
    expect(scopeSelectorList('bodyguard p', null)).toBe(':scope bodyguard p');
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
    expect(css).toContain(':scope[data-theme="dark"]:not([data-theme="light"]) { --bg: #000 }');
    expect(css).toContain(':scope[data-theme="dark"] .card');
    expect(css).toContain('@media (min-width: 600px) { :scope:not([data-theme="dark"]) p');
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
    expect(
      extractDocumentTitle('<title>Gr&ouml;&szlig;e &copy; 2026 &amp;lt;</title>', 'html'),
    ).toBe('Größe © 2026 &lt;');
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

describe('HTML documents: section spans', () => {
  const doc = [
    '<main>',
    '<section id="a">',
    '  <h2>A</h2>',
    '  <p>a text</p>',
    '  <div class="scroll"><table><tr><td>cell</td></tr></table></div>',
    '</section>',
    '<svg class="guide"><path d="M0 0"/></svg>',
    '<section id="b">',
    '  <span class="eyebrow">B</span>',
    '  <h2>B</h2>',
    '  <p>b text</p>',
    '</section>',
    '</main>',
  ].join('\n');
  const at = (s: string) => doc.indexOf(s);

  test('takes the wrapper a heading leads and the siblings that end before the next one', () => {
    const span = htmlSectionSpan(doc, at('<h2>A'), at('<h2>B'));
    // The whole first section and the divider after it, closing tags included.
    expect(span && doc.slice(span.start, span.end)).toBe(
      doc.slice(at('<section id="a">'), at('<svg')) + '<svg class="guide"><path d="M0 0"/></svg>',
    );
  });

  test('stays inside a wrapper the heading does not lead', () => {
    const span = htmlSectionSpan(doc, at('<h2>B'), doc.length);
    expect(span && doc.slice(span.start, span.end)).toBe('<h2>B</h2>\n  <p>b text</p>');
  });

  test('null when no element starts at the offset', () => {
    expect(htmlSectionSpan(doc, at('<h2>A') + 1, doc.length)).toBeNull();
  });
});

describe('HTML documents: review fixes', () => {
  test("an SVG's <title> is not the document title", async () => {
    const src = '<h1>Q3 Report</h1><svg><title>Revenue bars</title><rect/></svg>';
    expect((await renderDocument(src, 'html')).frontmatter.title).toBeUndefined();
    expect(extractDocumentTitle(src, 'html')).toBe('Q3 Report');
  });

  test('html > body collapses into the root like a descendant chain', () => {
    expect(scopeSelectorList('html > body, :root>body .x, html>body>main', null)).toBe(
      ':scope, :scope .x, :scope>main',
    );
  });

  test("page-global names are renamed or dropped so they cannot redefine the app's", () => {
    const { css, warnings } = scopeHtmlCss(
      [
        '@keyframes pulse { from { opacity: 0 } }',
        '@property --accent-9 { syntax: "<length>"; inherits: false; initial-value: 0px }',
        '.a { animation: pulse 1s; animation-name: pulse }',
        '@counter-style thumbs { system: cyclic; symbols: "x" }',
        'ol { list-style: thumbs inside }',
      ],
      [],
    );
    expect(css).toContain('@keyframes mg-page-pulse');
    expect(css).toContain('animation: mg-page-pulse 1s; animation-name: mg-page-pulse');
    expect(css).toContain('@counter-style mg-page-thumbs');
    expect(css).toContain('list-style: mg-page-thumbs inside');
    expect(css).not.toContain('@property');
    expect(warnings).toHaveLength(1);
  });
});

describe('HTML documents: print', () => {
  test('grids without columns print as flex columns; grids with columns stay', () => {
    const { css } = scopeHtmlCss(
      [
        '.col { display: grid; gap: 44px } section { display: grid; gap: 16px }',
        '.facts { display: grid; grid-template-columns: repeat(2, 1fr) }',
        '.cards { display: grid } .cards { grid-template-columns: 1fr 1fr }',
        '@media print { .only-print { display: grid } }',
      ],
      [],
    );
    const print = css.slice(css.lastIndexOf('@media print{'));
    expect(print).toBe(
      '@media print{:scope .col, :scope section{display:flex;flex-direction:column;align-items:stretch;}}}',
    );
  });
});

describe('HTML documents: the @scope boundary', () => {
  /** Every top-level piece of the page CSS, after our own base rule and imports. */
  function pageRules(css: string): string {
    return css.slice(css.indexOf('}@media print{.mg-html-root{contain:none;}}') + 44);
  }

  test('every style rule sits inside @scope (.mg-html-root)', () => {
    const { css } = scopeHtmlCss(
      [
        'p { color: red } @media (min-width: 1px) { .a { color: blue } } @supports (display: grid) { .b { display: block } }',
      ],
      [],
    );
    const rest = pageRules(css).trim();
    expect(rest).toStartWith('@scope (.mg-html-root) {');
    expect(rest).toEndWith('}');
    expect(rest.match(/@scope/g)).toHaveLength(1);
  });

  test('escaped characters split where the browser splits them', () => {
    expect(scopeSelectorList('.a\\[, .app-toolbar', null)).toBe(
      ':scope .a\\[, :scope .app-toolbar',
    );
    expect(scopeSelectorList('.a\\(, .b', null)).toBe(':scope .a\\(, :scope .b');
  });

  test('nested rules stay inside the scope block, & and all', () => {
    const { css } = scopeHtmlCss(['.x { .app-chrome:not(&) { display: none } }'], []);
    expect(pageRules(css).trim()).toBe(
      '@scope (.mg-html-root) {\n:scope .x { .app-chrome:not(&) { display: none } }\n}',
    );
  });

  test('global at-rules are lifted out between scope blocks, in order', () => {
    const { css } = scopeHtmlCss(
      [
        'p { color: red } @keyframes spin { to { rotate: 1turn } } @font-face { font-family: X; src: local(Arial) } .a { animation: spin 1s }',
      ],
      [],
    );
    expect(pageRules(css).trim()).toBe(
      [
        '@scope (.mg-html-root) {\n:scope p { color: red }\n}',
        '@keyframes mg-page-spin { to { rotate: 1turn } }',
        '@font-face { font-family: X; src: local(Arial) }',
        '@scope (.mg-html-root) {\n:scope .a { animation: mg-page-spin 1s }\n}',
      ].join('\n'),
    );
  });

  test("a page's own @scope is left as written, inside ours", () => {
    const { css } = scopeHtmlCss(['@scope (.card) { img { border: 0 } }'], []);
    expect(pageRules(css).trim()).toBe(
      '@scope (.mg-html-root) {\n@scope (.card) { img { border: 0 } }\n}',
    );
  });

  test('a stylesheet that would close the block early is dropped, not emitted', () => {
    const { css, warnings } = scopeHtmlCss(
      ['p { color: red } } .app-toolbar { display: none }'],
      [],
    );
    expect(css).not.toContain('app-toolbar');
    expect(warnings).toHaveLength(1);
  });

  test('a selector that does not parse drops its rule', () => {
    const { css, warnings } = scopeHtmlCss(['!x { color: red } .ok { color: blue }'], []);
    expect(css).not.toContain('color: red');
    expect(css).toContain(':scope .ok');
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe('HTML documents: text size', () => {
  const z = (len: string) => `calc(${len} * var(--mg-text-zoom, 1))`;

  test('absolute font lengths scale, relative ones and layout lengths stay', () => {
    const { css } = scopeHtmlCss(
      [
        'body { font-size: 16px; line-height: 24px; padding: 16px }',
        'h1 { font-size: clamp(1.5rem, 4vw, 3rem); line-height: 1.2 }',
        '.lede { font-size: 1.25em; line-height: 150% }',
        '.k { font: italic 600 12pt/1.4 "Iowan 12px", serif }',
        '.s { font-size: small } .l { line-height: normal }',
      ],
      [],
    );
    expect(css).toContain(`font-size: ${z('16px')}; line-height: ${z('24px')}; padding: 16px`);
    expect(css).toContain(
      `font-size: clamp(${z('1.5rem')}, ${z('4vw')}, ${z('3rem')}); line-height: 1.2`,
    );
    expect(css).toContain('font-size: 1.25em; line-height: 150%');
    expect(css).toContain(`font: italic 600 ${z('12pt')}/1.4 "Iowan 12px", serif`);
    expect(css).toContain(`font-size: ${z('13px')}`);
    expect(css).toContain('line-height: normal');
  });

  test('a custom property read only for type scales; one also read for layout does not', () => {
    const { css } = scopeHtmlCss(
      [
        ':root { --fs-base: 18px; --fs-h1: calc(var(--fs-base) * 2); --space: 16px; --unused: 4px }',
        'p { font-size: var(--fs-base) } h1 { font-size: var(--fs-h1); margin: var(--space) }',
        '.n { font-size: var(--space) }',
      ],
      [],
    );
    expect(css).toContain(`--fs-base: ${z('18px')}`);
    expect(css).toContain('--fs-h1: calc(var(--fs-base) * 2)');
    expect(css).toContain('--space: 16px');
    expect(css).toContain('--unused: 4px');
    // The literal was scaled at its definition; the reference is not scaled again.
    expect(css).toContain('font-size: var(--fs-base)');
  });

  test('inline styles count as readers and scale their own font sizes', async () => {
    const r = await renderDocument(
      [
        '<style>:root { --fs: 14px; --w: 20px }</style>',
        '<p style="font-size: 20px; width: 300px">a</p>',
        '<p style="font-size: var(--fs); max-width: var(--w)">b</p>',
        '<p style="font-size: var(--w)">c</p>',
      ].join(''),
      'html',
    );
    expect(r.html).toContain(`style="font-size: ${z('20px')}; width: 300px"`);
    expect(r.css).toContain(`--fs: ${z('14px')}`);
    expect(r.css).toContain('--w: 20px');
  });

  test('strings, urls and lookalike tokens are left alone', () => {
    expect(scaleFontLengths('16px "a 2px b" url(x-3px.woff)', 'font')).toBe(
      `${z('16px')} "a 2px b" url(x-3px.woff)`,
    );
    expect(scaleFontLengths('var(--size-12px)', 'font-size')).toBe('var(--size-12px)');
    expect(scaleFontLengths('large', null)).toBe('large');
    expect(scaleFontLengths('larger', 'font-size')).toBe('larger');
  });

  test('a size keyword counts only where the size goes, never in a family name', () => {
    expect(scaleFontLengths('500 14px Inter Medium', 'font')).toBe(`500 ${z('14px')} Inter Medium`);
    expect(scaleFontLengths('large Roboto Medium', 'font')).toBe(`${z('18px')} Roboto Medium`);
    expect(scaleFontLengths('bold x-large/1.2 "Small Caps"', 'font')).toBe(
      `bold ${z('24px')}/1.2 "Small Caps"`,
    );
    expect(scaleFontLengths('120% Medium', 'font')).toBe('120% Medium');
  });

  test('inline custom properties read only for type scale too', async () => {
    const r = await renderDocument(
      [
        '<style>.t { font-size: var(--size) } .w { width: var(--w) }</style>',
        '<p class="t" style="--size: 20px; --w: 300px">a</p>',
      ].join(''),
      'html',
    );
    expect(r.html).toContain(`style="--size: ${z('20px')}; --w: 300px"`);
  });

  test('text inside an SVG keeps its size against the drawing', () => {
    const { css } = scopeHtmlCss(['svg text { font-size: 11px }'], []);
    expect(css).toContain('.mg-html-root svg{--mg-text-zoom:1;}');
  });
});
