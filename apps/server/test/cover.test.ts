import { describe, expect, test } from 'bun:test';
import sharp from 'sharp';
import {
  COVER_THUMBNAIL_HEIGHT,
  COVER_THUMBNAIL_WIDTH,
  coverRefName,
  createCoverThumbnail,
  isCoverMime,
  sniffCoverMime,
} from '../src/cover.js';

/**
 * Both functions decide what a cover *is* from untrusted input — the
 * uploaded bytes, and a mime string read back out of the database. The
 * answer reaches the EPUB manifest and the asset proxy's Content-Type,
 * so "roughly right" isn't good enough.
 */

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF87 = new Uint8Array([...new TextEncoder().encode('GIF87a'), 0, 0]);
const GIF89 = new Uint8Array([...new TextEncoder().encode('GIF89a'), 0, 0]);
const WEBP = new Uint8Array([
  ...new TextEncoder().encode('RIFF'),
  0,
  0,
  0,
  0,
  ...new TextEncoder().encode('WEBP'),
]);

describe('sniffCoverMime', () => {
  test('identifies the four supported raster formats', () => {
    expect(sniffCoverMime(PNG)).toBe('image/png');
    expect(sniffCoverMime(JPEG)).toBe('image/jpeg');
    expect(sniffCoverMime(GIF87)).toBe('image/gif');
    expect(sniffCoverMime(GIF89)).toBe('image/gif');
    expect(sniffCoverMime(WEBP)).toBe('image/webp');
  });

  test('rejects SVG, other bytes, and truncated headers', () => {
    // SVG can carry script and readers vary in how they sandbox it, so
    // it must never sniff as a cover however plausible the bytes look.
    expect(sniffCoverMime(new TextEncoder().encode('<svg xmlns="..."></svg>'))).toBeNull();
    expect(sniffCoverMime(new TextEncoder().encode('# just markdown'))).toBeNull();
    expect(sniffCoverMime(new Uint8Array([0x89, 0x50]))).toBeNull();
    expect(sniffCoverMime(new Uint8Array())).toBeNull();
    // RIFF container that isn't WebP (e.g. a WAV) must not pass.
    expect(
      sniffCoverMime(
        new Uint8Array([
          ...new TextEncoder().encode('RIFF'),
          0,
          0,
          0,
          0,
          ...new TextEncoder().encode('WAVE'),
        ]),
      ),
    ).toBeNull();
  });
});

describe('isCoverMime', () => {
  test('accepts exactly the supported mimes', () => {
    expect(isCoverMime('image/png')).toBe(true);
    expect(isCoverMime('image/jpeg')).toBe(true);
    expect(isCoverMime('image/gif')).toBe(true);
    expect(isCoverMime('image/webp')).toBe(true);
    expect(isCoverMime('image/svg+xml')).toBe(false);
    expect(isCoverMime('application/octet-stream')).toBe(false);
    expect(isCoverMime('')).toBe(false);
  });

  test('does not accept inherited Object properties', () => {
    // A prototype-chain check (`mime in COVER_EXTENSIONS`) would pass
    // these and let a corrupt row reach the EPUB manifest as a media
    // type with no matching extension.
    expect(isCoverMime('toString')).toBe(false);
    expect(isCoverMime('constructor')).toBe(false);
    expect(isCoverMime('__proto__')).toBe(false);
    expect(isCoverMime('hasOwnProperty')).toBe(false);
  });
});

describe('coverRefName', () => {
  test('maps each format to the extension the asset proxy serves it by', () => {
    expect(coverRefName('image/png')).toBe('cover.png');
    expect(coverRefName('image/jpeg')).toBe('cover.jpg');
    expect(coverRefName('image/gif')).toBe('cover.gif');
    expect(coverRefName('image/webp')).toBe('cover.webp');
  });
});

describe('createCoverThumbnail', () => {
  test('creates a small, metadata-free WebP derivative', async () => {
    const source = await sharp({
      create: {
        width: 600,
        height: 900,
        channels: 3,
        background: { r: 32, g: 96, b: 160 },
      },
    })
      .png()
      .withMetadata({ orientation: 1 })
      .toBuffer();

    const thumbnail = await createCoverThumbnail(new Uint8Array(source));
    const metadata = await sharp(thumbnail).metadata();

    expect(thumbnail.byteLength).toBeLessThan(source.byteLength);
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(COVER_THUMBNAIL_WIDTH);
    expect(metadata.height).toBe(COVER_THUMBNAIL_HEIGHT);
    expect(metadata.exif).toBeUndefined();
  });

  test('upscales small covers to the fixed thumbnail dimensions', async () => {
    const source = await sharp({
      create: {
        width: 12,
        height: 18,
        channels: 3,
        background: { r: 160, g: 96, b: 32 },
      },
    })
      .png()
      .toBuffer();

    const metadata = await sharp(await createCoverThumbnail(new Uint8Array(source))).metadata();

    expect(metadata.width).toBe(COVER_THUMBNAIL_WIDTH);
    expect(metadata.height).toBe(COVER_THUMBNAIL_HEIGHT);
  });

  test('rejects a forged image header whose payload cannot be decoded', async () => {
    await expect(createCoverThumbnail(PNG)).rejects.toThrow();
  });
});
