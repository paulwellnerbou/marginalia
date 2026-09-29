/**
 * The document with `addition` after its last line, a blank line between
 * them: without one, Markdown reads text straight after a paragraph as
 * more of that paragraph, and AsciiDoc does the same.
 *
 * Leading blank lines of the addition go, since the separator already
 * provides one; leading spaces stay, as they can make an indented block.
 */
export function appendSource(source: string, addition: string): string {
  const text = addition.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  if (!text) return source;
  if (!source.trim()) return `${text}\n`;
  const separator = source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
  return `${source}${separator}${text}\n`;
}
