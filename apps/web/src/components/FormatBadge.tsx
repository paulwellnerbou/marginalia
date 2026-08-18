import { Badge } from '@radix-ui/themes';
import type { DocumentFormat } from '../lib/api.js';
import { appFormatColor } from '../styles/theme.js';

/**
 * Tiny badge that surfaces a document's source flavour. Shown on
 * home-page cards (next to the role badge) and on every app-bar document
 * tab, so readers know which dialect authors are writing in.
 *
 * Abbreviated because the tabs it sits in are narrow and the title is
 * what has to be readable there; the full name stays available to
 * screen readers and on hover.
 */
export function FormatBadge({ format }: { format: DocumentFormat }) {
  const asciidoc = format === 'asciidoc';
  const full = asciidoc ? 'AsciiDoc' : 'Markdown';
  return (
    <Badge
      variant="soft"
      color={appFormatColor(format)}
      size="1"
      className="format-badge"
      title={full}
    >
      <span aria-hidden="true">{asciidoc ? 'adoc' : 'md'}</span>
      <span className="sr-only">{full}</span>
    </Badge>
  );
}
