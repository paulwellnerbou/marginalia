import { SPAN_SEPARATOR } from '@marginalia/renderer/anchor-span';

function normalizeWs(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

// A multi-block quote joins one fragment per covered block. Whitespace
// normalization would run them together into one sentence, so mark the
// block boundaries before it does.
function markBlockBoundaries(s: string): string {
  return s.split(SPAN_SEPARATOR).join(' … ');
}

// Mermaid's runtime SVG can contain a large inlined stylesheet whose
// textContent starts with `#mermaid-<id>{...}`. If that leaks into an
// anchor quote, keep only the meaningful text before the stylesheet.
function stripMermaidRuntimeCss(s: string): string {
  const idx = s.indexOf('#mermaid-');
  if (idx < 0) return s;
  const tail = s.slice(idx, Math.min(s.length, idx + 200));
  if (!tail.includes('{') || !tail.includes('font-family')) return s;
  // idx === 0 means the whole textContent is the stylesheet — drop it
  // entirely rather than returning the leaked CSS as the quote.
  return s.slice(0, idx).trim();
}

export function formatAnchorQuote(raw: string | null | undefined, maxLen = 160): string {
  if (!raw) return '';
  const cleaned = stripMermaidRuntimeCss(normalizeWs(markBlockBoundaries(raw)));
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen)}...`;
}
