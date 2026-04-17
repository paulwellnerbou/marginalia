import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const BUILT_IN_THEMES = ['default-light', 'default-dark', 'serif-print'] as const;
export type BuiltInTheme = (typeof BUILT_IN_THEMES)[number];

export function isBuiltInTheme(name: string): name is BuiltInTheme {
  return (BUILT_IN_THEMES as readonly string[]).includes(name);
}

/**
 * Locate the @markdowner/themes package on disk and return a resolver for
 * its CSS files. Done lazily so the CLI starts up without any filesystem
 * work until a theme is actually requested.
 */
export function loadThemeCss(name: string): string {
  const themesDir = findThemesDir();
  const cssPath = join(themesDir, 'css', `${name}.css`);
  if (!existsSync(cssPath)) {
    throw new Error(
      `theme not found: "${name}". Available: ${BUILT_IN_THEMES.join(', ')}`,
    );
  }
  return readAndInlineImports(cssPath);
}

/**
 * Read a CSS file and inline any local `@import './foo.css'` references.
 * Themes like default-dark.css @import default-light.css — the CLI wants a
 * single embeddable CSS blob, not HTTP-style imports, so we resolve them
 * at build-CLI-output time.
 */
function readAndInlineImports(path: string): string {
  const seen = new Set<string>();
  return inline(path);

  function inline(p: string): string {
    if (seen.has(p)) return '';
    seen.add(p);
    const dir = dirname(p);
    const css = readFileSync(p, 'utf8');
    return css.replace(
      /@import\s+['"](\.\.?\/[^'"]+)['"]\s*;/g,
      (_match, rel: string) => inline(join(dir, rel)),
    );
  }
}

function findThemesDir(): string {
  // import.meta.resolve is sync in Bun for workspace packages.
  try {
    const indexUrl = import.meta.resolve('@markdowner/themes/default-light');
    // indexUrl points at css/default-light.css; walk up to the package root.
    const path = new URL(indexUrl).pathname;
    // e.g. /.../packages/themes/css/default-light.css → /.../packages/themes
    return dirname(dirname(path));
  } catch {
    // Fallback: look relative to this file inside the workspace.
    // Works when running from source with bun, not when installed globally.
    const here = new URL(import.meta.url).pathname;
    // packages/cli/src/themes.ts → packages/themes
    const fromSrc = join(here, '..', '..', '..', 'themes');
    if (existsSync(fromSrc)) return fromSrc;
    throw new Error('could not locate @markdowner/themes package');
  }
}
