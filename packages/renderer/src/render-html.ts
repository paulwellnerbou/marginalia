import type { Element, ElementContent, Root } from 'hast';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { normalizeBlockText } from './block-ids-shared.js';
import {
  findElement,
  isNonContent,
  parseHtmlSource,
  textOf,
  walkHtmlBlocks,
} from './html-blocks.js';
import { HTML_ROOT_CLASS, sanitizeInlineStyle, scopeHtmlCss } from './html-css.js';
import { rehypeAsciidocAssetCollector } from './plugins/asciidoc-asset-collector.js';
import { markAnchorable, rehypeCollectRenderedBlockIds } from './plugins/block-elements.js';
import { rehypeBlockText } from './plugins/block-text.js';
import { htmlSanitizeSchema } from './plugins/html-sanitize-schema.js';
import { slugify } from './plugins/slugger.js';
import { buildToc } from './toc.js';
import type { Anchor, AssetRef, BlockInfo, RenderOptions, RenderResult, Warning } from './types.js';

/**
 * HTML twin of `render()`: a hand-written or generated page, kept as the
 * author laid it out, with comment anchoring on top.
 *
 * The body is wrapped in `<div class="mg-html-root" data-html-doc>` and its
 * `<style>` blocks come back separately as `RenderResult.css`, scoped to
 * that root (see `html-css.ts`). Keeping the CSS out of `html` keeps it out
 * of every text walk over the article — search, read-aloud, block text.
 *
 * Unlike the other pipelines nothing is added to the markup: no heading
 * permalinks, no syntax highlighting. The page's own CSS doesn't know
 * those elements and would show them unstyled.
 */
export async function renderHtml(
  source: string,
  _options: RenderOptions = {},
): Promise<RenderResult> {
  const tree = parseHtmlSource(source);
  const warnings: Warning[] = [];

  const htmlEl = findElement(tree, 'html');
  const body = findElement(tree, 'body');
  // Only the head's: an SVG in the body has a `<title>` of its own.
  const head = findElement(tree, 'head');
  const titleEl = head ? findElement(head, 'title') : null;
  const title = titleEl ? normalizeBlockText(rawText(titleEl)) : '';

  const styles: string[] = [];
  const links: string[] = [];
  const inlineStyles: string[] = [];
  visit(tree, 'element', (node: Element) => {
    if (typeof node.properties?.style === 'string') inlineStyles.push(node.properties.style);
    if (node.tagName === 'style') styles.push(rawText(node));
    else if (node.tagName === 'link' && relOf(node).includes('stylesheet')) {
      const href = node.properties?.href;
      if (typeof href === 'string') links.push(href);
    }
  });

  const walked = walkHtmlBlocks(tree);
  const anchors: Anchor[] = [];
  const usedIds = collectIds(body);
  const blocks: BlockInfo[] = walked.map((b) => {
    b.node.properties ??= {};
    b.node.properties.dataBlock = b.id;
    let headingId: string | undefined;
    if (b.level !== undefined) {
      headingId = ensureHeadingId(b.node, b.text, usedIds);
      anchors.push({ level: b.level, text: b.text, id: headingId });
    }
    return {
      id: b.id,
      kind: b.kind,
      text: b.text,
      headingPath: b.section.headingPath,
      sectionIndex: b.section.sectionIndex,
      sectionIndexPath: b.section.sectionIndexPath,
      anchorable: false,
      ...(headingId ? { headingId } : {}),
    };
  });

  const root: Element = {
    type: 'element',
    tagName: 'div',
    properties: {
      className: [HTML_ROOT_CLASS, ...classesOf(htmlEl), ...classesOf(body)],
      dataHtmlDoc: '',
      ...langOf(htmlEl, body),
    },
    children: body ? cleanChildren(body.children) : [],
  };

  const out: Root = { type: 'root', children: [root] };
  const processor = unified()
    .use(rehypeSanitize, htmlSanitizeSchema)
    .use(rehypeAsciidocAssetCollector)
    .use(rehypeBlockText, { blocks })
    .use(rehypeCollectRenderedBlockIds)
    .use(rehypeStringify);
  const file = { data: {} } as Parameters<typeof processor.run>[1] & {
    data: { assets?: AssetRef[]; renderedBlockIds?: Set<string> };
  };
  const finished = (await processor.run(out, file)) as Root;
  const html = processor.stringify(finished);

  const scoped = scopeHtmlCss(styles, links, inlineStyles);
  warnings.push(...scoped.warnings);

  return {
    html,
    css: scoped.css,
    anchors,
    toc: buildToc(anchors),
    assets: file.data.assets ?? [],
    mermaid: [],
    blocks: markAnchorable(blocks, file.data.renderedBlockIds),
    warnings,
    frontmatter: title ? { title } : {},
  };
}

/** A raw-text element's content; `textOf` skips `<style>` on purpose. */
function rawText(node: Element): string {
  return node.children.map((c) => (c.type === 'text' ? c.value : '')).join('');
}

function relOf(node: Element): string[] {
  const rel: unknown = node.properties?.rel;
  const list: unknown[] = Array.isArray(rel)
    ? rel
    : typeof rel === 'string'
      ? rel.split(/\s+/)
      : [];
  return list.map((r) => String(r).toLowerCase());
}

function classesOf(el: Element | null): string[] {
  const cls = el?.properties?.className;
  return Array.isArray(cls) ? cls.map(String) : [];
}

function langOf(htmlEl: Element | null, body: Element | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['lang', 'dir'] as const) {
    const v = body?.properties?.[key] ?? htmlEl?.properties?.[key];
    if (typeof v === 'string' && v) out[key] = v;
  }
  return out;
}

function collectIds(body: Element | null): Set<string> {
  const ids = new Set<string>();
  if (!body) return ids;
  visit(body, 'element', (node: Element) => {
    const id = node.properties?.id;
    if (typeof id === 'string' && id) ids.add(id);
  });
  return ids;
}

/** The heading's own id, or a slug of its text that no other element has. */
function ensureHeadingId(node: Element, text: string, used: Set<string>): string {
  const own = node.properties?.id;
  if (typeof own === 'string' && own) return own;
  const base = slugify(text);
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  used.add(id);
  node.properties.id = id;
  return id;
}

/**
 * Drop what the sanitizer would otherwise unwrap into text (a `<style>`'s
 * CSS, a `<title>`), narrow `data:` sources to images and filter inline
 * styles. The sanitizer still runs afterwards and has the last word.
 */
function cleanChildren(children: ElementContent[]): ElementContent[] {
  const out: ElementContent[] = [];
  for (const child of children) {
    if (child.type === 'comment') continue;
    if (child.type !== 'element') {
      out.push(child);
      continue;
    }
    if (isNonContent(child)) continue;
    child.properties ??= {};
    const props = child.properties;
    if (typeof props.src === 'string' && /^\s*data:/i.test(props.src)) {
      if (!/^\s*data:image\//i.test(props.src)) delete props.src;
    }
    if (typeof props.srcSet === 'string') {
      const srcSet = sanitizeSrcSet(props.srcSet);
      if (srcSet) props.srcSet = srcSet;
      else delete props.srcSet;
    }
    if (child.tagName === 'a' && typeof props.target === 'string') {
      // Browsers imply this for `_blank` today; naming it covers every target.
      const rel = Array.isArray(props.rel) ? props.rel.map(String) : [];
      props.rel = [...new Set([...rel, 'noopener', 'noreferrer'])];
    }
    if (typeof props.style === 'string') {
      const style = sanitizeInlineStyle(props.style);
      if (style) props.style = style;
      else delete props.style;
    }
    child.children = cleanChildren(child.children);
    out.push(child);
  }
  return out;
}

/**
 * `srcset` minus candidates `src` would not be allowed: any scheme but
 * http(s) and `data:image/`. The sanitizer checks protocols on `src` only.
 * A candidate's URL runs to the next whitespace (a `data:` URL holds
 * commas), then an optional descriptor up to the comma.
 */
function sanitizeSrcSet(srcSet: string): string | null {
  const kept: string[] = [];
  let rest = srcSet;
  for (;;) {
    rest = rest.replace(/^[\s,]+/, '');
    if (!rest) break;
    let url = /^\S+/.exec(rest)![0];
    rest = rest.slice(url.length);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      const d = /^[^,]*/.exec(rest)![0];
      descriptor = d.trim();
      rest = rest.slice(d.length);
    }
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
    const allowed =
      scheme === undefined ||
      scheme === 'http' ||
      scheme === 'https' ||
      (scheme === 'data' && /^data:image\//i.test(url));
    if (allowed) kept.push(descriptor ? `${url} ${descriptor}` : url);
  }
  return kept.length > 0 ? kept.join(', ') : null;
}
