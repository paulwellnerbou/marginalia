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

function documentParagraphs(documentXml: string): string[] {
  return documentXml.match(/<w:p\b[\s\S]*?<\/w:p>/g) ?? [];
}

function paragraphContaining(documentXml: string, text: string): string {
  const paragraph = documentParagraphs(documentXml).find((p) => p.includes(text));
  expect(paragraph).toBeDefined();
  return paragraph!;
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

/**
 * Build an IHDR-only PNG fixture with a custom width/height. NOT a
 * spec-valid PNG — there is no IDAT (no image data) and the IHDR's
 * CRC is left as zeros — but it's enough to make `image-size` (which
 * only reads IHDR for PNG and doesn't validate CRCs) report the
 * declared pixel count, which is all the docx-export tests below
 * need. Pixels are never decoded on the export path.
 *
 * If you need a spec-valid PNG for a different test, generate one
 * with a real raster library or hand-craft IHDR + IDAT + IEND with
 * correct CRCs — this helper is deliberately a fixture, not a
 * fully-formed image.
 */
function makeIhdrOnlyPngFixture(width: number, height: number): Uint8Array {
  // 8-byte signature + IHDR (4 length + 4 type + 13 data + 4 CRC) + IEND (4+4+0+4)
  const out = new Uint8Array(8 + 25 + 12);
  // Signature
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length (13)
  out.set([0, 0, 0, 13], 8);
  // IHDR type
  out.set([0x49, 0x48, 0x44, 0x52], 12);
  // width
  const dv = new DataView(out.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  // bit depth, color type, compression, filter, interlace (8, 2, 0, 0, 0)
  out.set([8, 2, 0, 0, 0], 24);
  // IHDR CRC — left as zeros. image-size doesn't validate, and we
  // don't decode pixels. A real reader would reject; we don't care.
  out.set([0, 0, 0, 0], 29);
  // IEND length (0) + type + canonical CRC.
  out.set([0, 0, 0, 0], 33);
  out.set([0x49, 0x45, 0x4e, 0x44], 37);
  out.set([0xae, 0x42, 0x60, 0x82], 41); // canonical IEND CRC
  return out;
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

  test('markdown hard breaks stay inside one DOCX paragraph', async () => {
    const buf = await exportDocx('first line  \nsecond line\n', { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    const matchingParagraphs = documentParagraphs(documentXml).filter(
      (p) => p.includes('first line') || p.includes('second line'),
    );
    expect(matchingParagraphs.length).toBe(1);
    expect(matchingParagraphs[0]).toContain('first line');
    expect(matchingParagraphs[0]).toContain('second line');
    expect(matchingParagraphs[0]).toMatch(/<w:br\b/);
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
    // The TOC field's SDT alias was previously defaulting to
    // "Table of Contents" when `tocLabel` was empty — that value
    // could surface in screen readers / navigation panes even though
    // the user asked for no heading. Verify it doesn't appear.
    expect(documentXml).not.toContain('Table of Contents');
  });

  test('"Contents" label uses the dedicated TocHeading style, not Heading1', async () => {
    const md = '# Doc Title\n\n## A\n\n## B\n';
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    // Find the paragraph that contains "Contents" and check its style.
    const contentsPara = documentXml.match(
      /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*Contents(?:(?!<\/w:p>)[\s\S])*<\/w:p>/,
    );
    expect(contentsPara).not.toBeNull();
    expect(contentsPara![0]).toContain('<w:pStyle w:val="TocHeading"');
    expect(contentsPara![0]).not.toContain('<w:pStyle w:val="Heading1"');
  });

  test('TOC appears AFTER the first heading, not before it', async () => {
    const md = '# Document Title\n\n## Chapter A\n\n## Chapter B\n';
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    const titleIdx = documentXml.indexOf('Document Title');
    const contentsIdx = documentXml.indexOf('Contents');
    const chapterAIdx = documentXml.indexOf('Chapter A');
    expect(titleIdx).toBeGreaterThan(-1);
    expect(contentsIdx).toBeGreaterThan(-1);
    expect(chapterAIdx).toBeGreaterThan(-1);
    // Order must be: title → Contents → chapter A
    expect(titleIdx).toBeLessThan(contentsIdx);
    expect(contentsIdx).toBeLessThan(chapterAIdx);
  });

  test('TOC falls back to the top when the doc has no leading heading', async () => {
    // A doc that opens with a paragraph (not a heading) still needs
    // its TOC somewhere visible — the top is the natural place.
    const md = [
      'Intro paragraph before any heading.',
      '',
      '## A',
      '',
      '## B',
    ].join('\n');
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    const introIdx = documentXml.indexOf('Intro paragraph');
    const contentsIdx = documentXml.indexOf('Contents');
    expect(contentsIdx).toBeLessThan(introIdx);
  });
});

describe('exportDocx — [TOC] / [[_TOC_]] markers', () => {
  test('[TOC] marker places the TOC at the marker position', async () => {
    const md = [
      '# Document Title',
      '',
      'Intro before the TOC.',
      '',
      '[TOC]',
      '',
      '## Chapter A',
      '',
      'Body A.',
      '',
      '## Chapter B',
      '',
      'Body B.',
    ].join('\n');
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    const titleIdx = documentXml.indexOf('Document Title');
    const introIdx = documentXml.indexOf('Intro before');
    const contentsIdx = documentXml.indexOf('Contents');
    const chapterAIdx = documentXml.indexOf('Chapter A');
    // Title → Intro → Contents (from marker) → Chapter A.
    expect(titleIdx).toBeLessThan(introIdx);
    expect(introIdx).toBeLessThan(contentsIdx);
    expect(contentsIdx).toBeLessThan(chapterAIdx);
    // The marker element itself is stripped from the DOCX body.
    expect(documentXml).not.toContain('marginalia-toc-marker');
  });

  test('[[_TOC_]] marker is also honoured', async () => {
    const md = [
      '# Title',
      '',
      '[[_TOC_]]',
      '',
      '## A',
      '',
      '## B',
    ].join('\n');
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    // TOC field lands in the body (not just the heading).
    expect(documentXml).toContain('fldChar');
    // The `[[_TOC_]]` literal must not survive.
    expect(documentXml).not.toContain('[[_TOC_]]');
    expect(documentXml).not.toContain('[[TOC]]');
  });

  test('explicit marker wins over the "after-leading-heading" heuristic', async () => {
    // Without the marker, the TOC would go right after the title.
    // With the marker, it goes where the author put it.
    const md = [
      '# Title',
      '',
      '## A',
      '',
      'Some content between.',
      '',
      '[TOC]',
      '',
      '## B',
    ].join('\n');
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    const titleIdx = documentXml.indexOf('Title');
    const chapterAIdx = documentXml.indexOf('>A<');
    const contentsIdx = documentXml.indexOf('Contents');
    const chapterBIdx = documentXml.indexOf('>B<');
    expect(titleIdx).toBeLessThan(chapterAIdx);
    // Critical: Contents comes AFTER Chapter A (the marker position),
    // not immediately after the title.
    expect(chapterAIdx).toBeLessThan(contentsIdx);
    expect(contentsIdx).toBeLessThan(chapterBIdx);
  });

  test('only the FIRST marker becomes a TOC; later markers are silently dropped', async () => {
    const md = [
      '# Title',
      '',
      '[TOC]',
      '',
      '## A',
      '',
      '[[_TOC_]]',
      '',
      '## B',
    ].join('\n');
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    // A single Word TOC field uses three `<w:fldChar>` elements
    // (begin + separate + end). Two TOCs would give us six. One
    // TOC → three.
    const fldCharMatches = documentXml.match(/<w:fldChar/g) ?? [];
    expect(fldCharMatches.length).toBe(3);
    // No stray "Contents" from a second emission.
    const contentsMatches = documentXml.match(/>Contents</g) ?? [];
    expect(contentsMatches.length).toBe(1);
  });

  test('includeToc: false suppresses the TOC even when a marker is present', async () => {
    const md = '# Title\n\n[TOC]\n\n## A\n\n## B\n';
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).not.toContain('fldChar');
    expect(documentXml).not.toContain('Contents');
    // The marker div itself should not leak into the body.
    expect(documentXml).not.toContain('marginalia-toc-marker');
  });

  test('marker forces TOC even for a single-heading doc', async () => {
    // Normally auto-mode would skip a doc with only one heading,
    // but an explicit marker signals "I want a TOC here, really".
    const md = '# Sole heading\n\n[TOC]\n\nBody text.\n';
    const buf = await exportDocx(md);
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).toContain('fldChar');
  });
});

describe('exportDocx — run-level size overrides (follow-up)', () => {
  test('heading paragraph runs have no w:sz override (style-only sizing)', async () => {
    // Previously a catch-all in runOptions set size on every run, so
    // the document title rendered as "Heading1 + 12pt" in Word's
    // style inspector. With the override removed, the heading's
    // run-properties block inside the paragraph should have no
    // `<w:sz>`; the Heading1 style provides the size.
    const md = '# A Heading\n\nBody paragraph.\n';
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);

    // Narrow to the paragraph styled Heading1.
    const headingPara = documentXml.match(
      /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*<w:pStyle w:val="Heading1"[\s\S]*?<\/w:p>/,
    );
    expect(headingPara).not.toBeNull();
    // `<w:sz>` inside `<w:rPr>` of the heading's runs would be a
    // run-level size override. Assert there is none.
    const runSizeInsideHeading = headingPara![0].match(/<w:rPr>[\s\S]*?<w:sz\b/);
    expect(runSizeInsideHeading).toBeNull();
  });

  test('body paragraph runs also have no w:sz override', async () => {
    const md = 'Plain body text with **bold** and *italic* runs.\n';
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // Extract all run-property blocks inside the body paragraph and
    // check none carries a size override.
    const bodyPara = documentXml.match(
      /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*Plain body(?:(?!<\/w:p>)[\s\S])*<\/w:p>/,
    );
    expect(bodyPara).not.toBeNull();
    expect(bodyPara![0]).not.toMatch(/<w:rPr>[\s\S]*?<w:sz\b/);
  });

  test('inline code keeps its size override (intentional 0.9× body size)', async () => {
    // Inline `<code>` runs size down slightly because the
    // surrounding paragraph is Normal, not CodeBlock — so the
    // override is needed. Confirm we still emit it.
    const md = 'A paragraph with `inline code` inside.\n';
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // The run carrying "inline code" should have a w:sz element.
    const codeRun = documentXml.match(
      /<w:r>[^<]*<w:rPr>[\s\S]*?<\/w:rPr>[^<]*<w:t[^>]*>inline code<\/w:t>[^<]*<\/w:r>/,
    );
    expect(codeRun).not.toBeNull();
    expect(codeRun![0]).toMatch(/<w:sz\b/);
  });

  test('code block runs do NOT carry a size override (CodeBlock style owns it)', async () => {
    // splitCodeLines previously passed `code: true` into runOptions,
    // which forced a run-level size/font override on every Shiki
    // span even though the `CodeBlock` paragraph style already
    // sets both. Regression guard: assert no `<w:sz>` inside
    // paragraph runs styled CodeBlock.
    const md = '```js\nconst x = 1;\n```\n';
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    const codePara = documentXml.match(
      /<w:p\b[^>]*>(?:(?!<\/w:p>)[\s\S])*<w:pStyle w:val="CodeBlock"[\s\S]*?<\/w:p>/,
    );
    expect(codePara).not.toBeNull();
    // No `<w:sz>` in any run-properties block inside the code
    // paragraph. Shiki colors should still be there — those go via
    // `<w:color>`, not `<w:sz>`.
    expect(codePara![0]).not.toMatch(/<w:rPr>[\s\S]*?<w:sz\b/);
  });
});

describe('exportDocx — image placeholder labels (follow-up)', () => {
  test('missing alt + data: URL does NOT leak the URL into the placeholder', async () => {
    // `![](data:image/svg+xml,<svg/>)` — SVG falls back because we
    // don't support it, and there's no alt text. Previously the
    // placeholder would dump the full data URL into the body. Now
    // it should say "embedded image".
    const dataUrl = 'data:image/svg+xml;base64,' + 'A'.repeat(500);
    const md = `![](${dataUrl})\n`;
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).toContain('embedded image');
    expect(documentXml).not.toContain('A'.repeat(80)); // URL body isn't dumped
    expect(documentXml).not.toContain('data:image');
  });

  test('missing alt + http URL falls back to the filename', async () => {
    const md = '![](https://cdn.example.com/path/to/Logo_v2.png)\n';
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).toContain('[image: Logo_v2.png]');
    expect(documentXml).not.toContain('https://cdn.example.com');
  });

  test('missing alt + relative path falls back to the basename', async () => {
    // The client didn't attach this ref → resolveAsset returns null
    // → placeholder. Should use the ref as-is since it's short.
    const md = '![](diagrams/flow.png)\n';
    const buf = await exportDocx(md, { includeToc: false, resolveAsset: async () => null });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).toContain('[image: flow.png]');
  });

  test('alt text is still preferred over src-derived labels', async () => {
    const md = '![Company logo](https://cdn.example.com/logo.png)\n';
    const buf = await exportDocx(md, { includeToc: false, resolveAsset: async () => null });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).toContain('[image: Company logo]');
    expect(documentXml).not.toContain('logo.png');
  });
});

describe('exportDocx — base font size calibration', () => {
  async function loadStyles(buf: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(buf);
    return (await zip.file('word/styles.xml')?.async('string')) ?? '';
  }

  test('default theme: Normal is 12pt (24 half-points)', async () => {
    const buf = await exportDocx('Body.', { theme: 'default', includeToc: false });
    const stylesXml = await loadStyles(buf);
    // The document default run size sits inside <w:docDefaults><w:rPrDefault>.
    const defaultRunSize = stylesXml.match(
      /<w:docDefaults>[\s\S]*?<w:rPrDefault>[\s\S]*?<w:sz\s+w:val="(\d+)"/,
    );
    expect(defaultRunSize).not.toBeNull();
    // 12pt = 24 half-points.
    expect(defaultRunSize![1]).toBe('24');
  });

  test('technical theme is denser (10pt) and beautiful is larger (13pt)', async () => {
    const [tech, beautiful] = await Promise.all([
      exportDocx('Body.', { theme: 'technical', includeToc: false }).then(loadStyles),
      exportDocx('Body.', { theme: 'beautiful', includeToc: false }).then(loadStyles),
    ]);
    expect(tech).toMatch(
      /<w:docDefaults>[\s\S]*?<w:rPrDefault>[\s\S]*?<w:sz\s+w:val="20"/,
    );
    expect(beautiful).toMatch(
      /<w:docDefaults>[\s\S]*?<w:rPrDefault>[\s\S]*?<w:sz\s+w:val="26"/,
    );
  });

  test('body and list paragraphs use fixed 1.5 line spacing in DOCX', async () => {
    const stylesXml = await exportDocx('- one\n- two\n\nBody.', {
      theme: 'beautiful',
      includeToc: false,
    }).then(loadStyles);
    // 1.5 lines in Word's 240ths-of-a-line unit = 360. This is a
    // DOCX-specific override; browser theme line-height can differ.
    expect(stylesXml).toMatch(
      /<w:docDefaults>[\s\S]*?<w:pPrDefault>[\s\S]*?<w:spacing[^>]*w:line="360"/,
    );
    // Word's built-in ListParagraph style should keep inheriting that
    // body spacing instead of overriding it with its own line height.
    const listParagraphStyle = stylesXml.match(
      /<w:style[^>]*w:styleId="ListParagraph"[\s\S]*?>([\s\S]*?)<\/w:style>/,
    );
    expect(listParagraphStyle).not.toBeNull();
    expect(listParagraphStyle![1]).not.toContain('<w:spacing');
  });

  test('normal, list, and table-cell paragraphs never exceed 1.5 line spacing', async () => {
    const md = [
      'Normal paragraph.',
      '',
      '- List item.',
      '',
      '| Column |',
      '|--------|',
      '| Cell text |',
    ].join('\n');
    const buf = await exportDocx(md, { theme: 'beautiful', includeToc: false });
    const { documentXml } = await inspectDocx(buf);

    for (const text of ['Normal paragraph.', 'List item.', 'Cell text']) {
      expect(paragraphContaining(documentXml, text)).toMatch(/<w:spacing[^>]*w:line="360"/);
    }

    const lineValues = [...documentXml.matchAll(/w:line="(\d+)"/g)].map((m) =>
      Number(m[1]),
    );
    expect(lineValues.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...lineValues)).toBeLessThanOrEqual(360);
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

  test('footnote whose body references another footnote resolves that ref', async () => {
    // Regression: previously the second pass in `extractFootnotes`
    // ran with an empty `ctx.footnoteIds`, so cross-refs between
    // footnotes rendered as plain internal links instead of real
    // `FootnoteReferenceRun`s.
    const md = [
      'Intro[^a] and[^b].',
      '',
      '[^a]: First note — see also[^b].',
      '[^b]: Second note.',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const footnotesXml = await loadFootnotes(buf);
    // The first footnote's body should contain a footnoteReference
    // pointing at footnote 2 (the cross-ref), not just plain text.
    expect(footnotesXml).toMatch(/<w:footnoteReference\b/);
  });

  test('direct text inside a footnote <li> is preserved', async () => {
    // GFM normally wraps footnote bodies in `<p>`, but if a <li>
    // somehow ends up with a bare text child (we use raw HTML here
    // to construct the shape) the exporter must not silently drop
    // the text. Regression guard: the walker previously skipped
    // non-element children unconditionally.
    const md = [
      'Anchor text.',
      '',
      '<section data-footnotes class="footnotes"><ol>',
      '<li id="user-content-fn-stray">Bare text child</li>',
      '</ol></section>',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const footnotesXml = await loadFootnotes(buf);
    expect(footnotesXml).toContain('Bare text child');
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

describe('exportDocx — blockquote nesting', () => {
  test('blockquote with a nested list preserves the bullets', async () => {
    // Regression: the previous `case 'blockquote'` flattened every
    // child via `collectInline`, so an inner `<ul>` lost its
    // numbering and items became a single plain-text run.
    const md = [
      '> Intro paragraph.',
      '>',
      '> - item one',
      '> - item two',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // The intro paragraph carries Blockquote styling.
    expect(documentXml).toMatch(/<w:pStyle w:val="Blockquote"/);
    // List items keep their numbering properties — NOT flattened.
    const numPrInBlockquote = documentXml.match(/<w:numPr\b/g) ?? [];
    expect(numPrInBlockquote.length).toBe(2);
    expect(documentXml).toContain('item one');
    expect(documentXml).toContain('item two');
  });

  test('blockquote list items keep Blockquote styling instead of plain ListParagraph', async () => {
    const md = [
      '> Intro paragraph.',
      '>',
      '> - item one',
      '> - item two',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // The quoted list paragraphs need BOTH the quote style and list
    // numbering. Without the fix they came out as plain ListParagraph
    // items, so the left quote bar/indent disappeared in Word.
    expect(documentXml).toMatch(
      /<w:pStyle w:val="Blockquote"\/>[\s\S]*?<w:numPr>[\s\S]*?item one/,
    );
    expect(documentXml).toMatch(
      /<w:pStyle w:val="Blockquote"\/>[\s\S]*?<w:numPr>[\s\S]*?item two/,
    );
    expect(documentXml).not.toContain('<w:pStyle w:val="ListParagraph"/>');
  });

  test('blockquote list paragraphs carry explicit quote context in source order', async () => {
    const md = [
      '> Quoted preamble.',
      '>',
      '> - quoted item one',
      '> - quoted item two',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    const preamble = paragraphContaining(documentXml, 'Quoted preamble.');
    const firstItem = paragraphContaining(documentXml, 'quoted item one');
    const secondItem = paragraphContaining(documentXml, 'quoted item two');

    expect(documentXml.indexOf('Quoted preamble.')).toBeLessThan(
      documentXml.indexOf('quoted item one'),
    );
    expect(documentXml.indexOf('quoted item one')).toBeLessThan(
      documentXml.indexOf('quoted item two'),
    );
    for (const paragraph of [preamble, firstItem, secondItem]) {
      expect(paragraph).toMatch(/<w:pStyle w:val="Blockquote"/);
      expect(paragraph).toMatch(/<w:left[^>]*w:val="single"/);
      expect(paragraph).toMatch(/<w:ind[^>]*w:left="\d+"/);
    }
    expect(firstItem).toMatch(/<w:numPr>/);
    expect(secondItem).toMatch(/<w:numPr>/);
  });

  test('blockquote with a nested code block keeps CodeBlock styling', async () => {
    const md = [
      '> Quoted prose.',
      '>',
      '> ```js',
      '> const x = 1;',
      '> ```',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // The prose paragraph is styled Blockquote.
    expect(documentXml).toMatch(/<w:pStyle w:val="Blockquote"[\s\S]*?Quoted prose\./);
    // The code block keeps its own CodeBlock style (NOT Blockquote).
    expect(documentXml).toMatch(/<w:pStyle w:val="CodeBlock"/);
    // Shiki splits the code into per-token runs, so `const x = 1;`
    // won't appear contiguously. Assert on the individual tokens
    // — `const` and `1` are enough to confirm the code survived.
    expect(documentXml).toContain('const');
    expect(documentXml).toContain('1');
  });

  test('blockquote with multiple paragraphs keeps each as its own Blockquote paragraph', async () => {
    const md = ['> First paragraph.', '>', '> Second paragraph.'].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // Both paragraphs carry Blockquote styling — and they're
    // distinct paragraphs, not a merged run.
    const bqMatches = documentXml.match(/<w:pStyle w:val="Blockquote"/g) ?? [];
    expect(bqMatches.length).toBe(2);
    expect(documentXml).toContain('First paragraph.');
    expect(documentXml).toContain('Second paragraph.');
  });

  test('footnote blockquote with a list keeps both intact', async () => {
    const md = [
      'See[^a].',
      '',
      '[^a]: > A quoted preamble.',
      '    >',
      '    > - first bullet',
      '    > - second bullet',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const zip = await JSZip.loadAsync(buf);
    const footnotesXml =
      (await zip.file('word/footnotes.xml')?.async('string')) ?? '';
    expect(footnotesXml).toContain('A quoted preamble.');
    expect(footnotesXml).toContain('first bullet');
    expect(footnotesXml).toContain('second bullet');
  });
});

describe('exportDocx — list items', () => {
  test('multi-paragraph list items preserve paragraph boundaries', async () => {
    // Loose-list markdown: each item's second paragraph should NOT
    // carry its own bullet, but it MUST stay a distinct paragraph —
    // the previous flattening merged the two paragraphs' text
    // into one long run.
    const md = [
      '- First paragraph of item one.',
      '',
      '  Second paragraph of item one.',
      '',
      '- Item two.',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);

    // Both halves of item one appear — and they are separate
    // paragraphs (there's a closing `</w:p>` between them).
    const firstIdx = documentXml.indexOf('First paragraph of item one.');
    const secondIdx = documentXml.indexOf('Second paragraph of item one.');
    const itemTwoIdx = documentXml.indexOf('Item two.');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(-1);
    expect(itemTwoIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(secondIdx);
    expect(secondIdx).toBeLessThan(itemTwoIdx);
    // There's at least one `</w:p>` between the two halves — proves
    // they're distinct paragraphs, not merged runs.
    const between = documentXml.slice(firstIdx, secondIdx);
    expect(between).toContain('</w:p>');

    // Bullet count: exactly two numPr entries (one per list item),
    // NOT three. If the continuation paragraph picked up a bullet,
    // we'd see three.
    const numPrMatches = documentXml.match(/<w:numPr\b/g) ?? [];
    expect(numPrMatches.length).toBe(2);
  });

  test('list item starting with bold paragraph has bullet on same line as bold text', async () => {
    // Regression: whitespace text nodes between <p> children in a loose <li>
    // were accumulating in pendingInline and flushing as an empty bulleted
    // paragraph, pushing the bold text into a continuation paragraph (no bullet).
    const md = ['- **Einfachheit vor Komplexität**', '', '  Beschreibungstext.', ''].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);

    const boldParagraph = paragraphContaining(documentXml, 'Einfachheit vor Komplexit');
    const continuationParagraph = paragraphContaining(documentXml, 'Beschreibungstext');

    // Exactly one numPr entry — only the bulleted paragraph.
    const numPrMatches = documentXml.match(/<w:numPr\b/g) ?? [];
    expect(numPrMatches.length).toBe(1);
    // The bold text paragraph must contain the numPr.
    expect(boldParagraph).toContain('<w:numPr');
    // The continuation paragraph must remain a non-bulleted paragraph.
    expect(continuationParagraph).not.toContain('<w:numPr');
  });

  test('list item with a nested list preserves the nesting', async () => {
    // Regression: the rewrite must keep nested lists working and
    // place them at the correct depth (level + 1).
    const md = [
      '- outer one',
      '  - nested a',
      '  - nested b',
      '- outer two',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).toContain('outer one');
    expect(documentXml).toContain('nested a');
    expect(documentXml).toContain('nested b');
    expect(documentXml).toContain('outer two');
    // Four list items → four numbered paragraphs.
    const numPrMatches = documentXml.match(/<w:numPr\b/g) ?? [];
    expect(numPrMatches.length).toBe(4);
  });

  test('list item and continuation paragraphs use 3pt after spacing', async () => {
    const md = [
      '- First paragraph.',
      '',
      '  Continuation paragraph.',
      '',
      '- Second item.',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    expect(paragraphContaining(documentXml, 'First paragraph.')).toMatch(
      /<w:spacing[^>]*w:after="60"/,
    );
    expect(paragraphContaining(documentXml, 'Continuation paragraph.')).toMatch(
      /<w:spacing[^>]*w:after="60"/,
    );
    expect(paragraphContaining(documentXml, 'Second item.')).toMatch(
      /<w:spacing[^>]*w:after="60"/,
    );
  });
});

describe('exportDocx — grid tables', () => {
  test('grid-table cell content survives to document.xml', async () => {
    // Pandoc-style grid table. `preprocessGridTables` converts it to
    // an HTML `<table>` by rendering each cell's markdown via
    // `renderCellForDocx`. A no-op renderCell (the old bug) would
    // leave every cell empty in the export.
    const md = [
      '+---------+---------+',
      '| Head A  | Head B  |',
      '+=========+=========+',
      '| cell-a1 | cell-b1 |',
      '+---------+---------+',
      '| cell-a2 | cell-b2 |',
      '+---------+---------+',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // Every header and body cell makes it into the rendered DOCX.
    expect(documentXml).toContain('Head A');
    expect(documentXml).toContain('Head B');
    expect(documentXml).toContain('cell-a1');
    expect(documentXml).toContain('cell-b1');
    expect(documentXml).toContain('cell-a2');
    expect(documentXml).toContain('cell-b2');
  });

  test('grid-table cells with inline formatting render bold / italic runs', async () => {
    const md = [
      '+-----------+------------+',
      '| **bold**  | *italic*   |',
      '+===========+============+',
      '| plain     | `code`     |',
      '+-----------+------------+',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    expect(documentXml).toContain('bold');
    expect(documentXml).toContain('italic');
    expect(documentXml).toMatch(/<w:b\b/); // bold run property
    expect(documentXml).toMatch(/<w:i\b/); // italic run property
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

  test('paragraph after a table keeps explicit top spacing', async () => {
    const md = [
      '| A | B |',
      '|---|---|',
      '| 1 | 2 |',
      '',
      'Next paragraph.',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    // Tables don't contribute paragraph spacing on their own. The
    // paragraph after the table must carry a `before` spacing so Word
    // leaves a visible gap instead of collapsing the blocks together.
    expect(documentXml).toMatch(
      /<w:tbl>[\s\S]*?<\/w:tbl>[\s\S]*?<w:p>[\s\S]*?<w:spacing[^>]*w:before="144"[\s\S]*?Next paragraph\./,
    );
  });

  test('paragraph after a table inside a transparent container gets normal top spacing', async () => {
    const md = [
      '<div>',
      '<table><tbody><tr><td>1</td></tr></tbody></table>',
      '</div>',
      '',
      'Next paragraph.',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    expect(paragraphContaining(documentXml, 'Next paragraph.')).toMatch(
      /<w:spacing[^>]*w:before="144"/,
    );
  });

  test('paragraph after a quoted table gets normal top spacing', async () => {
    const md = [
      '> | A | B |',
      '> |---|---|',
      '> | 1 | 2 |',
      '>',
      '> Next quoted paragraph.',
    ].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml } = await inspectDocx(buf);
    expect(paragraphContaining(documentXml, 'Next quoted paragraph.')).toMatch(
      /<w:spacing[^>]*w:before="144"/,
    );
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

describe('exportDocx — mermaid resolveMermaid', () => {
  test('embeds rendered PNG when resolveMermaid returns bytes', async () => {
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
    let calls = 0;
    let calledIndex = -1;
    let calledSource = '';
    const buf = await exportDocx(md, {
      includeToc: false,
      resolveMermaid: async (source, index) => {
        calls += 1;
        calledIndex = index;
        calledSource = source;
        return { bytes: PNG_1x1_BYTES, mime: 'image/png' };
      },
    });
    const { documentXml, mediaFiles } = await inspectDocx(buf);
    // Resolver got the right index and source.
    expect(calls).toBe(1);
    expect(calledIndex).toBe(0);
    expect(calledSource).toContain('graph TD');
    // The PNG landed in word/media/ — proves it was embedded as a
    // real image part, not stringified into document.xml.
    expect(mediaFiles.length).toBe(1);
    // No fallback placeholder, since we resolved successfully.
    expect(documentXml).not.toContain('mermaid diagram');
    expect(documentXml).not.toContain('graph TD');
    // Surrounding content still flows.
    expect(documentXml).toContain('After.');
  });

  test('falls back to placeholder when resolveMermaid returns null', async () => {
    const md = ['```mermaid', 'graph TD', '  A --> B', '```'].join('\n');
    const buf = await exportDocx(md, {
      includeToc: false,
      resolveMermaid: async () => null,
    });
    const { documentXml, mediaFiles } = await inspectDocx(buf);
    expect(mediaFiles.length).toBe(0);
    expect(documentXml).toContain('mermaid diagram');
    expect(documentXml).toContain('graph TD');
  });

  test('falls back to placeholder when resolveMermaid throws', async () => {
    const md = ['```mermaid', 'graph TD', '  A --> B', '```'].join('\n');
    const buf = await exportDocx(md, {
      includeToc: false,
      resolveMermaid: async () => {
        throw new Error('renderer crashed');
      },
    });
    const { documentXml, mediaFiles } = await inspectDocx(buf);
    expect(mediaFiles.length).toBe(0);
    expect(documentXml).toContain('mermaid diagram');
  });

  test('renders multiple diagrams independently with distinct indices', async () => {
    const md = [
      '```mermaid',
      'graph TD',
      'A --> B',
      '```',
      '',
      'Between.',
      '',
      '```mermaid',
      'graph LR',
      'X --> Y',
      '```',
    ].join('\n');
    const seenIndices: number[] = [];
    const buf = await exportDocx(md, {
      includeToc: false,
      resolveMermaid: async (_source, index) => {
        seenIndices.push(index);
        // Return per-index distinct bytes so the docx packer can't
        // dedupe identical media into a single part — that would
        // hide the case where only one of the two diagrams actually
        // got resolved. Keep the PNG bytes intact and append a
        // trailing byte after IEND so each payload is distinct
        // without corrupting the image (mutating an in-stream byte
        // would invalidate the IEND CRC).
        const tagged = new Uint8Array(PNG_1x1_BYTES.length + 1);
        tagged.set(PNG_1x1_BYTES);
        tagged[PNG_1x1_BYTES.length] = index;
        return { bytes: tagged, mime: 'image/png' };
      },
    });
    const { mediaFiles } = await inspectDocx(buf);
    // Both diagrams resolved with distinct indices.
    expect(seenIndices.sort()).toEqual([0, 1]);
    // Two PNGs embedded — confirms each block is its own image part.
    expect(mediaFiles.length).toBe(2);
  });

  test('uses ResolvedAsset width/height for display when supplied (hi-res PNG)', async () => {
    // The chromium resolver renders at deviceScaleFactor>1 so PNG
    // bytes carry more actual pixels than the natural CSS-px size.
    // It returns `width`/`height` to tell the exporter which is the
    // natural display size; without that, docx would tell Word to
    // display at the inflated pixel count and enlarge the diagram.
    //
    // This test simulates a 4× hi-res PNG by handing the resolver
    // a bytes-level fixture of one size while declaring a 4×-smaller
    // natural display size. The resulting docx extent must match
    // the natural size, not the bytes' actual pixels.
    //
    // Construct a 100×100 PNG fixture (1×1 source upscaled by data
    // URL would do, but we just synthesise an IHDR with the right
    // dims so `image-size` reports 100×100). The image-size library
    // only reads IHDR for PNG; the rest can be junk for this test.
    const png100 = makeIhdrOnlyPngFixture(100, 100);
    const buf = await exportDocx(
      ['```mermaid', 'graph TD\nA --> B', '```'].join('\n'),
      {
        includeToc: false,
        resolveMermaid: async () => ({
          bytes: png100,
          mime: 'image/png',
          // Declare natural display as 25×25 — 4× smaller than the
          // bytes' actual 100×100. docx must honour these.
          width: 25,
          height: 25,
        }),
      },
    );
    const { documentXml } = await inspectDocx(buf);
    // docx ImageRun emits extent in EMU (914400 = 1 inch, 9525 = 1
    // px at 96 DPI). 25 px → 25 * 9525 = 238125 EMU.
    const ext = documentXml.match(/<wp:extent\s+cx="(\d+)"\s+cy="(\d+)"/);
    expect(ext).not.toBeNull();
    const cx = Number(ext![1]);
    const cy = Number(ext![2]);
    // 25 CSS px → ~238125 EMU. Allow a small rounding window.
    expect(cx).toBeGreaterThan(220_000);
    expect(cx).toBeLessThan(260_000);
    expect(cy).toBeGreaterThan(220_000);
    expect(cy).toBeLessThan(260_000);
    // Sanity: if we'd used the 100×100 byte dimensions, extent would
    // be ~952500 EMU — well outside the window above.
  });

  test('falls back to placeholder when no resolveMermaid is provided', async () => {
    const md = ['```mermaid', 'graph TD', 'A --> B', '```'].join('\n');
    const buf = await exportDocx(md, { includeToc: false });
    const { documentXml, mediaFiles } = await inspectDocx(buf);
    expect(mediaFiles.length).toBe(0);
    expect(documentXml).toContain('mermaid diagram');
  });

  test('embeds mermaid PNG for AsciiDoc-format input', async () => {
    // The asciidoc plugin (`rehypeAsciidocMermaid`) builds hast
    // Elements directly with `'data-mermaid-index'` (hyphenated) as
    // the property key — different from the markdown path's
    // `dataMermaidIndex` (camelCase, normalised by `rehypeRaw`).
    // Both spellings must reach the resolver and the walker so the
    // diagram embeds end-to-end on either format.
    const adoc = [
      '= Title',
      '',
      '[mermaid]',
      '----',
      'graph TD',
      'A --> B',
      '----',
    ].join('\n');
    let calls = 0;
    let calledIndex = -1;
    let calledSource = '';
    const buf = await exportDocx(adoc, {
      format: 'asciidoc',
      includeToc: false,
      resolveMermaid: async (source, index) => {
        calls += 1;
        calledIndex = index;
        calledSource = source;
        return { bytes: PNG_1x1_BYTES, mime: 'image/png' };
      },
    });
    const { documentXml, mediaFiles } = await inspectDocx(buf);
    // Resolver got the AsciiDoc-emitted index + source.
    expect(calls).toBe(1);
    expect(calledIndex).toBe(0);
    expect(calledSource).toContain('graph TD');
    // The PNG was embedded as a real image part — no fallback.
    expect(mediaFiles.length).toBe(1);
    expect(documentXml).not.toContain('mermaid diagram');
    expect(documentXml).not.toContain('graph TD');
  });

  test('bounds parallelism via mermaidConcurrency', async () => {
    // 5 mermaid blocks, concurrency limit 2 → at no point should
    // more than 2 resolves be in flight simultaneously. Each
    // resolver call sleeps briefly while another peek can race
    // through; the high-watermark counter catches violations.
    const md = Array.from({ length: 5 }, (_, i) =>
      ['```mermaid', `graph TD`, `A${i} --> B${i}`, '```'].join('\n'),
    ).join('\n\n');
    let inFlight = 0;
    let highWatermark = 0;
    const buf = await exportDocx(md, {
      includeToc: false,
      mermaidConcurrency: 2,
      resolveMermaid: async (_source, _index) => {
        inFlight += 1;
        highWatermark = Math.max(highWatermark, inFlight);
        // Yield twice so concurrent calls really do overlap when
        // allowed; without this the awaits would all settle in the
        // same microtask and inFlight would never exceed 1.
        await new Promise((r) => setTimeout(r, 5));
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { bytes: PNG_1x1_BYTES, mime: 'image/png' };
      },
    });
    const { mediaFiles } = await inspectDocx(buf);
    // All five diagrams resolved (single dedup'd media file is fine —
    // we're testing the pool bound, not the embed semantics).
    expect(mediaFiles.length).toBeGreaterThanOrEqual(1);
    // Pool actually limited concurrency.
    expect(highWatermark).toBeLessThanOrEqual(2);
    // Sanity: pool actually achieved >1 in flight (so the test is
    // exercising the path, not just sequentializing by accident).
    expect(highWatermark).toBeGreaterThan(1);
  });
});

// --- Review-mode export -----------------------------------------------
// Comments + edit proposals (tracked changes) folded into the DOCX.
// Anchors come from the same `data-block` ids the renderer's
// `remarkBlockIds` plugin writes onto every top-level block, so we
// extract those from a probe render before constructing the threads.

import { hashBlock, normalizeBlockText } from '../src/block-ids-shared.js';

/** Compute the block-id `remarkBlockIds` would assign to a markdown paragraph. */
function paragraphBlockId(text: string): string {
  return hashBlock('paragraph', normalizeBlockText(text));
}

/** Compute the block-id for a markdown heading. */
function headingBlockId(text: string): string {
  return hashBlock('heading', normalizeBlockText(text));
}

async function inspectComments(buf: Buffer): Promise<{
  commentsXml: string;
  documentXml: string;
}> {
  const zip = await JSZip.loadAsync(buf);
  const commentsXml = (await zip.file('word/comments.xml')?.async('string')) ?? '';
  const documentXml = (await zip.file('word/document.xml')?.async('string')) ?? '';
  return { commentsXml, documentXml };
}

/** Count `<w:comment …>` entries in word/comments.xml (excluding empty docx-default). */
function countComments(commentsXml: string): number {
  return (commentsXml.match(/<w:comment\s/g) ?? []).length;
}

describe('exportDocx — review mode (comments)', () => {
  test('vanilla export contains no comment entries', async () => {
    const buf = await exportDocx('# Doc\n\nHello.\n');
    const { commentsXml, documentXml } = await inspectComments(buf);
    expect(countComments(commentsXml)).toBe(0);
    expect(documentXml).not.toMatch(/<w:commentReference\b/);
  });

  test('comment thread emits a comments.xml entry anchored to its block', async () => {
    const md = '# Title\n\nThis is the target paragraph.\n';
    const blockId = paragraphBlockId('This is the target paragraph.');
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: blockId,
            comments: [
              { body: 'Looks good to me', author: 'Alice', date: 1700000000000 },
            ],
          },
        ],
      },
    });
    const { commentsXml, documentXml } = await inspectComments(buf);
    expect(commentsXml).toContain('Looks good to me');
    expect(commentsXml).toMatch(/w:author="Alice"/);
    // Both range markers + the inline reference made it into the body.
    expect(documentXml).toMatch(/<w:commentRangeStart\b/);
    expect(documentXml).toMatch(/<w:commentRangeEnd\b/);
    expect(documentXml).toMatch(/<w:commentReference\b/);
  });

  test('replies render as flat additional comments with reply prefix', async () => {
    const md = 'Single block.\n';
    const blockId = paragraphBlockId('Single block.');
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: blockId,
            comments: [
              { body: 'Opener', author: 'Alice', date: 1700000000000 },
              { body: 'first reply', author: 'Bob', date: 1700000100000 },
              { body: 'second reply', author: 'Carol', date: 1700000200000 },
            ],
          },
        ],
      },
    });
    const { commentsXml } = await inspectComments(buf);
    expect(commentsXml).toContain('Opener');
    expect(commentsXml).toContain('↳ Reply by Bob: first reply');
    expect(commentsXml).toContain('↳ Reply by Carol: second reply');
  });

  test('resolved threads are skipped by default', async () => {
    const md = 'Block.\n';
    const blockId = paragraphBlockId('Block.');
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: blockId,
            resolved: true,
            resolution_kind: 'resolve',
            comments: [{ body: 'Old comment', author: 'A', date: 1 }],
          },
        ],
      },
    });
    const { commentsXml } = await inspectComments(buf);
    expect(countComments(commentsXml)).toBe(0);
  });

  test('includeResolved opts resolved threads back in', async () => {
    const md = 'Block.\n';
    const blockId = paragraphBlockId('Block.');
    const buf = await exportDocx(md, {
      review: {
        includeResolved: true,
        threads: [
          {
            id: 't1',
            block_id: blockId,
            resolved: true,
            comments: [{ body: 'Old comment', author: 'A', date: 1 }],
          },
        ],
      },
    });
    const { commentsXml } = await inspectComments(buf);
    expect(commentsXml).toContain('Old comment');
  });

  test('comment anchored to a heading lands on the heading paragraph', async () => {
    const md = '# Heading One\n\nBody.\n';
    const blockId = headingBlockId('Heading One');
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: blockId,
            comments: [{ body: 'About the heading', author: 'A', date: 1 }],
          },
        ],
      },
    });
    const { commentsXml, documentXml } = await inspectComments(buf);
    expect(commentsXml).toContain('About the heading');
    // The comment range markers should land inside the heading paragraph.
    const headingPara = paragraphContaining(documentXml, 'Heading One');
    expect(headingPara).toMatch(/<w:commentRangeStart\b/);
    expect(headingPara).toMatch(/<w:commentReference\b/);
  });

  test('thread with no resolvable block id is silently dropped', async () => {
    const md = 'Block.\n';
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: 'no-such-id',
            comments: [{ body: 'orphaned', author: 'A', date: 1 }],
          },
        ],
      },
    });
    // No matching anchor → comment is allocated but no range markers
    // appear in the body. (The unanchored comment is still legal OOXML;
    // Word shows it in the comment pane without a highlight.)
    const { documentXml } = await inspectComments(buf);
    expect(documentXml).not.toMatch(/<w:commentReference\b/);
  });
});

describe('exportDocx — review mode (proposals as tracked changes)', () => {
  test('block-level proposal emits w:del for original and w:ins for proposed', async () => {
    const md = 'Original sentence.\n';
    const blockId = paragraphBlockId('Original sentence.');
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: blockId,
            comments: [{ body: 'Wording tweak', author: 'Editor', date: 1700000000000 }],
            proposal: {
              source_snapshot: 'Original sentence.',
              proposed_text: 'Revised sentence.',
              whole_document: false,
            },
          },
        ],
      },
    });
    const { documentXml } = await inspectComments(buf);
    expect(documentXml).toMatch(/<w:del\b[^>]*w:author="Editor"/);
    expect(documentXml).toMatch(/<w:ins\b[^>]*w:author="Editor"/);
    // The single-paragraph plain-prose proposal hits the inline
    // word-diff path: only the changed token ("Original" vs
    // "Revised") sits inside ins/del, the shared " sentence."
    // suffix appears as a plain run.
    expect(documentXml).toContain('Original');
    expect(documentXml).toContain('Revised');
    expect(documentXml).toMatch(/<w:r><w:t[^>]*> sentence\.<\/w:t><\/w:r>/);
  });

  test('single-paragraph wording tweak emits inline word-level ins/del', async () => {
    const md = 'The quick brown fox.\n';
    const blockId = paragraphBlockId('The quick brown fox.');
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: blockId,
            comments: [{ body: 'tweak', author: 'Editor', date: 1 }],
            proposal: {
              source_snapshot: 'The quick brown fox.',
              proposed_text: 'The quick red fox.',
            },
          },
        ],
      },
    });
    const { documentXml } = await inspectComments(buf);
    // Deleted runs use <w:delText>, inserted runs use <w:t>.
    expect(documentXml).toMatch(/<w:del\b[^>]*>[\s\S]*?<w:delText[^>]*>brown<\/w:delText>/);
    expect(documentXml).toMatch(/<w:ins\b[^>]*>[\s\S]*?<w:t[^>]*>red<\/w:t>/);
    // The unchanged prefix "The quick " should appear as a plain run
    // (this catches the "everything is wrapped" regression).
    expect(documentXml).toMatch(/<w:r><w:t[^>]*>The quick <\/w:t><\/w:r>/);
    // Suffix " fox." also stays plain.
    expect(documentXml).toMatch(/<w:r><w:t[^>]*> fox\.<\/w:t><\/w:r>/);
  });

  test('multi-paragraph proposal still uses the structural two-pass path', async () => {
    // Two paragraphs on the proposed side: the inline-diff guard
    // should bail, and the original block becomes a single <w:del>
    // chain followed by two inserted paragraphs.
    const md = 'Original line.\n';
    const blockId = paragraphBlockId('Original line.');
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: blockId,
            comments: [{ body: 'expand', author: 'Editor', date: 1 }],
            proposal: {
              source_snapshot: 'Original line.',
              proposed_text: 'First line.\n\nSecond line.',
            },
          },
        ],
      },
    });
    const { documentXml } = await inspectComments(buf);
    expect(documentXml).toMatch(/<w:del\b/);
    expect(documentXml).toMatch(/<w:ins\b/);
    // Both proposed paragraphs land in the body.
    expect(documentXml).toContain('First line');
    expect(documentXml).toContain('Second line');
  });

  test('proposal that adds inline formatting falls back to two-pass', async () => {
    // The proposed side contains a `<strong>` — the inline-diff
    // guard refuses to flatten formatting, so we expect the
    // structural two-pass output (whole original deleted, whole
    // proposed inserted with formatting preserved).
    const md = 'Plain text here.\n';
    const blockId = paragraphBlockId('Plain text here.');
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: blockId,
            comments: [{ body: 'bold it', author: 'Editor', date: 1 }],
            proposal: {
              source_snapshot: 'Plain text here.',
              proposed_text: 'Plain **text** here.',
            },
          },
        ],
      },
    });
    const { documentXml } = await inspectComments(buf);
    // Bold attribute survives → structural path was used.
    expect(documentXml).toMatch(/<w:b\b/);
  });

  test('proposal thread body still becomes a comment on the inserted region', async () => {
    const md = 'Old line.\n';
    const blockId = paragraphBlockId('Old line.');
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: blockId,
            comments: [
              { body: 'Reason: clearer phrasing', author: 'Editor', date: 1 },
            ],
            proposal: {
              source_snapshot: 'Old line.',
              proposed_text: 'New line.',
            },
          },
        ],
      },
    });
    const { commentsXml } = await inspectComments(buf);
    expect(commentsXml).toContain('Reason: clearer phrasing');
  });

  test('whole-document proposal appears as a labeled appendix', async () => {
    const md = 'Body of original doc.\n';
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: null,
            comments: [{ body: 'Full rewrite', author: 'Drafter', date: 0 }],
            proposal: {
              source_snapshot: 'Body of original doc.',
              proposed_text: 'Entirely fresh draft.',
              whole_document: true,
            },
          },
        ],
      },
    });
    const { documentXml } = await inspectComments(buf);
    expect(documentXml).toContain('Alternative version proposed by Drafter');
    expect(documentXml).toContain('Entirely fresh draft');
    // Appendix body wrapped in <w:ins>.
    expect(documentXml).toMatch(/<w:ins\b/);
  });

  test('block with both proposal and side-comment keeps both visible', async () => {
    const md = 'Shared block.\n';
    const blockId = paragraphBlockId('Shared block.');
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 'p1',
            block_id: blockId,
            comments: [{ body: 'Reword', author: 'Editor', date: 1 }],
            proposal: {
              source_snapshot: 'Shared block.',
              proposed_text: 'Reworded block.',
            },
          },
          {
            id: 'c1',
            block_id: blockId,
            comments: [{ body: 'Side note', author: 'Reader', date: 2 }],
          },
        ],
      },
    });
    const { commentsXml, documentXml } = await inspectComments(buf);
    expect(commentsXml).toContain('Reword');
    expect(commentsXml).toContain('Side note');
    // Both proposal and side comment exist, and the proposal's
    // tracked-change pair is still emitted.
    expect(documentXml).toMatch(/<w:del\b/);
    expect(documentXml).toMatch(/<w:ins\b/);
  });

  test('proposal with unreachable content degrades to comment + normal block', async () => {
    const md = 'Original.\n';
    const blockId = paragraphBlockId('Original.');
    // Force the unreachable path by feeding an empty proposed_text
    // — buildReviewState still parses it (yielding an empty HAST),
    // so we instead exercise the runtime fallback by passing
    // `proposed_text` = '' (parses but produces no children) and
    // verifying the export still contains the original text.
    const buf = await exportDocx(md, {
      review: {
        threads: [
          {
            id: 't1',
            block_id: blockId,
            comments: [{ body: 'Maybe drop this', author: 'Editor', date: 1 }],
            proposal: {
              source_snapshot: 'Original.',
              proposed_text: '',
            },
          },
        ],
      },
    });
    const { commentsXml, documentXml } = await inspectComments(buf);
    // Comment is preserved.
    expect(commentsXml).toContain('Maybe drop this');
    // Original text still appears (either inside <w:del> or untouched).
    expect(documentXml).toContain('Original');
  });

  test('omitting the review payload leaves the document body unchanged', async () => {
    // Byte-level equality is not safe (docx writes timestamps into
    // core.xml), so compare the document.xml text — that's what the
    // renderer actually controls.
    const md = '# Plain\n\nBody text here.\n';
    const a = await exportDocx(md);
    const b = await exportDocx(md, {});
    const da = (await inspectComments(a)).documentXml;
    const db = (await inspectComments(b)).documentXml;
    expect(da).toBe(db);
  });
});
