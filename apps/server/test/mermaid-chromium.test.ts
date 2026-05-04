/**
 * Integration test for the Chromium-based mermaid renderer.
 *
 * Auto-skipped when the headless-shell binary isn't installed
 * (operator hasn't run `bunx playwright install
 * chromium-headless-shell`). The DOCX/PDF cross-product matrix
 * lives in `server.test.ts` and stays browser-free.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';

import { closeExportBrowser } from '../src/export/pdf.js';
import {
  configureMermaidChromium,
  renderMermaidWithChromium,
} from '../src/export/mermaid-chromium.js';

/**
 * Probe Playwright's browser registry for any directory that looks
 * like a chromium-headless-shell install. Cheaper than launching the
 * browser just to find out it's missing — and matches what
 * `pdf.ts:getBrowser()` will do at runtime.
 *
 * Default cache locations differ per platform:
 *   - macOS:   ~/Library/Caches/ms-playwright
 *   - Linux:   ~/.cache/ms-playwright
 *   - Windows: %LOCALAPPDATA%/ms-playwright
 *
 * `PLAYWRIGHT_BROWSERS_PATH` overrides all three (and that's what
 * the production Dockerfile sets — see `apps/server/PDF_EXPORT.md`
 * + the `mermaid-builder` stage). We check it first, then fall
 * back to every per-OS default so the gating works consistently
 * across dev machines and CI.
 */
function chromiumAvailable(): boolean {
  const candidates: string[] = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    candidates.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  const home = process.env.HOME ?? '';
  if (home) {
    candidates.push(`${home}/Library/Caches/ms-playwright`); // macOS
    candidates.push(`${home}/.cache/ms-playwright`); // Linux / WSL
  }
  if (process.env.LOCALAPPDATA) {
    candidates.push(`${process.env.LOCALAPPDATA}/ms-playwright`); // Windows
  }
  for (const root of candidates) {
    if (!existsSync(root)) continue;
    try {
      const entries = require('node:fs').readdirSync(root) as string[];
      // Shell directories are named like `chromium_headless_shell-*`.
      // A loose match is enough — `getBrowser()` surfaces a typed
      // error if the install is incomplete.
      if (entries.some((e) => e.startsWith('chromium_headless_shell'))) {
        return true;
      }
    } catch {
      // unreadable directory → keep looking
    }
  }
  return false;
}

const CHROMIUM_AVAILABLE = chromiumAvailable();
const CHROMIUM_PROFILE_ENABLED = process.env.MARGINALIA_TEST_PROFILE === 'chromium';
const SHOULD_RUN_CHROMIUM_TESTS = CHROMIUM_PROFILE_ENABLED && CHROMIUM_AVAILABLE;

const SAMPLE = `flowchart LR
  A[Start] --> B{Decision}
  B -->|Yes| C[OK]
  B -->|No| D[Stop]`;

describe('renderMermaidWithChromium', () => {
  // Tighter budget than production so a regression doesn't hang the
  // suite — the typical render is ~500 ms.
  configureMermaidChromium({ timeoutMs: 30_000 });

  afterAll(async () => {
    // Tear down the shared browser singleton so `bun test` exits
    // cleanly. PDF-export-tests do the same dance.
    await closeExportBrowser();
  });

  test.if(SHOULD_RUN_CHROMIUM_TESTS)('produces an SVG with diagram content', async () => {
    const result = await renderMermaidWithChromium(SAMPLE, 'svg');
    expect(result).not.toBeNull();
    expect(result!.mime).toBe('image/svg+xml');
    expect(result!.format).toBe('svg');
    const text = new TextDecoder().decode(result!.bytes);
    expect(text).toContain('<svg');
    // Mermaid stamps node labels into the SVG; a degenerate render
    // without them should fail this assertion loudly.
    expect(text).toMatch(/Start|Decision|OK|Stop/);
  }, 60_000);

  test.if(SHOULD_RUN_CHROMIUM_TESTS)('produces a PNG screenshot', async () => {
    const result = await renderMermaidWithChromium(SAMPLE, 'png');
    expect(result).not.toBeNull();
    expect(result!.mime).toBe('image/png');
    expect(result!.format).toBe('png');
    // PNG magic bytes.
    expect(result!.bytes.length).toBeGreaterThan(1000);
    expect(result!.bytes[0]).toBe(0x89);
    expect(result!.bytes[1]).toBe(0x50);
    expect(result!.bytes[2]).toBe(0x4e);
    expect(result!.bytes[3]).toBe(0x47);
  }, 60_000);

  test.if(SHOULD_RUN_CHROMIUM_TESTS)('PNG resolution scales with pngScale; natural dims stay fixed', async () => {
    // Two renders of the same source at different scales: PNG actual
    // pixel count grows with `pngScale`, but `naturalWidth/Height`
    // (the CSS-px display size we hand back to docx) stays the same.
    // Without this, a hi-res raster would inflate the diagram on the
    // Word page — see `mermaid-chromium.ts` for the full rationale.
    function pngDims(b: Uint8Array): { w: number; h: number } {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }

    configureMermaidChromium({ pngScale: 2, timeoutMs: 30_000 });
    const at2x = await renderMermaidWithChromium(SAMPLE, 'png');
    expect(at2x).not.toBeNull();
    const dims2 = pngDims(at2x!.bytes);

    configureMermaidChromium({ pngScale: 4, timeoutMs: 30_000 });
    const at4x = await renderMermaidWithChromium(SAMPLE, 'png');
    expect(at4x).not.toBeNull();
    const dims4 = pngDims(at4x!.bytes);

    // 4× actual pixels at twice the device scale.
    expect(dims4.w).toBeCloseTo(dims2.w * 2, 0);
    expect(dims4.h).toBeCloseTo(dims2.h * 2, 0);
    // Same natural CSS-px display size at both scales.
    expect(at4x!.naturalWidth).toBeCloseTo(at2x!.naturalWidth ?? 0, 0);
    expect(at4x!.naturalHeight).toBeCloseTo(at2x!.naturalHeight ?? 0, 0);
    // And natural is materially smaller than the 4× actual pixels.
    expect(at4x!.naturalWidth).toBeLessThan(dims4.w);
  }, 90_000);

  test.if(SHOULD_RUN_CHROMIUM_TESTS)('returns null on parse failure (graceful degrade)', async () => {
    // Garbage source — mermaid.render() rejects, the bootstrap
    // sets `__marginaliaMermaidError`, and we return null so the
    // caller can fall back to the placeholder.
    const result = await renderMermaidWithChromium(
      'not a diagram, just words',
      'svg',
    );
    expect(result).toBeNull();
  }, 60_000);
});
