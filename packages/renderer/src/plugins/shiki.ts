import type { Plugin } from 'unified';
import type { Root, Element, ElementContent, Properties } from 'hast';
import { visit } from 'unist-util-visit';
import { createdBundledHighlighter } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { Warning } from '../types.js';

export interface ShikiOptions {
  light?: string;
  dark?: string;
}

const SUPPORTED_THEME_LOADERS = {
  'github-dark': () => import('shiki/dist/themes/github-dark.mjs'),
  'github-light': () => import('shiki/dist/themes/github-light.mjs'),
} as const;

const SUPPORTED_LANGUAGE_LOADERS = {
  bash: () => import('shiki/dist/langs/bash.mjs'),
  console: () => import('shiki/dist/langs/console.mjs'),
  css: () => import('shiki/dist/langs/css.mjs'),
  diff: () => import('shiki/dist/langs/diff.mjs'),
  dockerfile: () => import('shiki/dist/langs/dockerfile.mjs'),
  dotenv: () => import('shiki/dist/langs/dotenv.mjs'),
  go: () => import('shiki/dist/langs/go.mjs'),
  graphql: () => import('shiki/dist/langs/graphql.mjs'),
  html: () => import('shiki/dist/langs/html.mjs'),
  ini: () => import('shiki/dist/langs/ini.mjs'),
  javascript: () => import('shiki/dist/langs/javascript.mjs'),
  json: () => import('shiki/dist/langs/json.mjs'),
  jsonc: () => import('shiki/dist/langs/jsonc.mjs'),
  jsx: () => import('shiki/dist/langs/jsx.mjs'),
  markdown: () => import('shiki/dist/langs/markdown.mjs'),
  mdx: () => import('shiki/dist/langs/mdx.mjs'),
  python: () => import('shiki/dist/langs/python.mjs'),
  rust: () => import('shiki/dist/langs/rust.mjs'),
  shellsession: () => import('shiki/dist/langs/shellsession.mjs'),
  sql: () => import('shiki/dist/langs/sql.mjs'),
  toml: () => import('shiki/dist/langs/toml.mjs'),
  tsx: () => import('shiki/dist/langs/tsx.mjs'),
  typescript: () => import('shiki/dist/langs/typescript.mjs'),
  xml: () => import('shiki/dist/langs/xml.mjs'),
  yaml: () => import('shiki/dist/langs/yaml.mjs'),
} as const;

type SupportedTheme = keyof typeof SUPPORTED_THEME_LOADERS;
type SupportedLanguage = keyof typeof SUPPORTED_LANGUAGE_LOADERS;
type ShikiHighlighter = Awaited<ReturnType<typeof createBundledHighlighter>>;

const THEME_FALLBACKS = {
  dark: 'github-dark',
  light: 'github-light',
} as const satisfies Record<'dark' | 'light', SupportedTheme>;

const LANGUAGE_ALIASES: Record<string, SupportedLanguage> = {
  docker: 'dockerfile',
  gql: 'graphql',
  js: 'javascript',
  md: 'markdown',
  py: 'python',
  shell: 'bash',
  shellscript: 'bash',
  sh: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

const PLAIN_TEXT_LANGS = new Set(['plain', 'plaintext', 'text', 'txt']);

const createBundledHighlighter = createdBundledHighlighter({
  langs: SUPPORTED_LANGUAGE_LOADERS,
  themes: SUPPORTED_THEME_LOADERS,
  engine: () => createJavaScriptRegexEngine(),
});

const highlighterPromises = new Map<string, Promise<ShikiHighlighter>>();

async function getHighlighter(light: string, dark: string): Promise<ShikiHighlighter> {
  const resolvedLight = resolveTheme(light, THEME_FALLBACKS.light);
  const resolvedDark = resolveTheme(dark, THEME_FALLBACKS.dark);
  const key = `${resolvedLight}:${resolvedDark}`;
  let promise = highlighterPromises.get(key);
  if (!promise) {
    promise = createBundledHighlighter({
      themes: [resolvedLight, resolvedDark],
      langs: [],
    });
    highlighterPromises.set(key, promise);
  }
  return promise;
}

function resolveTheme(theme: string | undefined, fallback: SupportedTheme): SupportedTheme {
  if (theme && theme in SUPPORTED_THEME_LOADERS) return theme as SupportedTheme;
  return fallback;
}

function resolveLang(lang: string): SupportedLanguage | null {
  if (lang in SUPPORTED_LANGUAGE_LOADERS) return lang as SupportedLanguage;
  return LANGUAGE_ALIASES[lang] ?? null;
}

/**
 * Highlight `<pre><code class="language-xxx">…</code></pre>` blocks with
 * Shiki. Produces a `<pre class="shiki">` with inline style colors for
 * each token, keyed to CSS variables so light/dark theming is pure CSS.
 */
export const rehypeShikiHighlight: Plugin<[ShikiOptions], Root> = (options) => {
  const light = resolveTheme(options.light, THEME_FALLBACKS.light);
  const dark = resolveTheme(options.dark, THEME_FALLBACKS.dark);

  return async (tree, file) => {
    const warnings: Warning[] = ((file.data as { warnings?: Warning[] })
      .warnings ??= []);

    const jobs: Array<() => Promise<void>> = [];

    visit(tree, 'element', (node: Element, index, parent) => {
      if (node.tagName !== 'pre' || !parent || index === undefined) return;
      const code = node.children.find(
        (c): c is Element => c.type === 'element' && c.tagName === 'code',
      );
      if (!code) return;

      const rawLang = extractLang(code)?.toLowerCase();
      if (!rawLang) return; // no language -> leave unhighlighted
      if (PLAIN_TEXT_LANGS.has(rawLang)) return;

      const lang = resolveLang(rawLang);
      if (!lang) {
        warnings.push({
          kind: 'unknown-language',
          message: `unknown code block language "${rawLang}"`,
        });
        return;
      }

      const source = codeText(code);
      const preserveAttrs = { ...node.properties };

      jobs.push(async () => {
        const hl = await getHighlighter(light, dark);
        await hl.loadLanguage(lang);
        const html = hl.codeToHtml(source, {
          lang,
          themes: { light, dark },
          defaultColor: false,
        });
        const replacement = htmlStringToPre(html, preserveAttrs, rawLang);
        if (replacement) {
          parent.children[index] = replacement;
        }
      });
    });

    for (const job of jobs) await job();
  };
};

function extractLang(code: Element): string | null {
  const cls = code.properties?.className;
  const list = Array.isArray(cls) ? cls : typeof cls === 'string' ? cls.split(' ') : [];
  for (const c of list) {
    if (typeof c === 'string' && c.startsWith('language-')) {
      return c.slice('language-'.length);
    }
  }
  return null;
}

function codeText(code: Element): string {
  let out = '';
  for (const child of code.children as ElementContent[]) {
    if (child.type === 'text') out += child.value;
    else if (child.type === 'element') out += codeText(child);
  }
  return out;
}

/**
 * Shiki returns an HTML string; to keep it as hast we reparse minimally.
 * We only need the outer <pre> element — Shiki's output is well-formed.
 */
function htmlStringToPre(
  html: string,
  preserveAttrs: Element['properties'],
  lang: string,
): Element | null {
  // Leverage rehype-raw downstream? Simpler: wrap as a raw node so rehype
  // keeps it intact. But we already ran rehype-raw above. Emit as a
  // "raw" node — supported by rehype-stringify with allowDangerousHtml, but
  // we disabled that. So parse manually: cheap, regex-based — safe because
  // Shiki's HTML is trusted (we generated it here).
  const attrs: Properties = { ...preserveAttrs };
  attrs.className = mergeClasses(preserveAttrs?.className, ['shiki', `language-${lang}`]);
  attrs['data-language'] = lang;

  // Strip the outer <pre …>…</pre> from Shiki's output and parse children.
  const preMatch = html.match(/^<pre[^>]*>([\s\S]*)<\/pre>\s*$/);
  if (!preMatch) return null;
  const inner = preMatch[1]!;
  const children = parseShikiInner(inner);

  return {
    type: 'element',
    tagName: 'pre',
    properties: attrs,
    children,
  };
}

function mergeClasses(existing: unknown, extra: string[]): string[] {
  const base = Array.isArray(existing)
    ? existing.map(String)
    : typeof existing === 'string'
      ? existing.split(' ')
      : [];
  return Array.from(new Set([...base, ...extra]));
}

/**
 * Parse the inner HTML of Shiki's <pre> into hast nodes.
 *
 * Shiki emits only: <code>, <span>, text, and inline style attrs. We parse
 * just enough for that.
 */
function parseShikiInner(html: string): ElementContent[] {
  const out: ElementContent[] = [];
  const tokens = tokenize(html);
  const stack: Element[] = [];
  let current: Element | null = null;

  for (const tok of tokens) {
    if (tok.kind === 'open') {
      const el: Element = {
        type: 'element',
        tagName: tok.name,
        properties: tok.attrs as Properties,
        children: [],
      };
      if (current) current.children.push(el);
      else out.push(el);
      if (!tok.selfClosing) {
        stack.push(el);
        current = el;
      }
    } else if (tok.kind === 'close') {
      stack.pop();
      current = stack.length > 0 ? stack[stack.length - 1]! : null;
    } else {
      const textNode = { type: 'text' as const, value: tok.value };
      if (current) current.children.push(textNode);
      else out.push(textNode);
    }
  }
  return out;
}

type Token =
  | { kind: 'open'; name: string; attrs: Record<string, unknown>; selfClosing: boolean }
  | { kind: 'close'; name: string }
  | { kind: 'text'; value: string };

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const re = /<\/?([a-zA-Z]+)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[3] !== undefined) {
      tokens.push({ kind: 'text', value: decodeEntities(m[3]) });
      continue;
    }
    const name = m[1]!;
    const rest = m[2] ?? '';
    const selfClosing = rest.trim().endsWith('/');
    if (m[0].startsWith('</')) {
      tokens.push({ kind: 'close', name });
    } else {
      tokens.push({ kind: 'open', name, attrs: parseAttrs(rest), selfClosing });
    }
  }
  return tokens;
}

function parseAttrs(rest: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const re = /([a-zA-Z-][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rest)) !== null) {
    const key = m[1]!;
    const val = decodeEntities(m[2]!);
    if (key === 'class') out.className = val.split(' ');
    else out[key] = val;
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
