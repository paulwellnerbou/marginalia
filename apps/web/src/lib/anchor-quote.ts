function normalizeWs(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

// Mermaid's runtime SVG can contain a large inlined stylesheet whose
// textContent starts with `#mermaid-<id>{...}`. If that leaks into an
// anchor quote, keep only the meaningful text before the stylesheet.
function stripMermaidRuntimeCss(s: string): string {
  const idx = s.indexOf('#mermaid-');
  if (idx <= 0) return s;
  const tail = s.slice(idx, Math.min(s.length, idx + 200));
  if (!tail.includes('{') || !tail.includes('font-family')) return s;
  return s.slice(0, idx).trim();
}

export function formatAnchorQuote(raw: string | null | undefined, maxLen = 160): string {
  if (!raw) return '';
  const cleaned = stripMermaidRuntimeCss(normalizeWs(raw));
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen)}...`;
}
