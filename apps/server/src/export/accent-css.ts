import { accentCssVars, normalizeAccent } from '@marginalia/themes/accent';

/**
 * The reader's accent for an export: `none` for the theme's own, a hex
 * for a pick, nothing for the document's default.
 */
export function exportAccent(param: string | undefined, docDefault: string | null): string | null {
  if (param === 'none') return null;
  return normalizeAccent(param) ?? docDefault;
}

/** Exports print light, so only the light shades. Appended, so it wins over the theme. */
export function accentOverrideCss(accent: string | null): string {
  if (!accent) return '';
  const decls = Object.entries(accentCssVars(accent, 'light'))
    .map(([k, v]) => `${k}: ${v};`)
    .join(' ');
  return `\n.marginalia-theme, .marginalia { ${decls} }\n`;
}
