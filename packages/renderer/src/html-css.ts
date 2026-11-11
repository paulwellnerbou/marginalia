import postcss, { type AtRule, type ChildNode, type Container, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import type { Warning } from './types.js';

/**
 * Confining an HTML document's own stylesheet to the document.
 *
 * The page is not in an iframe — comment selection, highlights and the
 * floating cards all need it in the app's DOM — so its CSS has to match
 * nothing outside the root element the renderer wraps the body in:
 *
 *   - every style rule goes inside `@scope (.mg-html-root)`, so the browser
 *     itself keeps it from matching anything outside the root, whatever
 *     the selector says — escapes, nesting with `&` and nested `@scope`
 *     included. Global at-rules (`@keyframes`, `@font-face`, `@page`) stay
 *     outside, where every engine honours them;
 *   - selectors are rewritten with a real selector parser: a leading
 *     `:root`, `html` or `body` compound becomes `:scope`, the root itself,
 *     so `:root { --bg }` and `body { background }` land on the document;
 *     every other selector gets an explicit `:scope ` so it keeps the
 *     specificity of the class prefix it used to carry;
 *   - `prefers-color-scheme` queries become `[data-theme]` on the root,
 *     which the viewer sets from the app's appearance, so the document
 *     follows the in-app light/dark toggle rather than the OS;
 *   - `@import` survives only for font services, everything else that
 *     could pull in unscoped rules is dropped;
 *   - absolute lengths in font sizes and line heights are multiplied by
 *     `--mg-text-zoom`, the viewer's text size (see `scaleFontLengths`).
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
export function scopeHtmlCss(
  sources: readonly string[],
  fontLinks: readonly string[],
  inlineStyles: readonly string[] = [],
): ScopedCss {
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

  const roots: postcss.Root[] = [];
  for (const source of sources) {
    try {
      roots.push(postcss.parse(source));
    } catch (err) {
      warnings.push({
        kind: 'sanitized-element',
        message: `Dropped a <style> block that does not parse: ${(err as Error).message}`,
      });
    }
  }
  // Names are global across every <style> of the page, so collect them all
  // before renaming any reference.
  const renames = globalNameRenames(roots, warnings);

  const printGrids = singleColumnGridSelectors(roots);
  const fontTokens = fontOnlyCustomProperties(roots, inlineStyles);
  const bodies: string[] = [];
  for (const root of roots) {
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
    scopeContainer(root, null, warnings);
    applyRenames(root, renames);
    root.walkDecls((decl) => {
      if (isUnsafeValue(decl.value) || /^(behavior|-moz-binding)$/i.test(decl.prop)) {
        decl.remove();
      } else if (FONT_PROPS.test(decl.prop)) {
        decl.value = scaleFontLengths(decl.value, decl.prop);
      } else if (fontTokens.has(decl.prop)) {
        decl.value = scaleFontLengths(decl.value, null);
      }
    });
    bodies.push(wrapInScope(root));
  }

  const css = [...imports, BASE_CSS, ...bodies, printGridOverride(printGrids)].join('\n');
  return { css: escapeStyleText(css), warnings };
}

/**
 * `@keyframes`, `@counter-style` and `@property` declare names for the
 * whole page the app shares, where a page's `@keyframes rt-fade-in` or
 * `@property --accent-9` would redefine the app's own. Keyframes and
 * counter styles get a prefixed name, rewritten where the page uses
 * them; registered properties are dropped, since every `var()` reading
 * them would need renaming too. `@font-face` stays: families from font
 * services arrive by `@import` and cannot be renamed either, and `@page`
 * is wanted for the PDF export.
 */
interface Renames {
  keyframes: Map<string, string>;
  counterStyles: Map<string, string>;
}

const PAGE_NAME_PREFIX = 'mg-page-';

function globalNameRenames(roots: postcss.Root[], warnings: Warning[]): Renames {
  const renames: Renames = { keyframes: new Map(), counterStyles: new Map() };
  for (const root of roots) {
    root.walkAtRules((rule) => {
      const name = rule.name.toLowerCase();
      if (name === 'property') {
        warnings.push({
          kind: 'sanitized-element',
          message: `Dropped @property ${rule.params}: registered properties would apply to the whole app.`,
        });
        rule.remove();
        return;
      }
      const target = /^(-webkit-)?keyframes$/.test(name)
        ? renames.keyframes
        : name === 'counter-style'
          ? renames.counterStyles
          : null;
      if (!target) return;
      const original = rule.params.trim().replace(/^["']|["']$/g, '');
      if (!original) return;
      const renamed = target.get(original) ?? `${PAGE_NAME_PREFIX}${original}`;
      target.set(original, renamed);
      rule.params = renamed;
    });
  }
  return renames;
}

const KEYFRAME_PROPS = /^(-webkit-)?animation(-name)?$/i;
const COUNTER_STYLE_PROPS = /^(list-style(-type)?|content|system|fallback)$/i;

function applyRenames(root: postcss.Root, renames: Renames): void {
  if (renames.keyframes.size === 0 && renames.counterStyles.size === 0) return;
  root.walkDecls((decl) => {
    const names = KEYFRAME_PROPS.test(decl.prop)
      ? renames.keyframes
      : COUNTER_STYLE_PROPS.test(decl.prop)
        ? renames.counterStyles
        : null;
    if (names && names.size > 0) decl.value = renameIdents(decl.value, names);
  });
}

/** Replace whole identifiers outside strings. */
function renameIdents(value: string, names: Map<string, string>): string {
  return value.replace(/("[^"]*"|'[^']*')|(-?[A-Za-z_][\w-]*)/g, (m, str: string | undefined) =>
    str ? m : (names.get(m) ?? m),
  );
}

/**
 * Grids that set no columns: a stack of blocks laid out as a grid only
 * for `gap`. Chromium fragments a grid badly across printed pages — an
 * item that breaks (a long table) keeps its first-page height and runs
 * over the items after it — so in print these become flex columns, which
 * keep the gap and break cleanly. Grids with columns stay grids.
 *
 * Read before scoping, so selectors compare as the page wrote them.
 */
function singleColumnGridSelectors(roots: readonly postcss.Root[]): string[] {
  const grids = new Set<string>();
  const withColumns = new Set<string>();
  for (const root of roots) {
    root.walkRules((rule) => {
      if (insidePrintMedia(rule) || rule.parent?.type === 'rule') return;
      for (const node of rule.nodes) {
        if (node.type !== 'decl') continue;
        const prop = node.prop.toLowerCase();
        if (prop === 'display' && /^(inline-)?grid\b/i.test(node.value.trim())) {
          grids.add(rule.selector);
        } else if (/^grid(-template(-columns|-areas)?)?$/.test(prop) || prop === 'grid-auto-flow') {
          withColumns.add(rule.selector);
        }
      }
    });
  }
  return [...grids].filter((sel) => !withColumns.has(sel));
}

function insidePrintMedia(node: postcss.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (
      p.type === 'atrule' &&
      (p as AtRule).name.toLowerCase() === 'media' &&
      /\bprint\b/i.test((p as AtRule).params)
    ) {
      return true;
    }
  }
  return false;
}

function printGridOverride(selectors: readonly string[]): string {
  const scoped = selectors.map((sel) => scopeSelectorList(sel, null)).filter(Boolean);
  if (scoped.length === 0) return '';
  return `@scope (${ROOT}) {@media print{${scoped.join(', ')}{display:flex;flex-direction:column;align-items:stretch;}}}`;
}

/**
 * The page's rules inside `@scope (.mg-html-root)`, in their original
 * order, with each run of global at-rules lifted out between the blocks.
 * postcss serializes from the parsed tree, so a page cannot close the
 * block early: a stray `}` or an unclosed string fails the parse instead.
 */
function wrapInScope(root: postcss.Root): string {
  const parts: string[] = [];
  let pending: string[] = [];
  const flush = () => {
    if (pending.length > 0) parts.push(`@scope (${ROOT}) {\n${pending.join('\n')}\n}`);
    pending = [];
  };
  root.each((node) => {
    if (node.type === 'comment') return;
    if (node.type === 'atrule' && OPAQUE_AT_RULES.has(node.name.toLowerCase())) {
      flush();
      parts.push(node.toString());
    } else {
      pending.push(node.toString());
    }
  });
  flush();
  return parts.join('\n');
}

/** Strip what an inline `style` attribute must not carry, and scale its font sizes. */
export function sanitizeInlineStyle(style: string): string | null {
  const cleaned = style
    .split(';')
    .filter((decl) => !isUnsafeValue(decl) && !/^\s*(behavior|-moz-binding)\s*:/i.test(decl))
    .map((decl) => {
      const m = /^(\s*)([\w-]+)(\s*:)([\s\S]*)$/.exec(decl);
      return m && FONT_PROPS.test(m[2]!)
        ? `${m[1]}${m[2]}${m[3]}${scaleFontLengths(m[4]!, m[2]!)}`
        : decl;
    })
    .join(';')
    .trim();
  return cleaned || null;
}

/**
 * Text size for an HTML page. A page sizes its text in px far more often
 * than in em, so scaling the root's font size (as markdown does) would
 * leave most pages as they were, and CSS `zoom` throws the comment
 * chrome off: WebKit reports client rects inside a zoomed box divided by
 * the zoom. So the page's own font lengths are multiplied by a variable
 * the viewer sets; everything relative to them (em, %, unitless line
 * heights) follows, and layout lengths stay put, as they do for
 * markdown. Without the variable (exports, print) the factor is 1.
 */
const TEXT_ZOOM = 'var(--mg-text-zoom, 1)';
const FONT_PROPS = /^(font|font-size|line-height)$/i;
/** Absolute and viewport-relative units; em, ex, ch, % and lh follow the parent. */
const SCALED_LENGTH =
  /(?<![\w.#-])([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px|pt|pc|in|cm|mm|q|rem|[sld]?v(?:w|h|i|b|min|max)|cq(?:w|h|i|b|min|max))(?![\w-])/gi;
/** CSS's absolute size keywords, in px at the default 16px `medium`. */
const SIZE_KEYWORDS: Record<string, number> = {
  'xx-small': 9,
  'x-small': 10,
  small: 13,
  medium: 16,
  large: 18,
  'x-large': 24,
  'xx-large': 32,
  'xxx-large': 48,
};
const SIZE_KEYWORD = new RegExp(
  `(?<![\\w-])(${Object.keys(SIZE_KEYWORDS).join('|')})(?![\\w-])`,
  'gi',
);
/** Strings and `url()`, which are left as written. */
const OPAQUE_VALUE_PARTS = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\))/i;

/**
 * `value` with its absolute lengths multiplied by the text zoom. `prop`
 * decides whether size keywords count: they do in `font-size` and `font`,
 * not in `line-height` or a custom property (null), where `large` may
 * mean anything.
 */
export function scaleFontLengths(value: string, prop: string | null): string {
  const keywords = prop !== null && /^font(-size)?$/i.test(prop);
  return value
    .split(OPAQUE_VALUE_PARTS)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = part.replace(SCALED_LENGTH, (_m, n: string, unit: string) => {
        return `calc(${n}${unit} * ${TEXT_ZOOM})`;
      });
      if (keywords) {
        out = out.replace(SIZE_KEYWORD, (m) => {
          return `calc(${SIZE_KEYWORDS[m.toLowerCase()]}px * ${TEXT_ZOOM})`;
        });
      }
      return out;
    })
    .join('');
}

/**
 * Custom properties used only for type: read by `font`, `font-size` or
 * `line-height`, or by other such properties, and by nothing else. Their
 * own lengths scale with the text, so a page that keeps its type scale in
 * `--text-lg: 20px` grows like one that writes sizes out. One also read
 * for spacing or widths is left alone, as is one nothing reads.
 */
function fontOnlyCustomProperties(
  roots: readonly postcss.Root[],
  inlineStyles: readonly string[],
): Set<string> {
  // Every context each property is read in: 'font', 'other', or the
  // custom property whose value reads it.
  const readers = new Map<string, Set<string>>();
  const note = (prop: string, value: string) => {
    const context = prop.startsWith('--') ? prop : FONT_PROPS.test(prop) ? 'font' : 'other';
    for (const m of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = m[1]!;
      const set = readers.get(name) ?? new Set<string>();
      set.add(context);
      readers.set(name, set);
    }
  };
  for (const root of roots) root.walkDecls((decl) => note(decl.prop, decl.value));
  for (const style of inlineStyles) {
    for (const decl of style.split(';')) {
      const m = /^\s*([\w-]+)\s*:([\s\S]*)$/.exec(decl);
      if (m) note(m[1]!, m[2]!);
    }
  }
  const fontOnly = new Set(readers.keys());
  for (let changed = true; changed; ) {
    changed = false;
    for (const name of fontOnly) {
      for (const context of readers.get(name)!) {
        if (context === 'font' || (context.startsWith('--') && fontOnly.has(context))) continue;
        fontOnly.delete(name);
        changed = true;
        break;
      }
    }
  }
  return fontOnly;
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

function scopeContainer(container: Container, scheme: Scheme | null, warnings: Warning[]): void {
  for (const node of [...(container.nodes ?? [])] as ChildNode[]) {
    if (node.type === 'rule') {
      scopeRule(node, scheme, warnings);
    } else if (node.type === 'atrule') {
      scopeAtRule(node, scheme, warnings);
    }
  }
}

function scopeAtRule(rule: AtRule, scheme: Scheme | null, warnings: Warning[]): void {
  const name = rule.name.toLowerCase();
  if (OPAQUE_AT_RULES.has(name)) return;
  // A page's own @scope nests inside ours and stays confined by it; its
  // selectors are relative to its own root, so they are left as written.
  if (name === 'scope') return;
  if (name === 'media') {
    const split = splitColorScheme(rule.params);
    if (split) {
      scopeContainer(rule, split.scheme, warnings);
      if (split.rest === null) {
        rule.replaceWith(...(rule.nodes ?? []));
      } else {
        rule.params = split.rest;
      }
      return;
    }
  }
  if (GROUPING_AT_RULES.has(name) || rule.nodes) scopeContainer(rule, scheme, warnings);
}

function scopeRule(rule: Rule, scheme: Scheme | null, warnings: Warning[]): void {
  const scoped = scopeSelectorList(rule.selector, scheme);
  if (scoped) {
    rule.selector = scoped;
  } else {
    warnings.push({
      kind: 'sanitized-element',
      message: `Dropped a rule whose selector does not parse: ${rule.selector}`,
    });
    rule.remove();
  }
  // Nested rules are relative to this one, and confined by @scope either way.
}

/**
 * `(prefers-color-scheme: X)` pulled out of a single media query. `rest`
 * is what is left of the query, or null when nothing is.
 */
function splitColorScheme(params: string): { scheme: Scheme; rest: string | null } | null {
  if (postcss.list.comma(params).length !== 1) return null;
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
  if (scheme === 'dark') return ':scope[data-theme="dark"]';
  // Light is the default: exports and first paint carry no attribute.
  if (scheme === 'light') return ':scope:not([data-theme="dark"])';
  return ':scope';
}

/**
 * A selector list rewritten for use inside `@scope (.mg-html-root)`, or
 * '' when it does not parse. The parser handles escapes, strings and
 * nested pseudo-classes, so a list splits exactly where the browser
 * splits it.
 */
export function scopeSelectorList(list: string, scheme: Scheme | null): string {
  const root = rootFor(scheme);
  let out: string[];
  try {
    out = [];
    selectorParser((selectors) => {
      selectors.each((selector) => {
        const scoped = scopeSelector(selector, root);
        if (scoped) out.push(scoped);
      });
    }).processSync(list);
  } catch {
    return '';
  }
  return out.join(', ');
}

type SelectorNode = selectorParser.Node;

function isRootish(node: SelectorNode | undefined): boolean {
  if (!node) return false;
  if (node.type === 'tag') return /^(html|body)$/i.test(node.value);
  if (node.type === 'pseudo')
    return /^:(root|host|scope)$/i.test(node.value) && node.nodes.length === 0;
  return false;
}

/**
 * `html body.x > main`, `html > body` → `:scope.x > main`, `:scope`: every
 * leading root-ish compound collapses into the one root element. Anything
 * else is placed under it, `:scope p`.
 */
function scopeSelector(selector: selectorParser.Selector, root: string): string {
  const nodes = selector.nodes;
  if (nodes.length === 0) return '';
  let i = 0;
  let suffix = '';
  let matched = false;
  while (isRootish(nodes[i])) {
    matched = true;
    i++;
    while (i < nodes.length && nodes[i]!.type !== 'combinator') suffix += nodes[i++]!.toString();
    const combinator = nodes[i];
    const joiner = combinator?.type === 'combinator' ? combinator.value.trim() : null;
    if ((joiner === '' || joiner === '>') && isRootish(nodes[i + 1])) {
      i++;
      continue;
    }
    break;
  }
  if (!matched) return `${root} ${selector.toString().trim()}`;
  const rest = nodes
    .slice(i)
    .map((n) => n.toString())
    .join('');
  return `${root}${suffix.trim()}${rest}`.trim();
}
