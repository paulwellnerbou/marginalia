/**
 * Theme CSS loader for the PDF exporter.
 *
 * Reads a named theme from `@marginalia/themes/css/<name>.css` and
 * recursively inlines any local `@import './…'` chains, so the result
 * is a single self-contained stylesheet that can be dropped into a
 * `<style>` tag on a page with no base URL (as is the case with
 * `page.setContent()`).
 *
 * Absolute `@import url('https://…')` statements (e.g. Google Fonts)
 * are left untouched — Chromium fetches those directly over the
 * network at export time.
 *
 * The print stylesheet (`@marginalia/themes/_print.css`) is NOT
 * resolved here — the caller concatenates it after the theme CSS so
 * its rules always win.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Pattern for `@import './file.css';` and `@import "./file.css";` —
 * the leading `./` or `../` is required; bare module specifiers and
 * absolute `url(...)` imports are left alone.
 *
 * Stored as a string (not a RegExp) because each `readAndResolve()`
 * call needs its OWN regex instance. The `g` flag makes `.exec()`
 * mutate the instance's `lastIndex`, so a single shared regex
 * corrupts under concurrent exports (two calls interleaving their
 * `.exec()` loops would read / reset each other's `lastIndex` and
 * miss imports). Constructing per call is the defensive fix.
 */
const RELATIVE_IMPORT_PATTERN = "@import\\s+(['\"])((?:\\.{1,2}/)[^'\"]+?)\\1\\s*;";

/** In-memory cache of resolved theme CSS keyed by theme name. Flipped
 * per-process: the themes package only changes on deploy. */
const cache = new Map<string, string>();

/**
 * Directory containing the theme CSS files. Resolved via
 * `import.meta.resolve` against the themes workspace so this works
 * from the source tree (dev) and from a bundled deployment (prod).
 *
 * The resolve target is the `_print.css` entry because it exists and
 * the package will always export it alongside the theme files — using
 * a theme name instead would require picking one that never gets
 * renamed.
 */
async function themesCssDir(): Promise<string> {
  const url = await import.meta.resolve('@marginalia/themes/_print.css');
  return dirname(fileURLToPath(url));
}

/** Valid theme id — also gates the filename so a malicious `?theme=`
 * value can't path-traverse out of the CSS directory. */
export function isValidThemeName(name: string): boolean {
  return /^[a-z][a-z0-9-]{0,40}$/.test(name);
}

/**
 * Read the given theme's CSS with local `@import` chains inlined.
 * Unknown or invalid names fall back to `default`.
 *
 * The returned string is ready to drop into `<style>...</style>` — no
 * further processing. Google Fonts `@import url(...)` lines are
 * preserved so Chromium can fetch them at export time; the exporter
 * waits on `document.fonts.ready` before printing.
 */
export async function loadThemeCss(themeName: string): Promise<string> {
  const name = isValidThemeName(themeName) ? themeName : 'default';
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  const dir = await themesCssDir();
  const entry = join(dir, `${name}.css`);
  const visited = new Set<string>();
  const resolved = await readAndResolve(entry, visited).catch(async (err) => {
    // Unknown theme file: fall back to default. Rare — `isValidThemeName`
    // covers syntactic typos — but the themes package can drop a theme
    // between deploys while a stale query param still lingers in a
    // bookmarked URL.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && name !== 'default') {
      return readAndResolve(join(dir, 'default.css'), visited);
    }
    throw err;
  });
  cache.set(name, resolved);
  return resolved;
}

/** Read the shared print stylesheet. Cached per-process. */
let printCssCache: string | null = null;
export async function loadPrintCss(): Promise<string> {
  if (printCssCache !== null) return printCssCache;
  const url = await import.meta.resolve('@marginalia/themes/_print.css');
  printCssCache = await readFile(fileURLToPath(url), 'utf8');
  return printCssCache;
}

/**
 * Clear the in-memory CSS cache. Only used by tests that want to
 * observe a theme file change without restarting the process.
 */
export function __resetThemeCssCache(): void {
  cache.clear();
  printCssCache = null;
}

async function readAndResolve(filePath: string, visited: Set<string>): Promise<string> {
  const canonical = resolve(filePath);
  if (visited.has(canonical)) return ''; // cycle guard — emit nothing
  visited.add(canonical);

  const source = await readFile(canonical, 'utf8');
  const baseDir = dirname(canonical);

  // Replace each relative @import with the inlined file content. We
  // collect the async work up-front, then splice the results in, so
  // the regex's lastIndex isn't invalidated by concurrent replacements.
  //
  // Fresh `RegExp` per call so two concurrent `loadThemeCss()` calls
  // can't interleave and corrupt each other's `lastIndex`. See the
  // comment on RELATIVE_IMPORT_PATTERN for the reasoning.
  const imports: Array<{ match: string; start: number; end: number; text: Promise<string> }> = [];
  const re = new RegExp(RELATIVE_IMPORT_PATTERN, 'g');
  for (;;) {
    const m = re.exec(source);
    if (!m) break;
    const importPath = m[2]!;
    const target = resolve(baseDir, importPath);
    imports.push({
      match: m[0],
      start: m.index,
      end: m.index + m[0].length,
      text: readAndResolve(target, visited),
    });
  }

  if (imports.length === 0) return source;

  const resolvedTexts = await Promise.all(imports.map((i) => i.text));
  let out = '';
  let cursor = 0;
  for (let i = 0; i < imports.length; i++) {
    const imp = imports[i]!;
    out += source.slice(cursor, imp.start);
    out += `\n/* inlined from: ${imp.match.trim()} */\n`;
    out += resolvedTexts[i]!;
    out += '\n/* end inline */\n';
    cursor = imp.end;
  }
  out += source.slice(cursor);
  return out;
}
