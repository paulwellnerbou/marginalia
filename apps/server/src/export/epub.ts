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
      if (!ext) return 'src=""';
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(Buffer.from(payload, 'base64'));
      } catch {
        return 'src=""';
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
  // The UI calls `beautiful` "Book". Its web rule uses these same five
  // tapered polygons as a CSS mask; inline SVG is the portable EPUB form.
  if (theme !== 'beautiful') return html;
  return html.replace(/<hr(?:\s[^>]*)?\s*\/?>/gi, BOOK_HORIZONTAL_RULE);
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

function xhtmlize(html: string): string {
  return html
    .replace(/\s(disabled|checked|selected|multiple|readonly)(?=[\s>])/gi, ' $1="$1"')
    .replace(
      /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(\b[^>]*?)(?<!\/)\s*>/gi,
      '<$1$2 />',
    );
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

const BOOK_HORIZONTAL_RULE = `<svg xmlns="http://www.w3.org/2000/svg" class="epub-hr-ornament" viewBox="0 0 720 72" role="separator" aria-label="Section break">
  <g fill="currentColor">
    <polygon points="30,36 300,32.8 300,39.2"></polygon>
    <polygon points="690,36 420,32.8 420,39.2"></polygon>
    <polygon points="322,36 328,30 334,36 328,42"></polygon>
    <polygon points="398,36 392,30 386,36 392,42"></polygon>
    <polygon points="360,20 374,36 360,52 346,36"></polygon>
  </g>
</svg>`;
