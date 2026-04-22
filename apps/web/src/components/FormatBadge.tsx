import { Badge } from '@mantine/core';
import type { DocumentFormat } from '../lib/api.js';
import { appFormatColor } from '../styles/theme.js';

/**
 * Tiny badge that surfaces a document's source flavour — `MARKDOWN` or
 * `ASCIIDOC`. Shown on home-page cards (next to the role badge) and in
 * the document view's app bar so readers know which dialect authors are
 * writing in.
 */
export function FormatBadge({ format }: { format: DocumentFormat }) {
  const label = format === 'asciidoc' ? 'ASCIIDOC' : 'MARKDOWN';
  return (
    <Badge variant="light" color={appFormatColor(format)} size="xs" className="format-badge">
      {label}
    </Badge>
  );
}
