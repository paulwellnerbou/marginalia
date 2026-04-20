import { Badge } from '@radix-ui/themes';
import type { DocumentFormat } from '../lib/api.js';

/**
 * Tiny badge that surfaces a document's source flavour — `MARKDOWN` or
 * `ASCIIDOC`. Shown on home-page cards (next to the role badge) and in
 * the document view's app bar so readers know which dialect authors are
 * writing in.
 */
export function FormatBadge({ format }: { format: DocumentFormat }) {
  const color = format === 'asciidoc' ? 'purple' : 'blue';
  const label = format === 'asciidoc' ? 'ASCIIDOC' : 'MARKDOWN';
  return (
    <Badge variant="soft" color={color} size="1" className="format-badge">
      {label}
    </Badge>
  );
}
