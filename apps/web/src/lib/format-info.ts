import type { DocumentFormat } from './api.js';

/** How each source flavour is named, saved and served. */
export const FORMAT_INFO: Record<
  DocumentFormat,
  { label: string; short: string; ext: string; mime: string }
> = {
  markdown: { label: 'Markdown', short: 'md', ext: 'md', mime: 'text/markdown' },
  asciidoc: { label: 'AsciiDoc', short: 'adoc', ext: 'adoc', mime: 'text/asciidoc' },
  html: { label: 'HTML', short: 'html', ext: 'html', mime: 'text/html' },
};
