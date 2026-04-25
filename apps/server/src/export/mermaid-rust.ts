/**
 * Rasterize mermaid diagrams to PNG via the native Rust `mmdr` CLI
 * (crate `mermaid-rs-renderer`).
 *
 * Why a Rust subprocess and not Playwright?
 *  - DOCX has no SVG support, so a mermaid block needs PNG bytes.
 *  - The PDF path runs Playwright + Chromium (~330 MB on disk, ~3 MB
 *    UMD inlined per request); good for full-page print fidelity but
 *    overkill for "render a single diagram to a PNG".
 *  - `mmdr` is a pure-Rust binary (~10–20 MB) that produces PNG from
 *    mermaid source in well under a second on representative diagrams.
 *
 * Visual output is "different but not wrong" against the upstream
 * mermaid.js renderer — acceptable for DOCX where the PDF path
 * remains the high-fidelity option.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------

interface Config {
  /** Executable path or name (resolved via PATH). */
  bin: string;
  /**
   * Per-invocation budget. `mmdr` is fast (typically <500 ms on
   * representative diagrams) but a pathological input shouldn't be
   * allowed to wedge an export.
   */
  timeoutMs: number;
}

let config: Config = readConfigFromEnv();

function readConfigFromEnv(): Config {
  const bin = process.env.MARGINALIA_MERMAID_BIN?.trim() || 'mmdr';
  const timeoutRaw = process.env.MARGINALIA_MERMAID_TIMEOUT_MS;
  const timeoutMs =
    timeoutRaw && Number.isInteger(Number(timeoutRaw)) && Number(timeoutRaw) >= 100
      ? Number(timeoutRaw)
      : 10_000;
  return { bin, timeoutMs };
}

/** Override config — for tests. */
export function configureMermaidRenderer(patch: Partial<Config>): void {
  config = { ...config, ...patch };
}

/** Read the active config (for diagnostics). */
export function getMermaidRendererConfig(): Readonly<Config> {
  return config;
}

// ---------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------

export class MermaidRenderEngineMissingError extends Error {
  readonly code = 'mermaid-engine-missing';
  constructor(bin: string, cause?: unknown) {
    super(
      `Mermaid renderer "${bin}" is not installed or not on PATH. ` +
        `Install via \`cargo install mermaid-rs-renderer\`, ` +
        `or set MARGINALIA_MERMAID_BIN to a fully-qualified path.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'MermaidRenderEngineMissingError';
  }
}

export class MermaidRenderError extends Error {
  readonly code = 'mermaid-render-error';
  readonly stderr: string;
  constructor(message: string, stderr: string) {
    super(message);
    this.name = 'MermaidRenderError';
    this.stderr = stderr;
  }
}

export class MermaidRenderTimeoutError extends Error {
  readonly code = 'mermaid-render-timeout';
  readonly elapsedMs: number;
  constructor(elapsedMs: number) {
    super(`Mermaid render timed out after ${elapsedMs} ms`);
    this.name = 'MermaidRenderTimeoutError';
    this.elapsedMs = elapsedMs;
  }
}

// ---------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------

export interface RenderedMermaidPng {
  /** PNG bytes; safe to feed straight to docx ImageRun. */
  bytes: Uint8Array;
  /** MIME type, fixed to `image/png` for now. */
  mime: 'image/png';
}

/**
 * Render a single mermaid source string to PNG bytes via `mmdr`.
 * Returns `null` on parse / render failure so the caller (DOCX
 * exporter) can fall back to its labeled-code-block stopgap instead
 * of failing the whole export.
 *
 * The engine-missing case still throws — that's an operator
 * configuration problem, not per-document data, and the route should
 * surface it as a 500 with the install hint.
 */
export async function renderMermaidToPng(source: string): Promise<RenderedMermaidPng | null> {
  // Each call gets its own temp dir so concurrent renders don't
  // race on the output filename. tmpdir + mkdtemp is the standard
  // pattern; we clean up in `finally`.
  const dir = await mkdtemp(join(tmpdir(), 'marginalia-mermaid-'));
  const outPath = join(dir, 'out.png');
  try {
    await runRenderer(source, outPath);
    const bytes = await readFile(outPath);
    return { bytes, mime: 'image/png' };
  } catch (err) {
    // Engine-missing and timeout are operational; let them propagate.
    if (err instanceof MermaidRenderEngineMissingError) throw err;
    if (err instanceof MermaidRenderTimeoutError) throw err;
    // Parse / render errors → null so the export degrades gracefully.
    console.warn('[mermaid-rust] render failed:', (err as Error).message);
    return null;
  } finally {
    // Best-effort cleanup. `recursive: true` so a partially-written
    // tempdir still goes away.
    rm(dir, { recursive: true, force: true }).catch(() => void 0);
  }
}

// ---------------------------------------------------------------------
// Subprocess plumbing
// ---------------------------------------------------------------------

/**
 * `mmdr -i - -o <path> -e png`
 *   `-i -` reads source from stdin, `-o <path>` is the output file,
 *   `-e png` selects the PNG encoder. PNG-to-stdout was tested and
 *   produced empty files; file output is the supported mode.
 */
function buildArgv(outPath: string): string[] {
  return ['-i', '-', '-o', outPath, '-e', 'png'];
}

function runRenderer(source: string, outPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const argv = buildArgv(outPath);
    const child = spawn(config.bin, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    // Drain stdout — mmdr doesn't write meaningful bytes there in
    // PNG mode, but leaving the buffer unread can deadlock on big
    // banner output.
    child.stdout.resume();

    const started = Date.now();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new MermaidRenderTimeoutError(Date.now() - started));
    }, config.timeoutMs);

    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      // ENOENT → binary missing. spawn surfaces it via the 'error'
      // event, not via exit code; map to the typed error so the
      // route can return a useful message.
      if (err.code === 'ENOENT') {
        reject(new MermaidRenderEngineMissingError(config.bin, err));
        return;
      }
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      if (signal === 'SIGKILL') return; // already rejected by the timer
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new MermaidRenderError(
          `Mermaid renderer exited with code ${code ?? '?'}`,
          stderr.trim(),
        ),
      );
    });

    child.stdin.end(source);
  });
}
