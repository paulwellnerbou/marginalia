import type { Anchor, BlockInfo } from './types.js';

/**
 * Word, character, sentence and paragraph counts for a document and for
 * each of its sections, computed from the block map a render leaves
 * behind. No re-parse and no DOM: `BlockInfo.text` is already the text
 * the browser shows, minus the chrome the viewer injects.
 */

/** Counts for a run of prose. */
export interface TextCounts {
  words: number;
  /** Code points, spaces included; blocks count as separated by one space. */
  characters: number;
  charactersNoSpaces: number;
  sentences: number;
  paragraphs: number;
}

export interface SectionStats extends TextCounts {
  /** The heading element's id — what the TOC links to. */
  id: string;
  title: string;
  level: number;
  /** Subsections. Every count above includes them. */
  children: SectionStats[];
}

export interface DocumentStats {
  total: TextCounts;
  /** Headings the TOC lists. */
  headings: number;
  /** Code listings and diagram sources, which no count includes. */
  codeBlocks: number;
  /** Every heading that starts a section, nested as the TOC nests them. */
  sections: SectionStats[];
  /**
   * The rows a writer thinks of as chapters. A lone `# Book title` over
   * `## Chapter` headings is unwrapped so the chapters show directly —
   * the convention `splitMarkdownChapters` follows for chapter exports —
   * unless frontmatter already names the title, in which case the top
   * level headings are the chapters themselves.
   */
  chapters: SectionStats[];
  /** Text before the first chapter: the title heading, an introduction. Zeros when there is none. */
  preamble: TextCounts;
}

export interface StatsInput {
  blocks: ReadonlyArray<Pick<BlockInfo, 'kind' | 'text'> & { headingId?: string | undefined }>;
  anchors: ReadonlyArray<Anchor>;
  frontmatter?: Record<string, unknown> | undefined;
}

/** Sub-blocks repeat their parent's text. */
const SUB_BLOCK_KINDS = new Set(['listItem', 'tableCell']);

/** Kinds whose text is not prose — mdast node types and asciidoctor contexts alike. */
const NON_PROSE_KINDS = new Set([
  'code',
  'listing',
  'literal',
  'stem',
  'math',
  'yaml',
  'toml',
  'definition',
  'thematicBreak',
  'thematic_break',
  'page_break',
  'image',
  'video',
  'audio',
  'toc',
]);

const CODE_KINDS = new Set(['code', 'listing', 'literal']);

/** Prose that is never sentences: titles and cells. */
const SENTENCE_FREE_KINDS = new Set(['heading', 'table']);

/** Raw markup whose block text still carries its tags. */
const MARKUP_KINDS = new Set(['html', 'pass']);

const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu;
const WORD_CHAR_RE = /[\p{L}\p{N}]/u;
const SENTENCE_END_RE = /[.!?…]+[)\]"'”’»]*(?=\s|$)/u;
const TAG_OR_ENTITY_RE = /<[^>]*>|&#?\w+;/g;

/**
 * Whitespace-delimited tokens that contain a letter or a digit, the way
 * word processors count — so `well-known` and `3.14` are one word each
 * and a lone dash is none. Han and kana script has no word spaces, so
 * each of its characters counts as a word instead.
 */
export function countWords(text: string): number {
  let count = text.match(CJK_RE)?.length ?? 0;
  for (const token of text.replace(CJK_RE, ' ').split(/\s+/u)) {
    if (WORD_CHAR_RE.test(token)) count += 1;
  }
  return count;
}

/**
 * Runs of text ending in a terminator followed by whitespace, plus a
 * trailing run without one. Abbreviations split; that is the usual
 * trade for not shipping a language model.
 */
export function countSentences(text: string): number {
  let count = 0;
  for (const part of text.split(SENTENCE_END_RE)) {
    if (WORD_CHAR_RE.test(part)) count += 1;
  }
  return count;
}

export function computeDocumentStats(input: StatsInput): DocumentStats {
  const anchorById = new Map(input.anchors.map((anchor) => [anchor.id, anchor]));
  const total = zeroCounts();
  const sections: SectionStats[] = [];
  const stack: SectionStats[] = [];
  let codeBlocks = 0;

  for (const block of input.blocks) {
    if (SUB_BLOCK_KINDS.has(block.kind)) continue;

    if (block.kind === 'heading') {
      const anchor = block.headingId ? anchorById.get(block.headingId) : undefined;
      // A heading with no anchor (empty text, or one that reached no
      // element) opens no section; its words stay with the section above.
      if (anchor) {
        const section: SectionStats = {
          id: anchor.id,
          title: anchor.text,
          level: anchor.level,
          ...zeroCounts(),
          children: [],
        };
        while (stack.length > 0 && stack[stack.length - 1]!.level >= anchor.level) stack.pop();
        const parent = stack[stack.length - 1];
        (parent ? parent.children : sections).push(section);
        stack.push(section);
      }
    }

    if (CODE_KINDS.has(block.kind)) codeBlocks += 1;
    if (NON_PROSE_KINDS.has(block.kind)) continue;

    const counts = countsOf(block.kind, block.text);
    addCounts(total, counts);
    for (const section of stack) addCounts(section, counts);
  }

  const chapters = chapterRows(sections, input.frontmatter);
  const preamble = zeroCounts();
  addCounts(preamble, total);
  for (const chapter of chapters) subtractCounts(preamble, chapter);

  return { total, headings: input.anchors.length, codeBlocks, sections, chapters, preamble };
}

function chapterRows(
  sections: SectionStats[],
  frontmatter: Record<string, unknown> | undefined,
): SectionStats[] {
  const first = sections[0];
  const titled = frontmatter !== undefined && 'title' in frontmatter;
  if (sections.length === 1 && first && first.level === 1 && first.children.length > 0 && !titled) {
    return first.children;
  }
  return sections;
}

function countsOf(kind: string, rawText: string): TextCounts {
  const text = MARKUP_KINDS.has(kind) ? rawText.replace(TAG_OR_ENTITY_RE, ' ') : rawText;
  const characters = Array.from(text).length;
  return {
    words: countWords(text),
    characters,
    charactersNoSpaces: characters - (text.match(/\s/gu)?.length ?? 0),
    sentences: SENTENCE_FREE_KINDS.has(kind) ? 0 : countSentences(text),
    paragraphs: kind === 'paragraph' ? 1 : 0,
  };
}

function zeroCounts(): TextCounts {
  return { words: 0, characters: 0, charactersNoSpaces: 0, sentences: 0, paragraphs: 0 };
}

function addCounts(into: TextCounts, counts: TextCounts): void {
  // Blocks read as separated by one space, so a document's character
  // count is the same whether it was one paragraph or ten.
  if (into.characters > 0 && counts.characters > 0) into.characters += 1;
  into.words += counts.words;
  into.characters += counts.characters;
  into.charactersNoSpaces += counts.charactersNoSpaces;
  into.sentences += counts.sentences;
  into.paragraphs += counts.paragraphs;
}

function subtractCounts(from: TextCounts, counts: TextCounts): void {
  from.words -= counts.words;
  from.characters = Math.max(
    0,
    from.characters - counts.characters - (counts.characters > 0 ? 1 : 0),
  );
  from.charactersNoSpaces -= counts.charactersNoSpaces;
  from.sentences -= counts.sentences;
  from.paragraphs -= counts.paragraphs;
}
