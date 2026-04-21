/**
 * Heuristic document-title extraction. Used by download handlers to
 * produce a human-readable filename when the document has no explicit
 * `name` set. Deliberately cheap (no full render) so it's safe to run
 * on every download request — or client-side in the UI.
 *
 * Priority:
 *   1. YAML frontmatter `title:` (markdown) or `= Title` header
 *      (asciidoc). Matches what the renderer itself treats as the
 *      document title.
 *   2. First top-level heading in the body (`#` / `==`).
 *
 * Returns `null` if neither signal is present. Callers decide what to
 * fall back to (the doc uid, typically).
 */
import type { DocumentFormat } from './render.js';

export function extractDocumentTitle(source: string, format: DocumentFormat): string | null {
  return format === 'asciidoc' ? extractAsciidocTitle(source) : extractMarkdownTitle(source);
}

/**
 * Turn a derived (or explicit) document title into a filename-safe
 * base name. Shared between the server (DOCX download) and the client
 * (source download) so the two paths produce identical filenames for
 * the same document — no client/server drift.
 *
 * Behavior:
 *  - Characters outside `[\w.-]` collapse to `_`.
 *  - The result is trimmed to 80 characters, then stripped of leading
 *    and trailing separator characters (so all-emoji titles don't
 *    leave a lone `_`, and dot-only prefixes don't create a hidden
 *    file on Unix).
 *  - If the sanitised result is empty, returns `fallback` (typically
 *    the document uid).
 *
 * The extension is the caller's responsibility: this helper returns
 * the base only.
 */
export function sanitizeDocumentFilename(
  title: string | null | undefined,
  fallback: string,
): string {
  const source = (title ?? '').trim() || fallback;
  const sanitized = source.replace(/[^\w.-]+/g, '_').slice(0, 80);
  const trimmed = sanitized.replace(/^[._-]+|[._-]+$/g, '');
  return trimmed || fallback;
}

function extractMarkdownTitle(source: string): string | null {
  // 1. `title:` in YAML frontmatter, if present.
  const fm = readYamlFrontmatterTitle(source);
  if (fm) return fm;

  // 2. First ATX `# ` heading in the body — but we have to track
  // fenced code-block state by hand, otherwise a `# foo` inside a
  // ```…``` block would be mistaken for the document title. A naive
  // multiline regex would pick up comments in code samples, which
  // happens in practice on README-style documents.
  //
  // CommonMark: a fence is three-or-more backticks OR tildes (the
  // two kinds don't mix: a ``` fence closes only on ``` of equal or
  // greater length, never on ~~~ and vice versa). ATX headings
  // themselves can be indented up to 3 spaces; 4+ spaces is an
  // indented code block, so we cap the indent match at 3.
  //
  // Setext-style (`===` underline) headings are also a thing but GFM
  // deprecates them and they're rare in practice — not worth the
  // extra parser state.
  const lines = stripFrontmatter(source).split(/\r?\n/);
  let fenceChar: '`' | '~' | null = null;
  let fenceLen = 0;
  const headingRe = /^ {0,3}#\s+(.+?)\s*#*\s*$/;
  const openFenceRe = /^ {0,3}(`{3,}|~{3,})/;
  const closeFenceRe = /^ {0,3}(`{3,}|~{3,})\s*$/;

  for (const line of lines) {
    if (fenceChar) {
      const close = line.match(closeFenceRe);
      if (close && close[1]![0] === fenceChar && close[1]!.length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue;
    }
    const open = line.match(openFenceRe);
    if (open) {
      fenceChar = open[1]![0] as '`' | '~';
      fenceLen = open[1]!.length;
      continue;
    }
    const h = line.match(headingRe);
    if (h && h[1]) return sanitize(h[1]);
  }
  return null;
}

function extractAsciidocTitle(source: string): string | null {
  // 1. YAML frontmatter — some authors still prefix asciidoc with
  //    `---\ntitle: …\n---`. The AsciiDoc renderer reads it, so we
  //    should too.
  const fm = readYamlFrontmatterTitle(source);
  if (fm) return fm;

  // 2. AsciiDoc document title: `= Title` as the first non-comment,
  //    non-blank line. Ignore AsciiDoc attribute lines (`:key: value`).
  const body = stripFrontmatter(source);
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('//')) continue;
    if (trimmed.startsWith(':') && /^:[A-Za-z][\w-]*:/.test(trimmed)) continue;
    const m = trimmed.match(/^=\s+(.+?)\s*$/);
    return m && m[1] ? sanitize(m[1]) : null;
  }
  return null;
}

function stripFrontmatter(source: string): string {
  if (!source.startsWith('---')) return source;
  const m = source.match(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/);
  return m ? source.slice(m[0].length) : source;
}

function readYamlFrontmatterTitle(source: string): string | null {
  if (!source.startsWith('---')) return null;
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (!m) return null;
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = line.match(/^title\s*:\s*(.*)$/);
    if (!kv) continue;
    let value = (kv[1] ?? '').trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value ? sanitize(value) : null;
  }
  return null;
}

/**
 * Strip inline markdown/asciidoc formatting from a heading so the
 * extracted title reads cleanly — e.g. `# **Hello** world` becomes
 * `Hello world`, not `**Hello** world`. We keep this *lightweight*:
 * the goal is a filename-ready string, not a full AST round-trip.
 */
function sanitize(raw: string): string {
  let s = raw;
  // Strip link syntax `[text](url)` / `[[text|url]]` / `link:url[text]`,
  // keeping the visible text.
  s = s.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  s = s.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1');
  s = s.replace(/\b(?:https?|link|mailto):\S*?\[([^\]]*)\]/g, '$1');
  // Strip emphasis / strong / inline code markers.
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2');
  s = s.replace(/(\*|_)(.+?)\1/g, '$2');
  s = s.replace(/`([^`]+)`/g, '$1');
  // Strip HTML tags (rare in a title line but harmless to normalize).
  s = s.replace(/<[^>]+>/g, '');
  return s.trim();
}
