/**
 * Renders the Marginalia app icon into every raster size the web app ships.
 *
 * The artwork lives here rather than in a checked-in `.svg` so the three
 * variants (rounded tile, full-bleed, maskable) cannot drift apart — they
 * are the same geometry with different framing. Everything under
 * `apps/web/public` that this writes is generated; edit the constants
 * below and re-run `bun run icons`.
 *
 * The mark: an annotation bracket in the left margin hugging a passage —
 * the gesture the app is named for.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const OUT_DIR = fileURLToPath(new URL('../apps/web/public', import.meta.url));

const COLOR = {
  tileFrom: '#2F86E8',
  tileMid: '#1C3D70',
  tileTo: '#141A22',
  accent: '#3B9EFF',
  paper: '#FFFFFF',
} as const;

/** Corner radius of the rounded tile, as a fraction of the canvas. */
const TILE_RADIUS = 114 / 512;

/**
 * Android masks maskable icons down to as little as the centre 80%, so the
 * glyph is shrunk to keep the bracket clear of any mask shape.
 */
const MASKABLE_GLYPH_SCALE = 0.86;

type Variant = 'rounded' | 'square' | 'maskable';

/** The mark itself, on a 512 canvas, centred at (256, 256). */
function glyph(): string {
  return `
    <path d="M160 176h-44v160h44" fill="none" stroke="${COLOR.accent}" stroke-width="34"
          stroke-linecap="round" stroke-linejoin="round"/>
    <rect x="192" y="118" width="5" height="276" rx="2.5" fill="${COLOR.paper}" opacity="0.2"/>
    <g fill="${COLOR.paper}">
      <rect x="224" y="142" width="182" height="28" rx="14" opacity="0.38"/>
      <rect x="224" y="208" width="194" height="28" rx="14"/>
      <rect x="224" y="274" width="166" height="28" rx="14"/>
      <rect x="224" y="340" width="118" height="28" rx="14" opacity="0.38"/>
    </g>`;
}

function iconSvg(variant: Variant): string {
  const rx = variant === 'rounded' ? 512 * TILE_RADIUS : 0;
  const scale = variant === 'maskable' ? MASKABLE_GLYPH_SCALE : 1;
  // Scale about the centre so the glyph stays put as it shrinks.
  const offset = 256 * (1 - scale);
  const inner =
    scale === 1
      ? glyph()
      : `<g transform="translate(${offset} ${offset}) scale(${scale})">${glyph()}</g>`;

  // A hairline keeps the tile's edge crisp against a light page; on the
  // full-bleed variants the platform's own mask supplies that edge.
  const hairline =
    variant === 'rounded'
      ? `<rect x="0.5" y="0.5" width="511" height="511" rx="${rx - 0.5}" fill="none"
               stroke="${COLOR.paper}" stroke-opacity="0.08"/>`
      : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="${COLOR.tileFrom}"/>
      <stop offset="0.52" stop-color="${COLOR.tileMid}"/>
      <stop offset="1" stop-color="${COLOR.tileTo}"/>
    </linearGradient>
    <radialGradient id="sheen" cx="0.22" cy="0.14" r="0.85">
      <stop offset="0" stop-color="${COLOR.paper}" stop-opacity="0.2"/>
      <stop offset="1" stop-color="${COLOR.paper}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="512" height="512" rx="${rx}" fill="url(#tile)"/>
  <rect width="512" height="512" rx="${rx}" fill="url(#sheen)"/>
  ${hairline}
  ${inner}
</svg>`;
}

/**
 * ICO container around already-encoded PNGs. Browsers and Windows Vista+
 * both read PNG-compressed entries, which keeps this to a header and one
 * 16-byte directory entry per size instead of a BMP encoder.
 */
function buildIco(images: { size: number; png: Uint8Array }[]): Uint8Array {
  const HEADER = 6;
  const ENTRY = 16;
  const dirSize = HEADER + ENTRY * images.length;
  const total = dirSize + images.reduce((n, i) => n + i.png.length, 0);
  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);

  view.setUint16(0, 0, true); // reserved
  view.setUint16(2, 1, true); // type: icon
  view.setUint16(4, images.length, true);

  let offset = dirSize;
  images.forEach((image, i) => {
    const at = HEADER + ENTRY * i;
    buf[at] = image.size >= 256 ? 0 : image.size; // 0 encodes 256
    buf[at + 1] = image.size >= 256 ? 0 : image.size;
    buf[at + 2] = 0; // palette size — 0 for truecolor
    buf[at + 3] = 0; // reserved
    view.setUint16(at + 4, 1, true); // colour planes
    view.setUint16(at + 6, 32, true); // bits per pixel
    view.setUint32(at + 8, image.png.length, true);
    view.setUint32(at + 12, offset, true);
    buf.set(image.png, offset);
    offset += image.png.length;
  });

  return buf;
}

const browser = await chromium.launch();
const page = await browser.newPage();

async function renderPng(variant: Variant, size: number): Promise<Uint8Array> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${iconSvg(variant)}`,
  );
  return await page.screenshot({ omitBackground: true });
}

await mkdir(OUT_DIR, { recursive: true });

async function emit(name: string, data: Uint8Array | string) {
  const path = join(OUT_DIR, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
  console.log(`  ${name}`);
}

console.log('Generating icons →', OUT_DIR);

await emit('icon.svg', iconSvg('rounded'));

for (const size of [192, 512]) {
  await emit(`icon-${size}.png`, await renderPng('rounded', size));
  await emit(`icon-maskable-${size}.png`, await renderPng('maskable', size));
}

// iOS rounds the touch icon itself, so it gets the full-bleed square.
await emit('apple-touch-icon.png', await renderPng('square', 180));

// Sequential: renderPng drives one shared page, so these cannot overlap.
const icoImages: { size: number; png: Uint8Array }[] = [];
for (const size of [16, 32, 48]) {
  icoImages.push({ size, png: await renderPng('rounded', size) });
}
await emit('favicon.ico', buildIco(icoImages));

await browser.close();
console.log('Done.');
