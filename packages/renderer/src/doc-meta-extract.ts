import type { Root } from 'mdast';
import { toString as mdastToString } from 'mdast-util-to-string';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import {
  type DocMetaKind,
  type DocMetaSpan,
  findAsciidocDocMetaRegions,
  findMarkdownDocMetaRegions,
} from './doc-meta.js';
import type { DocumentFormat } from './render.js';

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
  const cuts = format === 'asciidoc' ? findAsciidocDocMetaRegions(source) : markdownRegions(source);
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

function markdownRegions(source: string): DocMetaSpan[] {
  if (!source.includes('<!--')) return [];
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .parse(source) as Root;
  const cuts: DocMetaSpan[] = [];
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
