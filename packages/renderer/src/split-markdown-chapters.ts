import type { Heading, Root, RootContent, YAML } from 'mdast';
import { toString as mdastToString } from 'mdast-util-to-string';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

export interface MarkdownChapter {
  /** One-based chapter number in document order. */
  index: number;
  /** Plain-text heading, or null when the source has no headings. */
  title: string | null;
  /** Verbatim source. Concatenating every chapter reproduces the input. */
  source: string;
}

/**
 * Split a Markdown book at its chapter-level headings.
 *
 * A conventional `# Book title` followed by `## Chapter` headings is
 * split on H2. If YAML frontmatter already supplies the book title,
 * top-level headings are treated as chapters. Documents without a
 * recognizable book-title heading split on their shallowest headings.
 * Preamble (frontmatter, book title, introduction) is kept at the start
 * of chapter one so an export never silently drops source text.
 */
export function splitMarkdownChapters(markdown: string): MarkdownChapter[] {
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml'])
    .parse(markdown) as Root;

  const headings = tree.children.filter(isPositionedHeading);
  if (headings.length === 0) return [{ index: 1, title: null, source: markdown }];

  const first = headings[0];
  if (!first) return [{ index: 1, title: null, source: markdown }];
  const hasFrontmatterTitle = tree.children.some(
    (node) => node.type === 'yaml' && /^title\s*:/im.test((node as YAML).value),
  );
  const deeperLevels = headings
    .slice(1)
    .map((heading) => heading.depth)
    .filter((depth) => depth > first.depth);
  const firstIsBookTitle = !hasFrontmatterTitle && first.depth === 1 && deeperLevels.length > 0;
  const chapterLevel = firstIsBookTitle
    ? Math.min(...deeperLevels)
    : Math.min(...headings.map((heading) => heading.depth));
  const starts = headings.filter((heading) => heading.depth === chapterLevel);

  if (starts.length === 0) return [{ index: 1, title: null, source: markdown }];

  return starts.map((heading, offset) => {
    const headingStart = heading.position?.start.offset ?? 0;
    const start = offset === 0 ? 0 : headingStart;
    const end = starts[offset + 1]?.position?.start.offset ?? markdown.length;
    return {
      index: offset + 1,
      title: mdastToString(heading).trim() || null,
      source: markdown.slice(start, end),
    };
  });
}

function isPositionedHeading(node: RootContent): node is Heading {
  return (
    node.type === 'heading' &&
    node.position?.start.offset !== undefined &&
    node.position?.end.offset !== undefined
  );
}
