import type { Plugin } from 'unified';
import type { Root } from 'mdast';
import { visit } from 'unist-util-visit';

/**
 * Extract YAML frontmatter into file.data.frontmatter.
 *
 * Kept minimal on purpose: we don't want a full YAML dep yet. Supports
 * `key: value` scalars and nothing else. Upgrade when needed.
 */
export const remarkExtractFrontmatter: Plugin<[], Root> = () => {
  return (tree, file) => {
    visit(tree, 'yaml', (node) => {
      const raw = (node as { value: string }).value;
      (file.data as { frontmatter?: Record<string, unknown> }).frontmatter =
        parseSimpleYaml(raw);
    });
    if (!(file.data as { frontmatter?: unknown }).frontmatter) {
      (file.data as { frontmatter?: unknown }).frontmatter = {};
    }
  };
};

function parseSimpleYaml(src: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
