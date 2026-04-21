/**
 * Theme management for the web app.
 *
 * Built-in themes ship as CSS files in `@marginalia/themes`. At any time
 * exactly one theme stylesheet is active (swapped by appending a new
 * `<link>` and removing the previous marker). User selection persists in
 * localStorage per-document UID; if the user hasn't chosen anything, the
 * document's default theme is used.
 */

export interface ThemeMeta {
  id: string;
  label: string;
  blurb: string;
}

export const BUILT_IN_THEMES: ThemeMeta[] = [
  { id: 'default', label: 'Default', blurb: 'Neutral sans-serif. Follows app light/dark mode.' },
  {
    id: 'handbook',
    label: 'Handbook',
    blurb: 'Structured sans-serif reading theme for documentation and training material.',
  },
  {
    id: 'asciidoc-article',
    label: 'AsciiDoc Article',
    blurb: 'Classic Asciidoctor article styling with academy-style task and TOC tweaks.',
  },
  { id: 'beautiful', label: 'Book', blurb: 'Editorial serif with drop cap and ornament.' },
  { id: 'book', label: 'Document', blurb: 'Classic serif, narrow column, long-form reading.' },
  { id: 'article', label: 'Article', blurb: 'Magazine-style essay with bold headings.' },
  { id: 'technical', label: 'Technical', blurb: 'Wider column, tight spacing, good for code.' },
  { id: 'serif-print', label: 'Serif (Print)', blurb: 'Print-optimized serif, narrow column.' },
];

// Eagerly-declared imports so Vite bundles all themes and we can switch
// between them at runtime without issuing a fresh network request.
const themeImports: Record<string, () => Promise<unknown>> = {
  default: () => import('@marginalia/themes/default.css?url'),
  handbook: () => import('@marginalia/themes/handbook.css?url'),
  'asciidoc-article': () => import('@marginalia/themes/asciidoc-article.css?url'),
  book: () => import('@marginalia/themes/book.css?url'),
  article: () => import('@marginalia/themes/article.css?url'),
  technical: () => import('@marginalia/themes/technical.css?url'),
  beautiful: () => import('@marginalia/themes/beautiful.css?url'),
  'serif-print': () => import('@marginalia/themes/serif-print.css?url'),
};

const THEME_LINK_ATTR = 'data-marginalia-theme';
let active: string | null = null;

export async function applyTheme(id: string): Promise<void> {
  const loadTheme = themeImports[id];
  if (!loadTheme) {
    console.warn('[marginalia:theme] unknown theme', id);
    return;
  }
  if (active === id) return;
  const mod = (await loadTheme()) as { default: string };
  const href = mod.default;

  const existing = document.querySelectorAll<HTMLLinkElement>(`link[${THEME_LINK_ATTR}]`);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.setAttribute(THEME_LINK_ATTR, id);
  link.onload = () => {
    for (const el of existing) el.remove();
  };
  document.head.appendChild(link);
  active = id;
}

export function themeLocalStorageKey(docUid: string): string {
  return `marginalia.theme.${docUid}`;
}

export function getUserThemeOverride(docUid: string): string | null {
  return localStorage.getItem(themeLocalStorageKey(docUid));
}

export function setUserThemeOverride(docUid: string, id: string | null): void {
  const key = themeLocalStorageKey(docUid);
  if (id === null) localStorage.removeItem(key);
  else localStorage.setItem(key, id);
}
