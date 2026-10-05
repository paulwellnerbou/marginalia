import { createHash } from 'node:crypto';
import JSZip from 'jszip';

export interface EpubChapter {
  title: string;
  html: string;
}

export interface EpubCover {
  bytes: Uint8Array;
  mime: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface ExportEpubOptions {
  identifier: string;
  title: string;
  author?: string | null;
  chapters: EpubChapter[];
  cover?: EpubCover | null;
  /** Viewer theme selected for this export. Used for portable theme ornaments. */
  theme?: string;
  modifiedAt?: Date;
}

interface EmbeddedImage {
  path: string;
  mime: string;
  bytes: Uint8Array;
}

/** Build a self-contained EPUB 3 archive from already-sanitized renderer HTML. */
export async function exportEpub(options: ExportEpubOptions): Promise<Uint8Array> {
  const zip = new JSZip();
  // EPUB requires this exact file to be the first local entry and uncompressed.
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    xml(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
  );

  const images = new Map<string, EmbeddedImage>();
  const chapters = options.chapters.map((chapter) => ({
    ...chapter,
    html: applyThemeGraphics(embedDataImages(chapter.html, images), options.theme ?? 'default'),
  }));
  const cover = options.cover ?? null;
  const coverExt = cover ? extensionForMime(cover.mime) : 'svg';
  const coverPath = `images/cover.${coverExt}`;
  const coverBytes = cover?.bytes ?? new TextEncoder().encode(generatedCoverSvg(options.title));
  const coverMime = cover?.mime ?? 'image/svg+xml';
  zip.file(`EPUB/${coverPath}`, coverBytes);

  for (const image of images.values()) zip.file(`EPUB/${image.path}`, image.bytes);

  zip.file('EPUB/styles.css', BOOK_CSS);
  zip.file('EPUB/cover.xhtml', coverXhtml(options.title, coverPath));
  chapters.forEach((chapter, index) => {
    zip.file(
      `EPUB/chapter-${pad(index + 1)}.xhtml`,
      chapterXhtml(options.title, chapter.title, chapter.html),
    );
  });
  zip.file('EPUB/nav.xhtml', navXhtml(options.title, chapters));
  zip.file('EPUB/toc.ncx', tocNcx(options, chapters));
  zip.file(
    'EPUB/package.opf',
    packageOpf(options, chapters, [...images.values()], coverPath, coverMime),
  );

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

function embedDataImages(html: string, images: Map<string, EmbeddedImage>): string {
  return html.replace(
    /\bsrc="data:([^;,"]+);base64,([^"]+)"/g,
    (_match, rawMime: string, payload: string) => {
      const mime = rawMime.toLowerCase();
      const ext = extensionForMime(mime);
      // A payload we can't externalize has no legal form here: `src=""`
      // re-requests the chapter itself, and a surviving `data:` URL
      // isn't a container resource. Drop the attribute so the reader
      // falls back to the alt text.
      if (!ext) return '';
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(payload, 'base64'));
      } catch {
        return '';
      }
      const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      const path = `images/${digest}.${ext}`;
      if (!images.has(path)) images.set(path, { path, mime, bytes });
      return `src="${path}"`;
    },
  );
}

/**
 * EPUB readers vary widely in support for CSS masks, which the web
 * themes use for ornamental rules. Lower known ornaments to real inline
 * SVG so the selected theme's scene break survives in every reader.
 */
function applyThemeGraphics(html: string, theme: string): string {
  const rule = HORIZONTAL_RULES[theme];
  if (!rule) return html;
  return html.replace(/<hr(?:\s[^>]*)?\s*\/?>/gi, rule);
}

function packageOpf(
  options: ExportEpubOptions,
  chapters: EpubChapter[],
  images: EmbeddedImage[],
  coverPath: string,
  coverMime: string,
): string {
  const modified = (options.modifiedAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const chapterItems = chapters
    .map((chapter, index) => {
      const remote = /(?:src|href)="https?:\/\//i.test(chapter.html)
        ? ' properties="remote-resources"'
        : '';
      return `    <item id="chapter-${index + 1}" href="chapter-${pad(index + 1)}.xhtml" media-type="application/xhtml+xml"${remote}/>`;
    })
    .join('\n');
  const imageItems = images
    .map(
      (image, index) =>
        `    <item id="image-${index + 1}" href="${escapeXml(image.path)}" media-type="${escapeXml(image.mime)}"/>`,
    )
    .join('\n');
  const spine = chapters
    .map((_, index) => `    <itemref idref="chapter-${index + 1}"/>`)
    .join('\n');
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(options.identifier)}</dc:identifier>
    <dc:title>${escapeXml(options.title)}</dc:title>
    <dc:language>en</dc:language>
    ${options.author ? `<dc:creator>${escapeXml(options.author)}</dc:creator>` : ''}
    <meta property="dcterms:modified">${modified}</meta>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="cover-image" href="${escapeXml(coverPath)}" media-type="${escapeXml(coverMime)}" properties="cover-image"/>
${chapterItems}${imageItems ? `\n${imageItems}` : ''}
  </manifest>
  <spine toc="ncx">
    <itemref idref="cover-page" linear="no"/>
${spine}
  </spine>
</package>`);
}

function chapterXhtml(bookTitle: string, chapterTitle: string, html: string): string {
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">
<head><title>${escapeXml(chapterTitle || bookTitle)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body>${xhtmlize(html)}</body>
</html>`);
}

function coverXhtml(title: string, coverPath: string): string {
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">
<head><title>Cover — ${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body class="cover"><img src="${escapeXml(coverPath)}" alt="Cover for ${escapeXml(title)}"/></body>
</html>`);
}

function navXhtml(title: string, chapters: EpubChapter[]): string {
  const links = chapters
    .map(
      (chapter, index) =>
        `<li><a href="chapter-${pad(index + 1)}.xhtml">${escapeXml(chapter.title || `Chapter ${index + 1}`)}</a></li>`,
    )
    .join('');
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><title>Contents — ${escapeXml(title)}</title></head>
<body><nav epub:type="toc" id="toc"><h1>Contents</h1><ol>${links}</ol></nav></body>
</html>`);
}

function tocNcx(options: ExportEpubOptions, chapters: EpubChapter[]): string {
  const points = chapters
    .map(
      (chapter, index) => `<navPoint id="nav-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${escapeXml(chapter.title || `Chapter ${index + 1}`)}</text></navLabel>
      <content src="chapter-${pad(index + 1)}.xhtml"/>
    </navPoint>`,
    )
    .join('\n    ');
  return xml(`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${escapeXml(options.identifier)}"/></head>
  <docTitle><text>${escapeXml(options.title)}</text></docTitle>
  <navMap>${points}</navMap>
</ncx>`);
}

function generatedCoverSvg(title: string): string {
  const digest = createHash('sha256').update(title).digest();
  const hueA = (digest[0] ?? 0) % 360;
  const hueB = (hueA + 35 + ((digest[1] ?? 0) % 80)) % 360;
  const lines = wrapTitle(title, 22).slice(0, 5);
  const firstY = 720 - (lines.length - 1) * 62;
  const titleLines = lines
    .map(
      (line, index) =>
        `<text x="800" y="${firstY + index * 124}" text-anchor="middle" class="title">${escapeXml(line)}</text>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="2560" viewBox="0 0 1600 2560">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hueA},58%,25%)"/><stop offset="1" stop-color="hsl(${hueB},68%,48%)"/></linearGradient></defs>
  <rect width="1600" height="2560" fill="url(#g)"/>
  <circle cx="1320" cy="300" r="430" fill="white" opacity=".08"/><circle cx="250" cy="2260" r="520" fill="white" opacity=".06"/>
  <path d="M240 500H1360" stroke="white" opacity=".45" stroke-width="5"/>
  <style>.title{fill:white;font:700 88px Georgia,serif;letter-spacing:1px}</style>
  ${titleLines}
  <path d="M240 2050H1360" stroke="white" opacity=".45" stroke-width="5"/>
</svg>`;
}

function wrapTitle(title: string, width: number): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  for (const word of words) {
    const current = lines.at(-1);
    if (!current || current.length + word.length + 1 > width) lines.push(word);
    else lines[lines.length - 1] = `${current} ${word}`;
  }
  return lines.length > 0 ? lines : ['Untitled'];
}

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Re-serialize the renderer's HTML as XHTML: XML has no bare
 * attributes and no implicitly-closed void elements, and an EPUB
 * reader must abort on a chapter that isn't well-formed.
 *
 * Walks tag by tag instead of pattern-matching the whole document,
 * because to a regex there is nothing to distinguish markup from
 * prose ("the field is readonly until checked") or from an attribute
 * value that contains `>` (`alt="a > b"`) — rewriting either one
 * corrupts the book.
 */
function xhtmlize(html: string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = html.indexOf('<', cursor);
    if (open === -1) return out + html.slice(cursor);
    const name = tagNameAt(html, open);
    const close = name === null ? -1 : tagEnd(html, open);
    if (name === null || close === -1) {
      out += html.slice(cursor, open + 1);
      cursor = open + 1;
      continue;
    }
    out += html.slice(cursor, open) + rewriteTag(html.slice(open, close + 1), name);
    cursor = close + 1;
  }
}

/** Lowercased element name at `open`, or null when `<` opens plain text. */
function tagNameAt(html: string, open: number): string | null {
  let i = open + 1;
  if (html[i] === '/') i += 1;
  const start = i;
  while (i < html.length && /[a-zA-Z0-9]/.test(html[i] as string)) i += 1;
  return i > start ? html.slice(start, i).toLowerCase() : null;
}

/** Index of the `>` that ends the tag at `open`, skipping quoted values. */
function tagEnd(html: string, open: number): number {
  let quote: string | null = null;
  for (let i = open + 1; i < html.length; i++) {
    const ch = html[i] as string;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function rewriteTag(raw: string, lowerName: string): string {
  if (raw.startsWith('</')) return raw;
  // Slice the name back out of `raw` rather than using the lowercased
  // copy: SVG has camelCase tags (`foreignObject`) whose closing tag
  // we leave untouched, so the two have to keep matching.
  const name = raw.slice(1, 1 + lowerName.length);
  const inner = raw.slice(1 + name.length, -1);
  const selfClosed = inner.trimEnd().endsWith('/');
  const attrs = expandBareAttributes(selfClosed ? inner.trimEnd().slice(0, -1) : inner);
  if (selfClosed || VOID_ELEMENTS.has(lowerName)) return `<${name}${attrs.trimEnd()} />`;
  return `<${name}${attrs}>`;
}

/** `<input disabled>` is well-formed HTML but not well-formed XML. */
function expandBareAttributes(attrs: string): string {
  let out = '';
  let i = 0;
  while (i < attrs.length) {
    if (/\s/.test(attrs[i] as string)) {
      out += attrs[i];
      i += 1;
      continue;
    }
    let nameEnd = i;
    while (nameEnd < attrs.length && !/[\s=]/.test(attrs[nameEnd] as string)) nameEnd += 1;
    let valueEnd = nameEnd;
    while (valueEnd < attrs.length && /\s/.test(attrs[valueEnd] as string)) valueEnd += 1;
    if (attrs[valueEnd] !== '=') {
      const name = attrs.slice(i, nameEnd);
      out += `${name}="${name}"`;
      i = nameEnd;
      continue;
    }
    valueEnd += 1;
    while (valueEnd < attrs.length && /\s/.test(attrs[valueEnd] as string)) valueEnd += 1;
    const quote = attrs[valueEnd];
    if (quote === '"' || quote === "'") {
      const end = attrs.indexOf(quote, valueEnd + 1);
      valueEnd = end === -1 ? attrs.length : end + 1;
    } else {
      while (valueEnd < attrs.length && !/\s/.test(attrs[valueEnd] as string)) valueEnd += 1;
    }
    out += attrs.slice(i, valueEnd);
    i = valueEnd;
  }
  return out;
}

function extensionForMime(mime: string): string | null {
  switch (mime.toLowerCase()) {
    case 'image/gif':
      return 'gif';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/svg+xml':
      return 'svg';
    case 'image/webp':
      return 'webp';
    default:
      return null;
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xml(value: string): string {
  return `${value.trim()}\n`;
}

function pad(value: number): string {
  return String(value).padStart(3, '0');
}

const BOOK_CSS = `
html { color-scheme: light; }
body { margin: 5%; font-family: Georgia, "Times New Roman", serif; line-height: 1.55; color: #222; }
h1, h2, h3, h4 { line-height: 1.2; break-after: avoid; }
/* Viewer chrome the renderer injects into every heading / TOC marker.
   Without this the book reads "#Chapter One"; packages/themes/css/
   _print.css drops the same two for the PDF. */
.heading-anchor, .marginalia-toc-marker { display: none; }
img, svg { max-width: 100%; height: auto; }
hr { border: 0; border-top: 1px solid #bbb; margin: 2em 0; }
svg.epub-hr-ornament { display: block; width: 16em; max-width: 100%; margin: 2em auto; color: #6a655a; }
pre { white-space: pre-wrap; font-family: ui-monospace, monospace; font-size: .9em; }
code { font-family: ui-monospace, monospace; }
blockquote { border-left: .2em solid #aaa; margin-left: 0; padding-left: 1em; color: #555; }
table { border-collapse: collapse; max-width: 100%; }
th, td { border: 1px solid #bbb; padding: .35em .5em; }
body.cover { margin: 0; padding: 0; text-align: center; }
body.cover img { width: 100%; height: 100vh; object-fit: contain; }
`;

// Same path data as the `--md-hr-ornament` masks in packages/themes/css/
// beautiful.css ("Book") and book.css ("Document").
const HORIZONTAL_RULES: Record<string, string> = {
  beautiful: `<svg xmlns="http://www.w3.org/2000/svg" class="epub-hr-ornament" viewBox="0 0 720 72" role="separator" aria-label="Section break">
  <path fill="currentColor" d="M30 37 42.4 36.9 54 36.7 65 36.3 75.4 35.7 85.3 35.1 95 34.5 104.4 33.8 113.8 33.1 123.2 32.5 132.8 31.9 142.6 31.4 152.8 31.2 163.6 31.3 175 31.7 187.3 32.5 198.7 33.5 209.3 34.8 219.3 36.2 228.8 37.6 237.9 39.1 246.8 40.5 255.6 41.9 264.4 43.1 273.3 44.1 282.3 45 291.7 45.7 301.6 46 312 46 317.4 45.9 322.4 45.6 327 45.2 331.3 44.7 335.2 44.2 338.9 43.5 342.2 42.8 345.4 42.1 348.3 41.3 351 40.4 353.5 39.6 355.9 38.7 358.2 37.8 360.4 37 361.9 36.3 363.3 35.7 364.7 35 366 34.3 367.2 33.6 368.3 32.8 369.3 32.1 370.2 31.2 371 30.4 371.7 29.4 372.3 28.4 372.7 27.3 373 26.2 373 25 372.9 23.8 372.6 22.6 372.2 21.4 371.5 20.3 370.8 19.3 369.9 18.4 368.9 17.5 367.8 16.8 366.6 16.1 365.4 15.5 364.1 15.1 362.8 14.7 361.4 14.5 360 14.4 358.6 14.5 357.2 14.7 355.9 15.1 354.6 15.5 353.4 16.1 352.2 16.8 351.1 17.5 350.1 18.4 349.2 19.3 348.5 20.3 347.8 21.4 347.4 22.6 347.1 23.8 347 25 347 26.2 347.3 27.3 347.7 28.4 348.3 29.4 349 30.4 349.8 31.2 350.7 32.1 351.7 32.8 352.8 33.6 354 34.3 355.3 35 356.7 35.7 358.1 36.3 359.6 37 361.8 37.8 364.1 38.7 366.5 39.6 369 40.4 371.7 41.3 374.6 42.1 377.8 42.8 381.1 43.5 384.8 44.2 388.7 44.7 393 45.2 397.6 45.6 402.6 45.9 408 46 418.4 46 428.3 45.7 437.7 45 446.7 44.1 455.6 43.1 464.4 41.9 473.2 40.5 482.1 39.1 491.2 37.6 500.7 36.2 510.7 34.8 521.3 33.5 532.7 32.5 545 31.7 556.4 31.3 567.2 31.2 577.4 31.4 587.2 31.9 596.8 32.5 606.2 33.1 615.6 33.8 625 34.5 634.7 35.1 644.6 35.7 655 36.3 666 36.7 677.6 36.9 690 37 690 37 677.6 36.9 666 36.5 655 35.9 644.7 35.1 634.7 34.3 625.1 33.4 615.7 32.5 606.3 31.6 596.9 30.7 587.4 30 577.5 29.4 567.2 28.9 556.4 28.6 545 28.3 532.5 28.4 520.9 28.9 510.1 29.7 500 31 490.4 32.5 481.2 34.2 472.3 36 463.7 37.8 455 39.6 446.3 41.1 437.4 42.4 428.1 43.4 418.4 43.9 408 44 402.7 43.8 397.8 43.5 393.2 43.1 389 42.7 385.1 42.1 381.5 41.5 378.2 40.8 375.2 40 372.3 39.3 369.7 38.4 367.2 37.6 364.8 36.7 362.6 35.9 360.4 35 359 34.4 357.6 33.8 356.3 33.1 355.1 32.5 354 31.8 352.9 31.1 352 30.4 351.3 29.7 350.6 29 350 28.3 349.6 27.5 349.3 26.7 349.1 25.9 349 25 349.1 24.1 349.3 23.2 349.7 22.4 350.2 21.5 350.8 20.7 351.6 19.9 352.4 19.2 353.3 18.6 354.3 18 355.4 17.5 356.5 17.1 357.7 16.8 358.8 16.6 360 16.6 361.2 16.6 362.3 16.8 363.5 17.1 364.6 17.5 365.7 18 366.7 18.6 367.6 19.2 368.4 19.9 369.2 20.7 369.8 21.5 370.3 22.4 370.7 23.2 370.9 24.1 371 25 370.9 25.9 370.7 26.7 370.4 27.5 370 28.3 369.4 29 368.7 29.7 368 30.4 367.1 31.1 366 31.8 364.9 32.5 363.7 33.1 362.4 33.8 361 34.4 359.6 35 357.4 35.9 355.2 36.7 352.8 37.6 350.3 38.4 347.7 39.3 344.8 40 341.8 40.8 338.5 41.5 334.9 42.1 331 42.7 326.8 43.1 322.2 43.5 317.3 43.8 312 44 301.6 43.9 291.9 43.4 282.6 42.4 273.7 41.1 265 39.6 256.3 37.8 247.7 36 238.8 34.2 229.6 32.5 220 31 209.9 29.7 199.1 28.9 187.5 28.4 175 28.3 163.6 28.6 152.8 28.9 142.5 29.4 132.6 30 123.1 30.7 113.7 31.6 104.3 32.5 94.9 33.4 85.3 34.3 75.3 35.1 65 35.9 54 36.5 42.4 36.9 30 37ZM128 43 137.9 43.2 147.6 43.5 157 43.8 166.1 44.2 175.1 44.5 183.9 44.8 192.6 45 201.2 45.1 209.7 45.1 218.2 44.8 226.7 44.4 235.2 43.7 243.7 42.8 252.2 41.6 259.8 40.4 267 39.1 273.9 37.7 280.6 36.4 287 35.1 293.3 33.9 299.5 32.7 305.6 31.5 311.7 30.5 317.8 29.5 323.9 28.7 330.1 27.9 336.5 27.4 343 27 343 27 336.5 27.2 330.1 27.6 323.8 28 317.6 28.6 311.5 29.3 305.4 30.1 299.2 31 293 31.9 286.6 32.9 280.1 34 273.4 35 266.5 36.1 259.3 37.3 251.8 38.4 243.3 39.5 234.8 40.4 226.5 41.1 218.1 41.6 209.7 42 201.2 42.3 192.6 42.5 184 42.6 175.1 42.7 166.2 42.7 157 42.8 147.6 42.8 137.9 42.9 128 43ZM377 27 383.5 27.4 389.9 27.9 396.1 28.7 402.2 29.5 408.3 30.5 414.4 31.5 420.5 32.7 426.7 33.9 433 35.1 439.4 36.4 446.1 37.7 453 39.1 460.2 40.4 467.8 41.6 476.3 42.8 484.8 43.7 493.3 44.4 501.8 44.8 510.3 45.1 518.8 45.1 527.4 45 536.1 44.8 544.9 44.5 553.9 44.2 563 43.8 572.4 43.5 582.1 43.2 592 43 592 43 582.1 42.9 572.4 42.8 563 42.8 553.8 42.7 544.9 42.7 536 42.6 527.4 42.5 518.8 42.3 510.3 42 501.9 41.6 493.5 41.1 485.2 40.4 476.7 39.5 468.2 38.4 460.7 37.3 453.5 36.1 446.6 35 439.9 34 433.4 32.9 427 31.9 420.8 31 414.6 30.1 408.5 29.3 402.4 28.6 396.2 28 389.9 27.6 383.5 27.2 377 27ZM360 43.5a3 3 0 1 0 0 6a3 3 0 1 0 0-6Z"></path>
</svg>`,
  book: `<svg xmlns="http://www.w3.org/2000/svg" class="epub-hr-ornament" viewBox="0 0 720 72" role="separator" aria-label="Section break">
  <path fill="currentColor" d="M60 36.3 89.4 36.3 117.5 36.4 144.4 36.6 170 36.7 194.2 36.9 217.2 37.1 238.8 37.2 259 37.3 277.8 37.4 295.1 37.4 311.1 37.4 325.5 37.4 338.5 37.4 350 37.4 352 37.4 354.1 37.2 356.1 37 358.2 36.6 360.2 36.2 362.1 35.6 363.9 34.9 365.6 34.1 367.2 33.2 368.6 32.1 369.7 30.8 370.6 29.4 371.2 27.8 371.4 26 371.3 24.6 371.1 23.3 370.7 22 370.1 20.9 369.4 19.9 368.6 19 367.8 18.2 366.8 17.5 365.7 16.9 364.7 16.4 363.5 16.1 362.4 15.8 361.2 15.7 360 15.6 358.8 15.7 357.6 15.8 356.5 16.1 355.3 16.4 354.3 16.9 353.2 17.5 352.2 18.2 351.4 19 350.6 19.9 349.9 20.9 349.3 22 348.9 23.3 348.7 24.6 348.6 26 348.8 27.8 349.4 29.4 350.3 30.8 351.4 32.1 352.8 33.2 354.4 34.1 356.1 34.9 357.9 35.6 359.8 36.2 361.8 36.6 363.9 37 365.9 37.2 368 37.4 370 37.4 381.5 37.4 394.5 37.4 408.9 37.4 424.9 37.4 442.2 37.4 461 37.3 481.3 37.2 502.8 37.1 525.8 36.9 550 36.7 575.6 36.6 602.5 36.4 630.6 36.3 660 36.3 660 35.8 630.6 35.7 602.5 35.6 575.6 35.4 550 35.3 525.8 35.1 502.8 34.9 481.3 34.8 461 34.7 442.2 34.6 424.9 34.6 408.9 34.6 394.5 34.6 381.5 34.6 370 34.6 368.1 34.6 366.2 34.4 364.3 34.2 362.4 33.9 360.5 33.5 358.8 32.9 357.2 32.3 355.7 31.6 354.4 30.9 353.3 30 352.5 29.1 351.9 28.1 351.5 27.1 351.4 26 351.5 24.9 351.6 24 351.9 23.1 352.3 22.3 352.8 21.6 353.4 20.9 354 20.3 354.7 19.8 355.5 19.4 356.3 19 357.2 18.8 358.1 18.6 359.1 18.4 360 18.4 360.9 18.4 361.9 18.6 362.8 18.8 363.7 19 364.5 19.4 365.3 19.8 366 20.3 366.6 20.9 367.2 21.6 367.7 22.3 368.1 23.1 368.4 24 368.5 24.9 368.6 26 368.5 27.1 368.1 28.1 367.5 29.1 366.7 30 365.6 30.9 364.3 31.6 362.8 32.3 361.2 32.9 359.5 33.5 357.6 33.9 355.7 34.2 353.8 34.4 351.9 34.6 350 34.6 338.5 34.6 325.5 34.6 311.1 34.6 295.1 34.6 277.8 34.6 259 34.7 238.8 34.8 217.2 34.9 194.2 35.1 170 35.3 144.4 35.4 117.5 35.6 89.4 35.7 60 35.8Z"></path>
</svg>`,
};
