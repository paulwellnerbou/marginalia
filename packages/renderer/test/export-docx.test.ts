import { describe, expect, test } from 'bun:test';
import JSZip from 'jszip';
import { exportDocx } from '../src/index.js';

// 1x1 transparent PNG. Enough to exercise the probe + embed path
// without pulling a binary fixture into the repo.
const PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=';
const PNG_1x1_BYTES = Uint8Array.from(atob(PNG_1x1_BASE64), (c) => c.charCodeAt(0));
const PNG_1x1_DATA_URL = `data:image/png;base64,${PNG_1x1_BASE64}`;

/**
 * Unzip a DOCX buffer and return a handful of inner files as text.
 * DOCX is a ZIP; its interesting XML lives at known paths. We read
 * `document.xml` (body content), `document.xml.rels` (external
 * hyperlink URLs), and the `word/media/` directory listing so tests
 * can assert on real decompressed content instead of raw zip bytes.
 */
async function inspectDocx(buf: Buffer): Promise<{
  documentXml: string;
  relsXml: string;
  mediaFiles: string[];
}> {
  const zip = await JSZip.loadAsync(buf);
  const documentXml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  const relsXml =
    (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '';
  // JSZip lists both directories and files under `zip.files`; skip
  // directory entries so we count actual images, not the `word/media/`
  // folder marker itself.
  const mediaFiles = Object.entries(zip.files)
    .filter(([path, entry]) => path.startsWith('word/media/') && !entry.dir)
    .map(([path]) => path);
  return { documentXml, relsXml, mediaFiles };
}

// A DOCX is a ZIP with a `[Content_Types].xml` entry and a
// `word/document.xml` that holds the body. We sniff the bytes rather
// than re-parse the zip: the ZIP local-file header magic is `PK\x03\x04`
// (0x50 0x4B 0x03 0x04) and the XML entries appear inline, lightly
// compressed — checking for the text inside the buffer is unreliable
// across zip implementations, so we only assert on structural bytes.
const ZIP_MAGIC = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);

function hasZipMagic(buf: Buffer): boolean {
  if (buf.length < ZIP_MAGIC.length) return false;
  for (let i = 0; i < ZIP_MAGIC.length; i++) if (buf[i] !== ZIP_MAGIC[i]) return false;
  return true;
}

describe('exportDocx', () => {
  test('produces a valid DOCX (ZIP) for a basic markdown doc', async () => {
    const buf = await exportDocx(`# Hello

This is a **test** paragraph with a [link](https://example.com) and some \`code\`.

## Features

- bullet one
- bullet two
  - nested

| Col A | Col B |
|-------|-------|
| one   | two   |

> A blockquote.

\`\`\`ts
const x: number = 1;
\`\`\`
`);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(1000); // non-trivial doc
    expect(hasZipMagic(buf)).toBe(true);
  });

  test('accepts a theme and produces output', async () => {
    const buf = await exportDocx('# Title\n\nHello.', { theme: 'beautiful' });
    expect(hasZipMagic(buf)).toBe(true);
  });

  test('unknown theme falls back to default', async () => {
    const buf = await exportDocx('# Title\n\nHello.', { theme: 'nonexistent' });
    expect(hasZipMagic(buf)).toBe(true);
  });

  test('empty input still yields a valid DOCX', async () => {
    const buf = await exportDocx('');
    expect(hasZipMagic(buf)).toBe(true);
  });

  test('core properties populated from options', async () => {
    const buf = await exportDocx('# Doc', {
      title: 'Test title',
      author: 'Alice',
    });
    expect(hasZipMagic(buf)).toBe(true);
    // Core-properties file lives at docProps/core.xml inside the zip.
    // A simple byte search is unreliable for compressed data, but zip
    // local-file-header filenames appear in plain ASCII near the front.
    const asText = buf.toString('latin1');
    expect(asText).toContain('core.xml');
  });

  test('theme swap yields meaningfully different bytes', async () => {
    // Different tokens → different styles.xml → different bytes. Not a
    // strict guarantee, but a sanity check that tokens flow through.
    const md = '# Heading\n\nBody.\n';
    const [a, b] = await Promise.all([
      exportDocx(md, { theme: 'default' }),
      exportDocx(md, { theme: 'beautiful' }),
    ]);
    expect(a.equals(b)).toBe(false);
  });
});

describe('exportDocx — images (M4a)', () => {
  test('embeds a data-URL image inline without a resolver', async () => {
    const md = `# Doc\n\nBefore ![alt text](${PNG_1x1_DATA_URL}) after.\n`;
    const buf = await exportDocx(md);
    const { mediaFiles, documentXml } = await inspectDocx(buf);
    expect(mediaFiles.length).toBe(1);
    // docx names media by content hash; just sanity-check extension.
    expect(mediaFiles[0]).toMatch(/\.(png|jpg|jpeg|gif|bmp)$/);
    // docx emits a `<w:drawing>` / `<a:blip r:embed="..."/>` for each
    // image. Confirming a drawing element is the most robust signal.
    expect(documentXml).toContain('<w:drawing>');
  });

  test('resolveAsset feeds bytes for relative refs', async () => {
    const seen: string[] = [];
    const md = '# Doc\n\n![logo](logo.png)\n';
    const buf = await exportDocx(md, {
      resolveAsset: async (src) => {
        seen.push(src);
        return { bytes: PNG_1x1_BYTES, mime: 'image/png' };
      },
    });
    expect(seen).toEqual(['logo.png']);
    const { mediaFiles } = await inspectDocx(buf);
    expect(mediaFiles.length).toBe(1);
  });

  test('null resolver → graceful placeholder, still valid DOCX', async () => {
    const md = '# Doc\n\n![missing](not-attached.png)\n';
    const buf = await exportDocx(md, {
      resolveAsset: async () => null,
    });
    expect(hasZipMagic(buf)).toBe(true);
    const { mediaFiles, documentXml } = await inspectDocx(buf);
    expect(mediaFiles.length).toBe(0);
    // Placeholder text should reach document.xml.
    expect(documentXml).toContain('[image: missing]');
  });

  test('unsupported mime (svg) falls back to placeholder', async () => {
    const md = '# Doc\n\n![logo](logo.svg)\n';
    const buf = await exportDocx(md, {
      resolveAsset: async () => ({
        bytes: new TextEncoder().encode('<svg/>'),
        mime: 'image/svg+xml',
      }),
    });
    const { mediaFiles } = await inspectDocx(buf);
    expect(mediaFiles.length).toBe(0);
  });

  test('images are shared across instances in a single export', async () => {
    // The same src referenced twice should resolve once.
    let calls = 0;
    const md = '# Doc\n\n![a](shared.png)\n\n![b](shared.png)\n';
    await exportDocx(md, {
      resolveAsset: async () => {
        calls++;
        return { bytes: PNG_1x1_BYTES, mime: 'image/png' };
      },
    });
    expect(calls).toBe(1);
  });

  test('resolver that throws leaves the export intact', async () => {
    const md = '# Doc\n\n![broken](broken.png)\n\nStill readable.\n';
    const buf = await exportDocx(md, {
      resolveAsset: async () => {
        throw new Error('fake I/O failure');
      },
    });
    const { mediaFiles, documentXml } = await inspectDocx(buf);
    expect(mediaFiles.length).toBe(0);
    expect(documentXml).toContain('Still readable.');
  });
});

describe('exportDocx — bookmarks and internal links (M3a)', () => {
  test('headings emit bookmarks with their slug id', async () => {
    const md = '# First Section\n\n## Subsection Two\n\nBody.\n';
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    // `<w:bookmarkStart w:id=".." w:name="first-section"/>` appears
    // around the heading runs.
    expect(documentXml).toMatch(/<w:bookmarkStart[^>]*w:name="first-section"/);
    expect(documentXml).toMatch(/<w:bookmarkStart[^>]*w:name="subsection-two"/);
  });

  test('internal hash-link resolves to a bookmark via w:anchor', async () => {
    const md = [
      '# Outline',
      '',
      '- [Jump to section](#my-section)',
      '',
      '## My Section',
      '',
      'Here.',
    ].join('\n');
    const buf = await exportDocx(md);
    const { documentXml, relsXml } = await inspectDocx(buf);
    // Internal hyperlinks use w:anchor, not r:id → rels.
    expect(documentXml).toMatch(/<w:hyperlink[^>]*w:anchor="my-section"/);
    // And there's no external-link relationship for this href.
    expect(relsXml).not.toContain('#my-section');
  });

  test('external link produces an external hyperlink relationship', async () => {
    const md = '[example](https://example.com/x)\n';
    const buf = await exportDocx(md);
    const { relsXml } = await inspectDocx(buf);
    expect(relsXml).toContain('https://example.com/x');
    expect(relsXml).toContain('TargetMode="External"');
  });

  test('heading-anchor sigil links from the renderer are stripped', async () => {
    // `rehypeHeadingAnchors` injects `<a class="heading-anchor" href="#id">#</a>`
    // inside each heading. Those are UI chrome — they must not end up
    // as clickable content in the DOCX.
    const md = '# A Heading\n\nBody.\n';
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    // The heading text appears once…
    const matches = documentXml.match(/A Heading/g) ?? [];
    expect(matches.length).toBe(1);
    // …and the sigil '#' is not emitted as a hyperlink.
    expect(documentXml).not.toMatch(/<w:hyperlink[^>]*w:anchor="a-heading"/);
  });
});

describe('exportDocx — Table of Contents (M3b)', () => {
  test('auto mode emits TOC when doc has ≥ 2 headings', async () => {
    const md = [
      '# Top',
      '',
      '## A',
      '',
      'Body A.',
      '',
      '## B',
      '',
      'Body B.',
    ].join('\n');
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    // Word TOC field: `<w:fldChar>` + instrText containing the TOC
    // field code `TOC \o "1-6"` or similar. Checking for the field
    // instruction text is the most robust signal.
    expect(documentXml).toContain('TOC');
    expect(documentXml).toContain('fldChar');
    // And the user-visible "Contents" label above it.
    expect(documentXml).toContain('Contents');
  });

  test('auto mode skips TOC when doc has ≤ 1 heading', async () => {
    const buf = await exportDocx('# Only one heading\n\nBody.\n');
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).not.toContain('Contents');
    expect(documentXml).not.toContain('fldChar');
  });

  test('includeToc: false suppresses TOC even with many headings', async () => {
    const md = '# A\n\n## B\n\n## C\n\n## D\n';
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).not.toContain('fldChar');
  });

  test('includeToc: true forces TOC on a single-heading doc', async () => {
    const buf = await exportDocx('# Sole heading\n\nBody.\n', {
      includeToc: true,
    });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).toContain('fldChar');
  });

  test('tocLabel overrides the default "Contents" title', async () => {
    const buf = await exportDocx('# A\n\n## B\n\n## C\n', {
      includeToc: true,
      tocLabel: 'Inhalt',
    });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).toContain('Inhalt');
    expect(documentXml).not.toContain('>Contents<');
  });

  test('empty tocLabel suppresses the TOC heading but keeps the field', async () => {
    const buf = await exportDocx('# A\n\n## B\n', {
      includeToc: true,
      tocLabel: '',
    });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).toContain('fldChar');
    expect(documentXml).not.toContain('>Contents<');
  });
});

describe('exportDocx — footnotes (M3c)', () => {
  async function loadFootnotes(buf: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(buf);
    return (await zip.file('word/footnotes.xml')?.async('string')) ?? '';
  }

  test('GFM footnote refs become FootnoteReferenceRun', async () => {
    const md = [
      'Hello[^one] world[^two].',
      '',
      '[^one]: First footnote.',
      '[^two]: Second footnote.',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // Inline: two footnote references.
    const refs = documentXml.match(/<w:footnoteReference[^/]*\/>/g) ?? [];
    expect(refs.length).toBe(2);
    // The inline visible "1" / "2" numerals from GFM's anchor should
    // NOT appear — Word auto-numbers from the reference itself.
    // (We use a boundary check to avoid false positives from
    // chance-occurring digits elsewhere in the styles.xml escape.)
    expect(documentXml).not.toContain('>1<');
    expect(documentXml).not.toContain('>2<');
  });

  test('footnote bodies land in word/footnotes.xml, not inline', async () => {
    const md = [
      'Alpha[^a].',
      '',
      '[^a]: Body text here.',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    const footnotesXml = await loadFootnotes(buf);

    // The "Footnotes" section heading GFM adds (h2.sr-only) must not
    // appear inline — we lifted it out.
    expect(documentXml).not.toContain('>Footnotes<');
    // Nor the footnote body as regular paragraph content.
    expect(documentXml).not.toContain('Body text here.');

    // Body goes to footnotes.xml instead.
    expect(footnotesXml).toContain('Body text here.');
  });

  test('back-reference arrow (↩) is dropped from footnote bodies', async () => {
    const md = 'Ref[^x].\n\n[^x]: Note.\n';
    const buf = await exportDocx(md, { includeToc: false });
    const footnotesXml = await loadFootnotes(buf);
    // GFM emits `↩` (U+21A9) as the backref arrow inside the `<li>`.
    expect(footnotesXml).not.toContain('↩');
    expect(footnotesXml).not.toContain('\u21a9');
  });

  test('inline formatting inside a footnote survives to footnotes.xml', async () => {
    const md = 'See[^q].\n\n[^q]: Body with *italic* and **bold** runs.\n';
    const buf = await exportDocx(md, { includeToc: false });
    const footnotesXml = await loadFootnotes(buf);
    // Italic: `<w:i/>` or `<w:i w:val="true"/>`. Bold: `<w:b/>`.
    expect(footnotesXml).toMatch(/<w:i\b/);
    expect(footnotesXml).toMatch(/<w:b\b/);
    expect(footnotesXml).toContain('italic');
    expect(footnotesXml).toContain('bold');
  });

  test('doc without footnotes still exports cleanly', async () => {
    const buf = await exportDocx('# Doc\n\nNo footnotes here.\n', {
      includeToc: false,
    });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).not.toContain('<w:footnoteReference');
  });

  test('multi-block footnote bodies are preserved, not silently dropped', async () => {
    // GFM footnote with a paragraph, a list, and a code block in one
    // body. Previous implementation only kept the first paragraph.
    const md = [
      'See[^multi] below.',
      '',
      '[^multi]: Opening paragraph.',
      '',
      '    - bullet one',
      '    - bullet two',
      '',
      '    ```',
      '    code line',
      '    ```',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const footnotesXml = await loadFootnotes(buf);
    expect(footnotesXml).toContain('Opening paragraph.');
    expect(footnotesXml).toContain('bullet one');
    expect(footnotesXml).toContain('bullet two');
    expect(footnotesXml).toContain('code line');
  });
});

describe('exportDocx — language / RTL (M5)', () => {
  async function loadStyles(buf: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(buf);
    return (await zip.file('word/styles.xml')?.async('string')) ?? '';
  }

  test('options.language tags the default run with a BCP-47 language', async () => {
    const buf = await exportDocx('Hallo Welt.\n', { language: 'de-DE' });
    const stylesXml = await loadStyles(buf);
    // Run-level language uses `<w:lang w:val="de-DE" ...>`.
    expect(stylesXml).toMatch(/<w:lang[^>]*w:val="de-DE"/);
  });

  test('Arabic frontmatter lang triggers RTL paragraph direction', async () => {
    const md = '---\nlang: ar\n---\n\nمرحبا بالعالم\n';
    const buf = await exportDocx(md);
    const stylesXml = await loadStyles(buf);
    // `<w:bidi/>` on the default paragraph properties means RTL.
    expect(stylesXml).toMatch(/<w:bidi\b/);
    expect(stylesXml).toMatch(/<w:lang[^>]*w:val="ar"/);
  });

  test('non-RTL lang does not add bidi', async () => {
    const md = '---\nlang: en\n---\n\nHello.\n';
    const buf = await exportDocx(md);
    const stylesXml = await loadStyles(buf);
    expect(stylesXml).not.toMatch(/<w:bidi\b/);
  });

  test('explicit language option beats frontmatter', async () => {
    const md = '---\nlang: en\n---\n\nShalom.\n';
    const buf = await exportDocx(md, { language: 'he' });
    const stylesXml = await loadStyles(buf);
    expect(stylesXml).toMatch(/<w:lang[^>]*w:val="he"/);
    expect(stylesXml).toMatch(/<w:bidi\b/);
  });

  test('frontmatter `language:` alias is also recognised', async () => {
    const md = '---\nlanguage: fa\n---\n\nبدرود\n';
    const buf = await exportDocx(md);
    const stylesXml = await loadStyles(buf);
    expect(stylesXml).toMatch(/<w:lang[^>]*w:val="fa"/);
    expect(stylesXml).toMatch(/<w:bidi\b/);
  });

  test('no language at all → no explicit lang or bidi', async () => {
    const buf = await exportDocx('Just a doc.\n');
    const stylesXml = await loadStyles(buf);
    expect(stylesXml).not.toMatch(/<w:bidi\b/);
  });
});

describe('exportDocx — tables (Copilot review follow-ups)', () => {
  function countRowShadings(documentXml: string): {
    headerShaded: number;
    bodyShaded: number;
  } {
    // `<w:tr>` opens a row; within each row, the first cell's shading
    // is the one we care about for stripe parity. Header rows are
    // flagged by `<w:tblHeader/>` inside `<w:trPr>`.
    const rows = documentXml.split('<w:tr>').slice(1);
    let headerShaded = 0;
    let bodyShaded = 0;
    for (const chunk of rows) {
      const tr = chunk.split('</w:tr>')[0] ?? '';
      const isHeader = tr.includes('<w:tblHeader');
      const firstCell = tr.split('<w:tc>')[1]?.split('</w:tc>')[0] ?? '';
      const hasShade = /<w:shd[^>]*w:fill="[0-9a-f]{6}"/i.test(firstCell);
      if (isHeader && hasShade) headerShaded++;
      else if (!isHeader && hasShade) bodyShaded++;
    }
    return { headerShaded, bodyShaded };
  }

  test('zebra parity counts body rows only (C6)', async () => {
    // 1 header row + 3 body rows. With header-counted parity (the
    // bug), `rows.length % 2 === 1` at body row 0 (second row
    // overall) would shade row 0, which should actually be unshaded.
    const md = [
      '| H1 | H2 |',
      '|----|----|',
      '| A  | 1  |', // body row 0 — should NOT be shaded
      '| B  | 2  |', // body row 1 — SHOULD be shaded
      '| C  | 3  |', // body row 2 — should NOT be shaded
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    const { headerShaded, bodyShaded } = countRowShadings(documentXml);
    expect(headerShaded).toBe(1); // header always shaded
    expect(bodyShaded).toBe(1); // only the second body row striped
  });

  test('header cells carry a heavier bottom border when token enabled (C7)', async () => {
    const md = [
      '| Col A | Col B |',
      '|-------|-------|',
      '| a     | b     |',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // The header cell's bottom border is 2pt (size=16 in eighths of
    // a point), colored with the theme's fg. Match on `w:sz="16"`
    // inside a `<w:tcBorders>` / `<w:bottom ...>` element.
    expect(documentXml).toMatch(/<w:bottom[^/]*w:sz="16"/);
  });
});

describe('exportDocx — page size & margins', () => {
  // Millimeter-to-twip conversion doesn't land on the exact tabulated
  // sheet size by a twip or two; assert within a small tolerance.
  // Letter is defined directly in twips so it lands exact.
  const A4 = { width: 11906, height: 16838 };
  const A5 = { width: 8390, height: 11906 };
  const LETTER = { width: 12240, height: 15840 };

  function readPageSize(documentXml: string): { width: number; height: number } {
    // `<w:pgSz w:w="…" w:h="…" .../>` in section properties.
    const m = documentXml.match(/<w:pgSz[^/]*w:w="(\d+)"[^/]*w:h="(\d+)"/);
    return m && m[1] && m[2]
      ? { width: Number.parseInt(m[1], 10), height: Number.parseInt(m[2], 10) }
      : { width: 0, height: 0 };
  }

  function expectSize(
    actual: { width: number; height: number },
    target: { width: number; height: number },
  ): void {
    expect(Math.abs(actual.width - target.width)).toBeLessThanOrEqual(3);
    expect(Math.abs(actual.height - target.height)).toBeLessThanOrEqual(3);
  }

  test('default theme exports on A4 (sanity)', async () => {
    const buf = await exportDocx('# Doc', { theme: 'default' });
    const { documentXml } = await inspectDocx(buf);
    expectSize(readPageSize(documentXml), A4);
  });

  test('book theme also exports on A4 (was A5 — changed per feedback)', async () => {
    const buf = await exportDocx('# Doc', { theme: 'book' });
    const { documentXml } = await inspectDocx(buf);
    expectSize(readPageSize(documentXml), A4);
  });

  test('pageSize option overrides the theme default', async () => {
    const buf = await exportDocx('# Doc', { theme: 'book', pageSize: 'A5' });
    const { documentXml } = await inspectDocx(buf);
    expectSize(readPageSize(documentXml), A5);
  });

  test('pageSize: Letter overrides any theme', async () => {
    const buf = await exportDocx('# Doc', { theme: 'default', pageSize: 'Letter' });
    const { documentXml } = await inspectDocx(buf);
    expectSize(readPageSize(documentXml), LETTER);
  });
});

describe('exportDocx — hyperlink underlines', () => {
  test('internal links carry a single underline', async () => {
    const md = [
      '[Go to section](#my-section)',
      '',
      '## My Section',
      '',
      'Body.',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // The hyperlink runs should include `<w:u w:val="single" .../>`.
    // Narrow to the region inside a `<w:hyperlink w:anchor="…">` so
    // we don't accidentally match an unrelated underline elsewhere.
    const hyperlinkRegion = documentXml.match(
      /<w:hyperlink[^>]*w:anchor="my-section"[\s\S]*?<\/w:hyperlink>/,
    );
    expect(hyperlinkRegion).not.toBeNull();
    expect(hyperlinkRegion![0]).toMatch(/<w:u\b[^/]*w:val="single"/);
  });

  test('external links carry a single underline', async () => {
    const md = '[Example](https://example.com/x)';
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // External hyperlinks don't carry w:anchor; they reference a
    // relationship via r:id. The run inside should still be underlined.
    const hyperlinkRegion = documentXml.match(
      /<w:hyperlink[^>]*r:id="[^"]+"[\s\S]*?<\/w:hyperlink>/,
    );
    expect(hyperlinkRegion).not.toBeNull();
    expect(hyperlinkRegion![0]).toMatch(/<w:u\b[^/]*w:val="single"/);
  });
});

describe('exportDocx — mermaid fallback (M4b stopgap)', () => {
  test('mermaid code blocks render as labeled code', async () => {
    const md = [
      '# Diagrams',
      '',
      '```mermaid',
      'graph TD',
      '  A --> B',
      '```',
      '',
      'After.',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // The label and source text both appear.
    expect(documentXml).toContain('mermaid diagram');
    expect(documentXml).toContain('graph TD');
    expect(documentXml).toContain('A --&gt; B');
    // Body content after the diagram continues to flow normally.
    expect(documentXml).toContain('After.');
  });
});
