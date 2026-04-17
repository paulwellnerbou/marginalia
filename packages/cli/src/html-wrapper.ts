import type { RenderResult } from '@marginalia/renderer';

export interface WrapOptions {
  /** Fully resolved CSS text to inline in <style> */
  css: string;
  /** Document title for <title>; defaults to frontmatter.title or 'Document' */
  title?: string;
  /** Optional HTML lang attribute */
  lang?: string;
}

export function wrapFullHtml(result: RenderResult, opts: WrapOptions): string {
  const title =
    opts.title ??
    (typeof result.frontmatter.title === 'string' ? result.frontmatter.title : 'Document');
  const lang = opts.lang ?? 'en';

  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${opts.css}
</style>
</head>
<body>
<article class="marginalia">
${result.html}</article>
</body>
</html>
`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
