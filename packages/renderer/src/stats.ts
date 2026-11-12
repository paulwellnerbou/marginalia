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
  /**
   * Set on a run of text a separator (`---`, `'''`) bounds rather than a
   * heading — only with `splitAtBreaks`. `title` is then its opening
   * words, and its counts leave out the heading above it.
   */
  break?: BreakRun | undefined;
}

export interface BreakRun {
  /** 1-based position among the runs of its section. */
  index: number;
  /** The heading the runs divide; null before the first heading. */
  sectionId: string | null;
  /**
   * The separator that opens the run: its 1-based position among the
   * document's separators, summary and about included, which is what a
   * `#separator-N` fragment names. Null for the first run, which the
   * section's heading (or the document start) opens.
   */
  separator: number | null;
}

export interface DocumentStats {
  total: TextCounts;
  /** Headings the TOC lists. */
  headings: number;
  /** Code listings and diagram sources, which no count includes. */
  codeBlocks: number;
  /** Thematic breaks, which `splitAtBreaks` turns into section boundaries. */
  separators: number;
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
  blocks: ReadonlyArray<
    Pick<BlockInfo, 'kind' | 'text'> & {
      headingId?: string | undefined;
      docMeta?: BlockInfo['docMeta'] | undefined;
    }
  >;
  anchors: ReadonlyArray<Anchor>;
  frontmatter?: Record<string, unknown> | undefined;
}

export interface StatsOptions {
  /**
   * Treat each thematic break as a section boundary: a section — or the
   * document, before its first heading — that a separator divides gets
   * one child row per run of text, in place of the scene breaks a novel
   * marks with `* * *`.
   */
  splitAtBreaks?: boolean | undefined;
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

const BREAK_KINDS = new Set(['thematicBreak', 'thematic_break']);

const EXCERPT_WORDS = 8;

/** Prose that is never sentences: titles and cells. */
const SENTENCE_FREE_KINDS = new Set(['heading', 'table', 'cell']);

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

export function computeDocumentStats(input: StatsInput, options: StatsOptions = {}): DocumentStats {
  const anchorById = new Map(input.anchors.map((anchor) => [anchor.id, anchor]));
  const total = zeroCounts();
  let sections: SectionStats[] = [];
  const stack: SectionStats[] = [];
  let codeBlocks = 0;
  let separators = 0;
  let separatorOrdinal = 0;

  // The section whose own text is being read — the latest heading, since
  // a section's text before its first subheading is all it has of its own.
  const runGroups: RunGroup[] = [];
  let group: RunGroup = newRunGroup(null);

  for (const block of input.blocks) {
    // Before the doc-meta skip: the page numbers every separator.
    if (BREAK_KINDS.has(block.kind)) separatorOrdinal += 1;
    if (SUB_BLOCK_KINDS.has(block.kind)) continue;
    // A blurb and notes about the book, not part of it.
    if (block.docMeta) continue;

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
        group = newRunGroup(section);
      }
    }

    if (BREAK_KINDS.has(block.kind)) {
      separators += 1;
      if (options.splitAtBreaks) {
        const container = group.owner ? group.owner.children : sections;
        if (group.runs.length === 0) {
          runGroups.push(group);
          const first = newRun(group, null);
          addCounts(first, group.own);
          first.title = group.ownExcerpt;
          group.runs.push(first);
          container.push(first);
        }
        const run = newRun(group, separatorOrdinal);
        group.runs.push(run);
        container.push(run);
        group.current = run;
      }
    }

    if (CODE_KINDS.has(block.kind)) codeBlocks += 1;
    if (NON_PROSE_KINDS.has(block.kind)) continue;

    const counts = countsOf(block.kind, block.text);
    addCounts(total, counts);
    for (const section of stack) addCounts(section, counts);
    // A run is the body between separators, so the heading stays out.
    if (block.kind !== 'heading' && counts.characters > 0) {
      const into = group.current;
      if (into) {
        addCounts(into, counts);
        if (!into.title) into.title = excerpt(block.text, block.kind);
      } else {
        addCounts(group.own, counts);
        if (!group.ownExcerpt) group.ownExcerpt = excerpt(block.text, block.kind);
      }
    }
  }

  for (const done of runGroups) {
    const keep = settleRuns(done);
    if (done.owner) done.owner.children = done.owner.children.filter(keep);
    else sections = sections.filter(keep);
  }

  const rootRuns = sections.filter((s) => s.break);
  const headed = rootRuns.length > 0 ? sections.filter((s) => !s.break) : sections;
  // Root runs precede the first heading, so they lead the rows.
  const chapters = [...rootRuns, ...chapterRows(headed, input.frontmatter)];
  const preamble = zeroCounts();
  addCounts(preamble, total);
  for (const chapter of chapters) subtractCounts(preamble, chapter);

  return {
    total,
    headings: input.anchors.length,
    codeBlocks,
    separators,
    sections,
    chapters,
    preamble,
  };
}

interface RunGroup {
  /** Null for the text before the first heading. */
  owner: SectionStats | null;
  /** The owner's text before its first separator. */
  own: TextCounts;
  ownExcerpt: string;
  runs: SectionStats[];
  current: SectionStats | null;
}

function newRunGroup(owner: SectionStats | null): RunGroup {
  return { owner, own: zeroCounts(), ownExcerpt: '', runs: [], current: null };
}

function newRun(group: RunGroup, separator: BreakRun['separator']): SectionStats {
  return {
    id: '',
    title: '',
    level: (group.owner?.level ?? 0) + 1,
    ...zeroCounts(),
    children: [],
    break: { index: 0, sectionId: group.owner?.id ?? null, separator },
  };
}

/**
 * Drops the empty runs a leading or trailing separator leaves, numbers
 * the rest, and drops them all when fewer than two remain — one run is
 * just the section again.
 */
function settleRuns(group: RunGroup): (section: SectionStats) => boolean {
  const kept = group.runs.filter((run) => run.characters > 0);
  const drop = new Set(
    kept.length >= 2 ? group.runs.filter((r) => r.characters === 0) : group.runs,
  );
  kept.forEach((run, i) => {
    run.break!.index = i + 1;
    // `#` never occurs in a heading slug, so this cannot collide with one.
    run.id = `${group.owner?.id ?? ''}#break-${i + 1}`;
  });
  return (section) => !drop.has(section);
}

function excerpt(rawText: string, kind: string): string {
  const text = MARKUP_KINDS.has(kind) ? rawText.replace(TAG_OR_ENTITY_RE, ' ') : rawText;
  const words = text.trim().split(/\s+/u);
  const head = words.slice(0, EXCERPT_WORDS).join(' ');
  return words.length > EXCERPT_WORDS ? `${head}…` : head;
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
