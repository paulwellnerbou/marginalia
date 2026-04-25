/**
 * Integration test for the native `mmdr` mermaid renderer wrapper.
 *
 * The mmdr-dependent tests are skipped automatically when `mmdr` is
 * not on PATH — the binary is environment-provided (`cargo install
 * mermaid-rs-renderer`) and we don't want CI to fail if it isn't
 * there. The DOCX export's fallback path is covered by unit tests in
 * `packages/renderer/test/export-docx.test.ts` regardless.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

import {
  configureMermaidRenderer,
  getMermaidRendererConfig,
  MermaidRenderEngineMissingError,
  renderMermaidToPng,
} from '../src/export/mermaid-rust.js';

function which(bin: string): boolean {
  // Shell-free availability probe: try to execute the binary directly
  // and treat ENOENT as "not found on PATH". Anything else (e.g.
  // EACCES, or a non-zero exit because the binary doesn't recognise
  // `--version`) means the binary IS on PATH; we only care about
  // resolvability here, not exit status.
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return r.error == null || ('code' in r.error && r.error.code !== 'ENOENT');
}

const PNG_MAGIC = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function hasPngMagic(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) if (bytes[i] !== PNG_MAGIC[i]) return false;
  return true;
}

const MMDR_AVAILABLE = which('mmdr');

const SAMPLE_FLOWCHART = `flowchart LR
  A[Start] --> B{Decision}
  B -->|Yes| C[OK]
  B -->|No| D[Stop]`;

describe('renderMermaidToPng', () => {
  // Snapshot the module-level config at suite start so individual
  // tests can mutate it freely (`configureMermaidRenderer({ bin: ... })`)
  // without leaking into sibling test files. `getMermaidRendererConfig`
  // returns a Readonly view of the live object — capture the field
  // values, not the reference, since the module reassigns `config` on
  // every patch.
  const originalConfig = getMermaidRendererConfig();
  const restoreConfig = {
    bin: originalConfig.bin,
    timeoutMs: originalConfig.timeoutMs,
  };
  afterAll(() => {
    configureMermaidRenderer(restoreConfig);
  });

  test.if(MMDR_AVAILABLE)('produces a PNG via mmdr', async () => {
    configureMermaidRenderer({ bin: 'mmdr' });
    const result = await renderMermaidToPng(SAMPLE_FLOWCHART);
    expect(result).not.toBeNull();
    expect(result!.mime).toBe('image/png');
    expect(result!.bytes.length).toBeGreaterThan(1000);
    expect(hasPngMagic(result!.bytes)).toBe(true);
  });

  test('throws engine-missing error when binary is absent', async () => {
    configureMermaidRenderer({ bin: '/nonexistent/path/to/mmdr' });
    await expect(renderMermaidToPng(SAMPLE_FLOWCHART)).rejects.toBeInstanceOf(
      MermaidRenderEngineMissingError,
    );
  });

  test('config snapshot reflects defaults', () => {
    configureMermaidRenderer({ bin: 'mmdr', timeoutMs: 10_000 });
    const cfg = getMermaidRendererConfig();
    expect(cfg.bin).toBe('mmdr');
    expect(cfg.timeoutMs).toBe(10_000);
  });
});
