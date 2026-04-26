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

/**
 * Catch-all for spawn-time setup failures that mean "the configured
 * renderer can't be invoked": ENOENT (binary missing), EACCES (found
 * but not executable), ENOTDIR / EISDIR (bad path), EPERM (e.g.
 * sandbox / no-exec mount). All of these are operator configuration
 * problems, not per-document data, so the route maps them to a
 * once-per-export warning + code-block fallback rather than failing
 * silently.
 *
 * Kept as a single class (rather than a hierarchy per code) because
 * the route's `instanceof` check + the ergonomic upgrade story
 * doesn't benefit from a finer split — operators get the underlying
 * `errno` code in the message and on `cause`.
 */
export class MermaidRenderEngineMissingError extends Error {
  readonly code = 'mermaid-engine-missing';
  /** Underlying spawn errno (ENOENT, EACCES, …) when known. */
  readonly errno: string | undefined;
  constructor(bin: string, cause?: NodeJS.ErrnoException) {
    const errno = cause?.code;
    const reason = describeSpawnFailure(errno);
    super(
      `Mermaid renderer "${bin}" ${reason}. ` +
        `Install via \`cargo install mermaid-rs-renderer\`, ` +
        `or set MARGINALIA_MERMAID_BIN to a fully-qualified path.`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'MermaidRenderEngineMissingError';
    this.errno = errno;
  }
}

/**
 * Spawn-time errno codes the wrapper treats as
 * `MermaidRenderEngineMissingError`. Anything outside this set
 * propagates as a raw error (genuinely unexpected — e.g. EMFILE
 * "too many open files" is a host problem, not an engine problem).
 */
const ENGINE_MISSING_ERRNOS = new Set([
  'ENOENT', // binary not found
  'EACCES', // found but not executable
  'EPERM', // operation not permitted (sandbox / SELinux / noexec mount)
  'ENOTDIR', // a path component isn't a directory
  'EISDIR', // configured bin is a directory
]);

function describeSpawnFailure(errno: string | undefined): string {
  switch (errno) {
    case 'ENOENT':
      return 'is not installed or not on PATH';
    case 'EACCES':
      return 'is not executable (check file permissions)';
    case 'EPERM':
      return 'cannot be executed (operation not permitted — sandbox or noexec mount?)';
    case 'ENOTDIR':
      return 'has an invalid path (a directory component does not exist)';
    case 'EISDIR':
      return 'points to a directory, not a binary';
    default:
      return 'cannot be invoked';
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
 * configuration problem, not per-document data. Callers may either
 * surface it (for a strict export path, e.g. as a 500 with the
 * install hint) or catch it and fall back (as the DOCX path does).
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
    // No log here on purpose: callers (DOCX) want silent fallback per
    // diagram. If a structured diagnostic surface is needed later,
    // return the error instead of swallowing it.
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
      // Spawn-time setup failures (ENOENT, EACCES, EPERM, ENOTDIR,
      // EISDIR) all surface here rather than via exit code. Map them
      // to the typed error so the DOCX route's once-per-export
      // operator warning fires for every "engine unusable" cause —
      // not just "binary missing". Anything outside the set (EMFILE,
      // EAGAIN, …) is a host-level problem and propagates raw.
      if (err.code && ENGINE_MISSING_ERRNOS.has(err.code)) {
        reject(new MermaidRenderEngineMissingError(config.bin, err));
        return;
      }
      reject(err);
    });

    // 'close' fires AFTER the child exits AND its stdio streams have
    // drained — using 'exit' here would risk a truncated `stderr`
    // (the buffer is filled on 'data' callbacks that haven't all
    // flushed by the time 'exit' fires), which makes
    // MermaidRenderError.stderr unreliable for diagnostics.
    child.on('close', (code, signal) => {
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

    // If the renderer dies before we finish writing the source (early
    // crash, ENOENT, kill from the timeout above), the next stdin
    // write surfaces as an unhandled 'error' event on the pipe and
    // takes down the Node process. Swallow the broken-pipe variants
    // and let the existing 'error' / 'close' handlers above produce
    // the intended rejection. Anything else is a genuine
    // unexpected stream error and gets propagated.
    child.stdin.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') return;
      reject(err);
    });

    child.stdin.end(source);
  });
}
