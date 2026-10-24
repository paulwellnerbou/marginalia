import {
  type DocMetaKind,
  type DocMetaSpan,
  findAsciidocDocMetaRegions,
} from '@marginalia/renderer/doc-meta';
import type { EditorView } from 'codemirror';
import type { DocumentFormat } from './api.js';

/**
 * Finding and adding a document's summary / about region in the editor.
 * Line-based, so the editor needs no Markdown parser: close enough to the
 * renderer's reading for the cases an author writes, and the renderer stays
 * the judge of what folds.
 */

const MD_MARKER_RE = /^ {0,3}<!--\s*(\/?)\s*(summary|about)\s*-->\s*$/i;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

interface Line {
  text: string;
  start: number;
}

function linesOf(source: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  for (const text of source.split('\n')) {
    out.push({ text, start });
    start += text.length + 1;
  }
  return out;
}

function markdownRegions(source: string): DocMetaSpan[] {
  const lines = linesOf(source);
  const spans: DocMetaSpan[] = [];
  let fence: string | null = null;
  let open: { kind: DocMetaKind; line: number } | null = null;
  lines.forEach((line, i) => {
    const f = FENCE_RE.exec(line.text)?.[1];
    if (f && (!fence || f.startsWith(fence))) {
      fence = fence ? null : (f[0] as string).repeat(3);
      return;
    }
    if (fence) return;
    const m = MD_MARKER_RE.exec(line.text);
    if (!m) return;
    const kind = (m[2] as string).toLowerCase() as DocMetaKind;
    const close = m[1] === '/';
    if (!open) {
      if (!close) open = { kind, line: i };
      return;
    }
    if (close && kind === open.kind) {
      const next = lines[i + 1];
      spans.push({
        kind,
        start: lines[open.line]?.start ?? 0,
        end: next ? next.start : source.length,
        innerStart: lines[open.line + 1]?.start ?? source.length,
        innerEnd: line.start,
      });
      open = null;
    }
  });
  return spans;
}

export function findDocMetaRegion(
  source: string,
  format: DocumentFormat,
  kind: DocMetaKind,
): DocMetaSpan | null {
  const spans =
    format === 'asciidoc' ? findAsciidocDocMetaRegions(source) : markdownRegions(source);
  return spans.find((s) => s.kind === kind) ?? null;
}

export interface DocMetaInsert {
  /** Offset to insert `text` at. */
  at: number;
  text: string;
  /** Where the cursor goes, as an offset into the source after the insert. */
  cursor: number;
}

/**
 * Empty markers for `kind`, placed under the title: after a leading `# Title`
 * (or AsciiDoc's `= Title` header), past any frontmatter, with the summary
 * before the about when the other one is already there. The cursor lands on
 * the empty line between the markers.
 */
export function planDocMetaInsert(
  source: string,
  format: DocumentFormat,
  kind: DocMetaKind,
): DocMetaInsert {
  const other = findDocMetaRegion(source, format, kind === 'summary' ? 'about' : 'summary');
  const at = other
    ? kind === 'summary'
      ? other.start
      : other.end
    : format === 'asciidoc'
      ? afterAsciidocHeader(source)
      : afterMarkdownTitle(source);
  const [open, close] =
    format === 'asciidoc'
      ? [`[.${kind}]\n--\n`, '--\n']
      : [`<!-- ${kind} -->\n`, `<!-- /${kind} -->\n`];
  const before = source.slice(0, at);
  const after = source.slice(at);
  // A blank line on either side, so the region doesn't run into a paragraph.
  const lead = at === 0 ? '' : before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const trail = after === '' || after.startsWith('\n') ? '' : '\n';
  const text = `${lead}${open}\n${close}${trail}`;
  return { at, text, cursor: at + lead.length + open.length };
}

function afterMarkdownTitle(source: string): number {
  const lines = linesOf(source);
  let i = 0;
  if (lines[0]?.text === '---') {
    const end = lines.findIndex((l, j) => j > 0 && (l.text === '---' || l.text === '...'));
    if (end !== -1) i = end + 1;
  }
  while (i < lines.length && (lines[i]?.text.trim() ?? '') === '') i++;
  if (/^ {0,3}# /.test(lines[i]?.text ?? '')) return lines[i + 1]?.start ?? source.length;
  return lines[i]?.start ?? source.length;
}

/** Past the document header: the `= Title` line and the lines that run on from it. */
function afterAsciidocHeader(source: string): number {
  const lines = linesOf(source);
  let i = 0;
  while (i < lines.length && (lines[i]?.text.trim() ?? '') === '') i++;
  if (!/^= \S/.test(lines[i]?.text ?? '')) return lines[i]?.start ?? source.length;
  while (i < lines.length && (lines[i]?.text.trim() ?? '') !== '') i++;
  return lines[i]?.start ?? source.length;
}

/**
 * Put the cursor in the region, adding empty markers first when the
 * document has none. Never selects the existing text, so typing can't
 * replace a blurb by accident.
 */
export function showDocMetaInEditor(
  view: EditorView,
  format: DocumentFormat,
  kind: DocMetaKind,
): void {
  const source = view.state.doc.toString();
  const span = findDocMetaRegion(source, format, kind);
  if (!span) {
    const plan = planDocMetaInsert(source, format, kind);
    view.dispatch({
      changes: { from: plan.at, insert: plan.text },
      selection: { anchor: plan.cursor },
      scrollIntoView: true,
    });
  } else if (span.innerStart >= span.innerEnd) {
    // Markers with nothing between them: open a line to type on.
    view.dispatch({
      changes: { from: span.innerEnd, insert: '\n' },
      selection: { anchor: span.innerEnd },
      scrollIntoView: true,
    });
  } else {
    view.dispatch({ selection: { anchor: span.innerStart }, scrollIntoView: true });
  }
  view.focus();
}
