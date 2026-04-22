/**
 * Unit tests for the PDF exporter's config validation.
 *
 * Pure-module tests — no HTTP, no Playwright, no fixtures. Covers the
 * `configureExport()` surface that the HTTP tests don't exercise
 * directly. (Env-var parsing fires once at module import time and
 * isn't re-entrant, so it's not covered here — if it breaks, the
 * server fails to start at all and the integration tests catch it.)
 */
import { describe, expect, test } from 'bun:test';

import { configureExport } from '../src/export/pdf.js';

describe('configureExport validation', () => {
  test('accepts valid positive integers', () => {
    expect(() =>
      configureExport({
        concurrency: 4,
        timeoutMs: 45_000,
        mermaidWaitMs: 10_000,
        fontsWaitMs: 2_000,
      }),
    ).not.toThrow();
  });

  test('rejects zero', () => {
    expect(() => configureExport({ concurrency: 0 })).toThrow(
      /concurrency must be a positive integer/,
    );
  });

  test('rejects negative values', () => {
    expect(() => configureExport({ timeoutMs: -1 })).toThrow(
      /timeoutMs must be a positive integer/,
    );
  });

  test('rejects non-integer values', () => {
    expect(() => configureExport({ mermaidWaitMs: 1.5 })).toThrow(
      /mermaidWaitMs must be a positive integer/,
    );
  });

  test('rejects NaN', () => {
    expect(() => configureExport({ fontsWaitMs: Number.NaN })).toThrow(
      /fontsWaitMs must be a positive integer/,
    );
  });

  test('empty patch is a no-op', () => {
    expect(() => configureExport({})).not.toThrow();
  });

  // Restore the values the other test suites assume after running
  // ours. `configureExport()` is module-level state — leaving it in
  // a bad shape would flake downstream tests.
  test('restores sensible defaults for downstream suites', () => {
    configureExport({
      concurrency: 2,
      timeoutMs: 30_000,
      mermaidWaitMs: 15_000,
      fontsWaitMs: 3_000,
    });
  });
});
