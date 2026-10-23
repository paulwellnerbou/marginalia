import type { Root } from 'mdast';
import { toString as mdastToString } from 'mdast-util-to-string';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { DOC_META_KINDS, type DocMetaKind, findMarkdownDocMetaRegions } from './doc-meta.js';
import type { DocumentFormat } from './render.js';

const ATTRIBUTE_LINE_RE = /^\[(.*)\]$/;
const BLOCK_TITLE_RE = /^\.[^.\s]/;

export interface ExtractedDocMeta {
  /** The source with every region, markers included, taken out. */
  source: string;
  /** Source text of the first region of each kind, trimmed. */
  summary: string | null;
  about: string | null;
}

/**
 * Split the summary and about regions off a source, for exports: the book
 * goes out without them, and the summary can become its blurb.
 */
export function extractDocMeta(source: string, format: DocumentFormat): ExtractedDocMeta {
  const cuts = format === 'asciidoc' ? asciidocRegions(source) : markdownRegions(source);
  const found: Record<DocMetaKind, string | null> = { summary: null, about: null };
  let stripped = '';
  let cursor = 0;
  for (const cut of cuts) {
    found[cut.kind] ??= source.slice(cut.innerStart, cut.innerEnd).trim() || null;
    stripped += source.slice(cursor, cut.start);
    cursor = cut.end;
  }
  stripped += source.slice(cursor);
  return { source: cuts.length > 0 ? stripped : source, ...found };
}

/**
 * A region's text without its Markdown, paragraphs kept apart, for places
 * that take plain text such as an EPUB's description. AsciiDoc passes
 * through: its inline markup is rarer in a blurb and has no cheap parse.
 */
export function docMetaPlainText(text: string, format: DocumentFormat): string {
  if (format === 'asciidoc') return text;
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text) as Root;
  return tree.children
    .map((node) => mdastToString(node).trim())
    .filter(Boolean)
    .join('\n\n');
}

interface Cut {
  kind: DocMetaKind;
  start: number;
  end: number;
  innerStart: number;
  innerEnd: number;
}

function markdownRegions(source: string): Cut[] {
  if (!source.includes('<!--')) return [];
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .parse(source) as Root;
  const cuts: Cut[] = [];
  for (const region of findMarkdownDocMetaRegions(tree.children)) {
    const open = tree.children[region.open]?.position;
    const close = tree.children[region.close]?.position;
    if (!open || !close) continue;
    cuts.push({
      kind: region.kind,
      start: open.start.offset ?? 0,
      end: lineEnd(source, close.end.offset ?? 0),
      innerStart: open.end.offset ?? 0,
      innerEnd: close.start.offset ?? 0,
    });
  }
  return cuts;
}

/** Past the line break that ends `offset`'s line, so a cut leaves no blank gap behind. */
function lineEnd(source: string, offset: number): number {
  if (source.startsWith('\r\n', offset)) return offset + 2;
  if (source[offset] === '\n') return offset + 1;
  return offset;
}

/**
 * Mirrors the renderer, which asks asciidoctor's `hasRole` of every open
 * block: a role counts wherever it sits — `[.summary]`, `[#blurb.summary.lead]`,
 * `[open.about%collapsible]`, `[role="lead summary"]` — not only alone.
 */
function asciidocRoles(attributeList: string): string[] {
  const roles: string[] = [];
  const entries = attributeList.split(',').map((e) => e.trim());
  const first = entries[0] ?? '';
  if (!first.includes('=')) {
    for (const m of first.matchAll(/\.([^.#%]+)/g)) roles.push(m[1] as string);
  }
  for (const entry of entries) {
    const named = /^role\s*=\s*(["']?)(.*)\1$/.exec(entry);
    if (named) roles.push(...(named[2] as string).split(/\s+/));
  }
  return roles.map((r) => r.toLowerCase());
}

/**
 * Open blocks (`--` … `--`) whose header carries a summary or about role.
 * The cut takes the whole header — attribute lines and a `.Title` — so
 * nothing of the region is left behind in an export.
 */
function asciidocRegions(source: string): Cut[] {
  const cuts: Cut[] = [];
  const lines = source.split('\n').map((l) => l.trimEnd());
  const starts: number[] = [];
  let offset = 0;
  for (const line of source.split('\n')) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const at = (i: number) => starts[i] ?? source.length;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== '--') continue;
    const close = lines.indexOf('--', i + 1);
    if (close === -1) break;
    let headerStart = i;
    const roles: string[] = [];
    while (headerStart > 0) {
      const above = lines[headerStart - 1] ?? '';
      const attrs = ATTRIBUTE_LINE_RE.exec(above);
      if (attrs) roles.push(...asciidocRoles(attrs[1] as string));
      else if (!BLOCK_TITLE_RE.test(above)) break;
      headerStart -= 1;
    }
    const kind = DOC_META_KINDS.find((k) => roles.includes(k));
    if (kind) {
      cuts.push({
        kind,
        start: at(headerStart),
        end: Math.min(at(close + 1), source.length),
        innerStart: at(i + 1),
        innerEnd: at(close),
      });
    }
    i = close;
  }
  return cuts;
}
