import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareImage } from '../src/tools/images.js';

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

describe('prepareImage', () => {
  test('accepts base64 and a data: URL alike, with subfolders in the name', async () => {
    const plain = await prepareImage({ name: 'img/a.png', data_base64: PIXEL }, false);
    const dataUrl = await prepareImage(
      { name: ' img/a.png ', data_base64: `data:image/png;base64,${PIXEL}` },
      false,
    );
    expect(plain).toMatchObject({ ok: true, name: 'img/a.png' });
    expect(dataUrl).toMatchObject({ ok: true, name: 'img/a.png' });
    if (plain.ok && dataUrl.ok) expect(dataUrl.bytes).toEqual(plain.bytes);
  });

  test('refuses names the server would not round-trip', async () => {
    for (const name of ['/a.png', '../a.png', 'a//b.png', 'a?.png', 'c:a.png', 'a\\b.png', '']) {
      expect(await prepareImage({ name, data_base64: PIXEL }, false)).toMatchObject({ ok: false });
    }
  });

  test('refuses names without an image extension, which would not be served as images', async () => {
    const result = await prepareImage({ name: 'notes.md', data_base64: PIXEL }, false);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.line).toContain('.png');
  });

  test('refuses data that is not base64, and an image with no data', async () => {
    expect(await prepareImage({ name: 'a.png', data_base64: 'not base64!' }, false)).toMatchObject({
      ok: false,
    });
    const missing = await prepareImage({ name: 'a.png' }, false);
    expect(missing).toMatchObject({ ok: false });
    if (!missing.ok) expect(missing.line).toContain('cannot read local files');
  });

  test('reads a path only where local files are allowed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-images-'));
    try {
      const path = join(dir, 'a.png');
      writeFileSync(path, Buffer.from(PIXEL, 'base64'));
      expect(await prepareImage({ name: 'a.png', path }, true)).toMatchObject({ ok: true });
      expect(await prepareImage({ name: 'a.png', path }, false)).toMatchObject({ ok: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('takes a plain percent-encoded data URL, the form an SVG drawn as markup takes', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
    for (const url of [
      `data:image/svg+xml,${encodeURIComponent(svg)}`,
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    ]) {
      const result = await prepareImage({ name: 'd.svg', data_base64: url }, false);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) expect(new TextDecoder().decode(result.bytes)).toBe(svg);
    }
  });
});
