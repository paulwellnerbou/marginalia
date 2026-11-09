import postcss, { type AtRule, type ChildNode, type Container, type Rule } from 'postcss';
import type { Warning } from './types.js';

/**
 * Confining an HTML document's own stylesheet to the document.
 *
 * The page is not in an iframe — comment selection, highlights and the
 * floating cards all need it in the app's DOM — so its CSS has to be
 * rewritten to match nothing outside the root element the renderer wraps
 * the body in:
 *
 *   - every selector is prefixed with the root; a leading `:root`, `html`
 *     or `body` compound becomes the root itself, so `:root { --bg }` and
 *     `body { background }` land on the document, not the app;
 *   - `prefers-color-scheme` queries become `[data-theme]` on the root,
 *     which the viewer sets from the app's appearance, so the document
 *     follows the in-app light/dark toggle rather than the OS;
 *   - `@import` survives only for font services, everything else that
 *     could pull in unscoped rules is dropped.
 *
 * The root itself gets `contain: paint`, which makes it the containing
 * block for fixed-position descendants and clips them, so nothing the
 * document positions can cover the app around it.
 */

export const HTML_ROOT_CLASS = 'mg-html-root';
const ROOT = `.${HTML_ROOT_CLASS}`;

/** Hosts whose stylesheets only declare `@font-face`. */
const FONT_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.bunny.net',
  'use.typekit.net',
  'rsms.me',
  'api.fontshare.com',
]);

// Paint containment is for the app around the page; on paper there is
// none, and a contained box may not break across pages.
const BASE_CSS = `${ROOT}{contain:paint;position:relative;display:flow-root;}@media print{${ROOT}{contain:none;}}`;

/** Rules whose children are not selectors. */
const OPAQUE_AT_RULES = new Set([
  'keyframes',
  '-webkit-keyframes',
  'font-face',
  'font-feature-values',
  'property',
  'counter-style',
  'page',
  'font-palette-values',
]);

/** At-rules whose children are ordinary rules to scope. */
const GROUPING_AT_RULES = new Set(['media', 'supports', 'layer', 'container', 'document']);

type Scheme = 'dark' | 'light';

export interface ScopedCss {
  css: string;
  warnings: Warning[];
}

export function isFontStylesheet(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && FONT_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Scope `sources` (each a `<style>` body, in document order) to the
 * document root. `fontLinks` are `<link rel="stylesheet">` hrefs, kept
 * as imports when they point at a font service.
 */
export function scopeHtmlCss(sources: readonly string[], fontLinks: readonly string[]): ScopedCss {
  const warnings: Warning[] = [];
  const imports: string[] = [];
  for (const href of fontLinks) {
    if (isFontStylesheet(href)) imports.push(`@import url(${JSON.stringify(href)});`);
    else
      warnings.push({
        kind: 'sanitized-element',
        message: `Dropped stylesheet link ${href}: only font services are loaded.`,
      });
  }

  const bodies: string[] = [];
  for (const source of sources) {
    let root: postcss.Root;
    try {
      root = postcss.parse(source);
    } catch (err) {
      warnings.push({
        kind: 'sanitized-element',
        message: `Dropped a <style> block that does not parse: ${(err as Error).message}`,
      });
      continue;
    }
    root.walkAtRules('import', (rule) => {
      const href = importHref(rule.params);
      if (href && isFontStylesheet(href)) imports.push(`@import url(${JSON.stringify(href)});`);
      else
        warnings.push({
          kind: 'sanitized-element',
          message: `Dropped @import ${rule.params}: only font services are loaded.`,
        });
      rule.remove();
    });
    root.walkAtRules(/^(charset|namespace)$/i, (rule) => {
      rule.remove();
    });
    scopeContainer(root, null);
    root.walkDecls((decl) => {
      if (isUnsafeValue(decl.value) || /^(behavior|-moz-binding)$/i.test(decl.prop)) decl.remove();
    });
    bodies.push(root.toString());
  }

  const css = [...imports, BASE_CSS, ...bodies].join('\n');
  return { css: escapeStyleText(css), warnings };
}

/** Strip what an inline `style` attribute must not carry. */
export function sanitizeInlineStyle(style: string): string | null {
  const cleaned = style
    .split(';')
    .filter((decl) => !isUnsafeValue(decl) && !/^\s*(behavior|-moz-binding)\s*:/i.test(decl))
    .join(';')
    .trim();
  return cleaned || null;
}

function isUnsafeValue(value: string): boolean {
  return /expression\s*\(|javascript:|vbscript:/i.test(value);
}

/** Keep `</style` inside the CSS from closing the element it is served in. */
function escapeStyleText(css: string): string {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

function importHref(params: string): string | null {
  const m = /^\s*(?:url\(\s*)?["']?([^"')\s]+)["']?\s*\)?/i.exec(params);
  return m ? m[1]! : null;
}

function scopeContainer(container: Container, scheme: Scheme | null): void {
  for (const node of [...(container.nodes ?? [])] as ChildNode[]) {
    if (node.type === 'rule') {
      scopeRule(node, scheme);
    } else if (node.type === 'atrule') {
      scopeAtRule(node, scheme);
    }
  }
}

function scopeAtRule(rule: AtRule, scheme: Scheme | null): void {
  const name = rule.name.toLowerCase();
  if (OPAQUE_AT_RULES.has(name)) return;
  if (name === 'scope') {
    rule.params = rule.params.replace(
      /\(([^)]*)\)/,
      (_m, sel: string) => `(${scopeSelectorList(sel, scheme)})`,
    );
    return;
  }
  if (name === 'media') {
    const split = splitColorScheme(rule.params);
    if (split) {
      scopeContainer(rule, split.scheme);
      if (split.rest === null) {
        rule.replaceWith(...(rule.nodes ?? []));
      } else {
        rule.params = split.rest;
      }
      return;
    }
  }
  if (GROUPING_AT_RULES.has(name) || rule.nodes) scopeContainer(rule, scheme);
}

function scopeRule(rule: Rule, scheme: Scheme | null): void {
  rule.selector = scopeSelectorList(rule.selector, scheme);
  // Nested rules are relative to this one and already scoped through it.
}

/**
 * `(prefers-color-scheme: X)` pulled out of a single media query. `rest`
 * is what is left of the query, or null when nothing is.
 */
function splitColorScheme(params: string): { scheme: Scheme; rest: string | null } | null {
  if (splitTopLevel(params, ',').length !== 1) return null;
  const feature = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/i;
  const m = feature.exec(params);
  if (!m || /\bnot\b/i.test(params)) return null;
  const rest = params
    .replace(feature, '')
    .replace(/^\s*and\s+|\s+and\s*$/i, '')
    .replace(/\s+and\s+and\s+/i, ' and ')
    .trim();
  const scheme = m[1]!.toLowerCase() as Scheme;
  return { scheme, rest: rest === '' || /^(all|screen|only screen)$/i.test(rest) ? null : rest };
}

function rootFor(scheme: Scheme | null): string {
  if (scheme === 'dark') return `${ROOT}[data-theme="dark"]`;
  // Light is the default: exports and first paint carry no attribute.
  if (scheme === 'light') return `${ROOT}:not([data-theme="dark"])`;
  return ROOT;
}

export function scopeSelectorList(list: string, scheme: Scheme | null): string {
  return splitTopLevel(list, ',')
    .map((sel) => scopeSelector(sel.trim(), rootFor(scheme)))
    .filter(Boolean)
    .join(', ');
}

const ROOTISH_RE = /^(?::root|:host|html|body)(?![\w-])/i;

function scopeSelector(selector: string, root: string): string {
  if (!selector) return '';
  let rest = selector;
  let suffix = '';
  let matchedRoot = false;
  // `html body.x > main` → root.x > main: every leading root-ish compound
  // collapses into the one root element.
  for (;;) {
    const m = ROOTISH_RE.exec(rest);
    if (!m) break;
    matchedRoot = true;
    const compoundEnd = endOfCompound(rest);
    suffix += rest.slice(m[0].length, compoundEnd);
    rest = rest.slice(compoundEnd);
    const descendant = /^\s+(?=[\w:.#[*-])/.exec(rest);
    if (descendant && ROOTISH_RE.test(rest.slice(descendant[0].length))) {
      rest = rest.slice(descendant[0].length);
      continue;
    }
    break;
  }
  if (matchedRoot) return `${root}${suffix}${rest}`;
  return `${root} ${selector}`;
}

/** Index where the first compound selector of `sel` ends. */
function endOfCompound(sel: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) return i;
  }
  return sel.length;
}

function splitTopLevel(input: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && ch === separator) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts;
}
