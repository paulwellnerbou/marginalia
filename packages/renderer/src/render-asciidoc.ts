import Asciidoctor from '@asciidoctor/core';
import type { Root as HastRoot } from 'hast';

import rehypeParse from 'rehype-parse';
import rehypeSanitize from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import {
  MARGINALIA_BLOCK_MARKER_PREFIX,
  MARGINALIA_SUBBLOCK_MARKER_PREFIX,
  type SubBlockEntry,
} from './asciidoc-markers.js';
import { computeSubBlockId, hashBlock, normalizeBlockText } from './block-ids-shared.js';
import { rehypeAsciidocAnchorsToc } from './plugins/asciidoc-anchors-toc.js';
import { rehypeAsciidocAssetCollector } from './plugins/asciidoc-asset-collector.js';
import { rehypeAsciidocBlockIds } from './plugins/asciidoc-block-ids.js';
import { rehypeAsciidocMermaid } from './plugins/asciidoc-mermaid.js';
import { rehypeBlockText } from './plugins/block-text.js';
import { rehypeHeadingAnchors } from './plugins/heading-anchors.js';
import { sanitizeSchema } from './plugins/sanitize-schema.js';
import { rehypeShikiHighlight } from './plugins/shiki.js';
import { buildToc } from './toc.js';
import type {
  Anchor,
  AssetRef,
  BlockInfo,
  BlockMap,
  MermaidBlock,
  RenderOptions,
  RenderResult,
  Warning,
} from './types.js';

type AsciidoctorInstance = ReturnType<typeof Asciidoctor>;

declare global {
  var __asciidoctor: AsciidoctorInstance | undefined;
}

globalThis.__asciidoctor ??= Asciidoctor();
const asciidoctor: AsciidoctorInstance = globalThis.__asciidoctor;

interface AdocRenderData {
  anchors?: Anchor[];
  assets?: AssetRef[];
  mermaid?: MermaidBlock[];
  warnings?: Warning[];
}

/**
 * AsciiDoc-flavoured twin of `render()` in render.ts.
 *
 * Two-phase pipeline: asciidoctor.js converts source → HTML, then a rehype
 * pipeline post-processes that HTML to attach content-hash block ids,
 * collect anchors, harvest assets, lower mermaid blocks, highlight code,
 * and sanitize. Returning the same RenderResult shape as the markdown
 * pipeline keeps every downstream consumer (comment anchoring, TOC,
 * search, bundle export) format-agnostic.
 */
export async function renderAsciidoc(
  source: string,
  options: RenderOptions = {},
): Promise<RenderResult> {
  const doc = asciidoctor.load(source, {
    // Keep asciidoctor's own source highlighting out of the way so Shiki
    // runs over the resulting <pre><code> just like on the markdown path.
    // `showtitle` is on so `= My Doc` renders as a visible `<h1>` at the
    // top of the body, matching markdown's `# My Doc` behaviour; the doc
    // title would otherwise only surface in the browser tab via the
    // frontmatter, leaving the rendered body missing its own heading.
    // `sectids` ensures <h2 id="…"> etc. for anchor harvesting.
    attributes: {
      'source-highlighter': null,
      showtitle: true,
      sectids: true,
      'sectnums!': true,
      // Unlock the `kbd:[...]`, `btn:[...]`, `menu:File > New` UI-element
      // macros. They're idiomatic AsciiDoc but gated behind this flag —
      // off by default, asciidoctor emits `kbd:[Ctrl+S]` as literal text.
      experimental: true,
    },
    safe: 'safe',
    standalone: false,
    sourcemap: true,
  });

  const { blocks, subBlocks } = walkBlocks(doc);

  const html = doc.convert() as string;
  const frontmatter = extractFrontmatter(doc);

  // Order matters: mermaid runs before block-ids so the replacement div
  // carries over the marker class, and block-ids then attaches data-block
  // to the mermaid div itself (parity with how remarkMermaid + block-ids
  // interact in the markdown pipeline). Heading anchors runs before
  // sanitize so the injected `<a class="heading-anchor">` survives.
  const processorRehype = unified()
    .use(rehypeParse, { fragment: true })
    .use(rehypeAsciidocMermaid, { mode: options.mermaid ?? 'client' })
    .use(rehypeAsciidocBlockIds, { blocks, subBlocks })
    .use(rehypeAsciidocAnchorsToc)
    .use(rehypeAsciidocAssetCollector)
    .use(rehypeHeadingAnchors)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeShikiHighlight, options.highlight ?? {})
    // Last, so block text is read off the markup the client receives. The
    // map is passed in because it is built before this pipeline runs, not
    // by a plugin inside it.
    .use(rehypeBlockText, { blocks })
    .use(rehypeStringify);

  const file = await processorRehype.process(html);
  const data = file.data as AdocRenderData;

  const anchors = data.anchors ?? [];

  return {
    html: String(file),
    anchors,
    toc: buildToc(anchors),
    assets: data.assets ?? [],
    mermaid: data.mermaid ?? [],
    blocks,
    warnings: data.warnings ?? [],
    frontmatter,
  };
}

type AsciidoctorAbstractBlock = ReturnType<ReturnType<typeof Asciidoctor>['load']>;

interface WalkState {
  /**
   * Top-level blocks ONLY. `rehypeAsciidocBlockIds` resolves
   * `__marginalia-block-<idx>` markers via `blocks[idx]`, so this
   * array's indices must stay aligned with `counter`. Sub-block
   * BlockInfos go in `subBlockInfos` and are concatenated onto
   * `blocks` after the walk completes (so the exported BlockMap
   * still includes them for server-side reanchor).
   */
  blocks: BlockMap;
  counter: number;
  headingStack: Array<{ level: number; text: string }>;
  sectionCounts: Map<string, number>;
  subBlockCounts: Map<string, number>;
  subBlockCounter: number;
  subBlockEntries: SubBlockEntry[];
  /**
   * BlockInfo entries for sub-blocks. Kept separate from `blocks`
   * during the walk so positional marker lookups stay correct;
   * concatenated to the exported BlockMap at the end.
   */
  subBlockInfos: BlockInfo[];
}

/**
 * Walk the asciidoctor AST and emit a BlockMap mirroring what
 * remark-block-ids produces for markdown. Side-effect: attaches a marker
 * role (`__marginalia-block-<idx>`) on each top-level block and
 * `__marginalia-subblock-<idx>` on each list item, so the post-render
 * hast pass can find the corresponding HTML element and set
 * `data-block` / `data-subblock`.
 *
 * Sub-block BlockInfo entries are collected into a separate
 * `subBlockInfos` buffer during the walk so that positional marker
 * lookups (`blocks[idx]` in `rehypeAsciidocBlockIds`) only touch
 * top-level entries; they're appended to the exported `BlockMap`
 * after all top-level blocks have been recorded, preserving their
 * own relative order and inheriting their enclosing list's section
 * context.
 */
function walkBlocks(doc: AsciidoctorAbstractBlock): {
  blocks: BlockMap;
  subBlocks: SubBlockEntry[];
} {
  const state: WalkState = {
    blocks: [],
    counter: 0,
    headingStack: [],
    sectionCounts: new Map(),
    subBlockCounts: new Map(),
    subBlockCounter: 0,
    subBlockEntries: [],
    subBlockInfos: [],
  };
  walkTopLevel(doc, state);
  return {
    // Top-level entries first, then sub-block infos. Marker-index
    // lookups in `rehypeAsciidocBlockIds` only touch the top-level
    // prefix; reanchor's id-based lookup walks the whole array, so
    // sub-blocks at the tail are still discoverable.
    blocks: [...state.blocks, ...state.subBlockInfos],
    subBlocks: state.subBlockEntries,
  };
}

/**
 * Walk a list's items and emit sub-block BlockInfo for each, then
 * recurse into the items' descendants to find nested lists. All
 * descendants share the enclosing top-level list's section context.
 */
function emitListSubBlocks(
  list: AsciidoctorAbstractBlock,
  parent: BlockInfo,
  state: WalkState,
): void {
  const items =
    (list as { getItems?: () => AsciidoctorAbstractBlock[] | undefined }).getItems?.() ?? [];
  for (const item of items) {
    recordSubBlock(item, parent, state);
    descendForNestedLists(item, parent, state);
  }
}

function descendForNestedLists(
  block: AsciidoctorAbstractBlock,
  parent: BlockInfo,
  state: WalkState,
): void {
  for (const child of getChildren(block)) {
    if (!child || typeof (child as { getContext?: unknown }).getContext !== 'function') continue;
    const ctx = (child as { getContext: () => string }).getContext();
    if (ctx === 'ulist' || ctx === 'olist') {
      emitListSubBlocks(child, parent, state);
    } else {
      descendForNestedLists(child, parent, state);
    }
  }
}

function recordSubBlock(item: AsciidoctorAbstractBlock, parent: BlockInfo, state: WalkState): void {
  // list_item's own text lives in `getText()`, not `getContent()` (the
  // latter returns nested sub-block HTML and is empty for leaf items).
  const text = normalizeBlockText(getItemText(item));
  if (!text) return;
  // Use the mdast kind name (`listItem`) so asciidoc and markdown hashes
  // collide when the same text appears under the same kind. Not strictly
  // necessary (ids are local to one document) but keeps the block-id
  // derivation identical across formats, simplifying debugging.
  const id = computeSubBlockId('listItem', text, state.subBlockCounts);
  state.subBlockEntries.push({ id });
  // Inherit the enclosing list's section context so reanchor's
  // section-affinity scoring lines up with what the client computed
  // when the comment was created. Push to `subBlockInfos` rather
  // than `state.blocks` to keep positional marker indices intact.
  state.subBlockInfos.push({
    id,
    kind: 'listItem',
    text,
    headingPath: [...parent.headingPath],
    sectionIndex: parent.sectionIndex,
    sectionIndexPath: [...parent.sectionIndexPath],
  });
  const markerRole = `${MARGINALIA_SUBBLOCK_MARKER_PREFIX}${state.subBlockCounter}`;
  state.subBlockCounter += 1;
  addRole(item, markerRole);
}

function getItemText(item: AsciidoctorAbstractBlock): string {
  const fn = (item as { getText?: () => string | undefined }).getText;
  const raw = typeof fn === 'function' ? (fn.call(item) ?? '') : '';
  // getText() can return inline-formatted HTML (links, strong, etc.);
  // strip tags for the hash input.
  return stripTags(raw);
}

function walkTopLevel(block: AsciidoctorAbstractBlock, state: WalkState): void {
  const ctx = (block as { getContext(): string }).getContext();
  if (ctx === 'document' || ctx === 'preamble') {
    for (const child of getChildren(block)) walkTopLevel(child, state);
    return;
  }
  if (ctx === 'section') {
    emitSectionHeading(block, state);
    for (const child of getChildren(block)) walkTopLevel(child, state);
    return;
  }
  emitLeafBlock(block, ctx, state);
}

function emitSectionHeading(block: AsciidoctorAbstractBlock, state: WalkState): void {
  const level = getLevel(block);
  const title = getTitle(block) ?? '';
  const text = normalizeBlockText(title);
  // Keep the heading stack in mdast-parity: pop everything at-or-deeper
  // before pushing so `headingPath` reads root → current.
  while (
    state.headingStack.length > 0 &&
    state.headingStack[state.headingStack.length - 1]!.level >= level
  ) {
    state.headingStack.pop();
  }
  state.headingStack.push({ level, text });

  void recordBlock(block, 'heading', text, state);
}

function emitLeafBlock(block: AsciidoctorAbstractBlock, ctx: string, state: WalkState): void {
  // `[mermaid]` on a listing/literal block lands as a "style" in the AST
  // and is otherwise dropped from the HTML. Promote it to a role so the
  // mermaid role survives into the wrapper's class list, where the
  // rehype mermaid pass can find it.
  if (ctx === 'listing' || ctx === 'literal') {
    const style = getStyle(block);
    if (style === 'mermaid') addRole(block, 'mermaid');
  }
  if (ctx === 'thematic_break' || ctx === 'page_break') {
    void recordBlock(block, ctx, '', state);
    return;
  }
  const text = normalizeBlockText(extractBlockText(block));
  let info: BlockInfo | null = null;
  if (text) {
    info = recordBlock(block, ctx, text, state);
  }
  // Lists also get sub-block BlockInfo + marker roles for each item.
  // Even when the ulist itself doesn't yield useful text (asciidoctor
  // returns the children array, not a string, from getContent() on a
  // list), its items still need marker roles so the rehype pass can
  // attach data-subblock — fall back to a synthesized parent carrying
  // the current section context so sub-blocks inherit it.
  if (ctx === 'ulist' || ctx === 'olist') {
    const parent = info ?? synthesizeParent(state, ctx);
    emitListSubBlocks(block, parent, state);
    return;
  }
  // Other container leaf blocks (admonitions, sidebars, examples,
  // open/quote blocks, etc.) can hold lists too. walkTopLevel only
  // recurses into sections/preamble/document, so without descending
  // through their children here, sub-block markers wouldn't be
  // emitted for items inside `[NOTE] ==== * a * b ====` and friends.
  // Sub-block infos inherit the container's section context (the
  // recorded info if it was non-empty, else a synthesized one).
  const containerParent = info ?? synthesizeParent(state, ctx);
  descendForNestedLists(block, containerParent, state);
}

/**
 * Build a transient BlockInfo that carries the current section
 * context without mutating sectionCounts. Used as the inherited
 * parent for sub-blocks of a list whose own text couldn't be
 * extracted (and therefore wasn't recorded as a top-level block).
 */
function synthesizeParent(state: WalkState, kind: string): BlockInfo {
  const headingPath = state.headingStack.map((s) => s.text);
  const sectionIndexPath: number[] = [];
  for (let k = 0; k <= headingPath.length; k++) {
    // Same delimiter as recordBlock (NUL) so sectionCounts lookups
    // actually hit. A different separator here would silently miss
    // and force every entry to 0.
    const prefixKey = headingPath.slice(0, k).join('\u0000');
    sectionIndexPath.push(state.sectionCounts.get(prefixKey) ?? 0);
  }
  const sectionIndex = sectionIndexPath[sectionIndexPath.length - 1] ?? 0;
  return { id: '', kind, text: '', headingPath, sectionIndex, sectionIndexPath };
}

function getStyle(block: AsciidoctorAbstractBlock): string | null {
  const fn = (block as { getStyle?: () => string | undefined }).getStyle;
  if (typeof fn !== 'function') return null;
  return fn.call(block) ?? null;
}

function recordBlock(
  block: AsciidoctorAbstractBlock,
  kind: string,
  text: string,
  state: WalkState,
): BlockInfo {
  const headingPath = state.headingStack.map((s) => s.text);
  const sectionIndexPath: number[] = [];
  for (let k = 0; k <= headingPath.length; k++) {
    const prefixKey = headingPath.slice(0, k).join('\u0000');
    const n = state.sectionCounts.get(prefixKey) ?? 0;
    sectionIndexPath.push(n);
    state.sectionCounts.set(prefixKey, n + 1);
  }
  const sectionIndex = sectionIndexPath[sectionIndexPath.length - 1]!;
  const id = hashBlock(kind, text);

  const info: BlockInfo = {
    id,
    kind,
    text,
    headingPath,
    sectionIndex,
    sectionIndexPath,
  };
  state.blocks.push(info);

  const markerRole = `${MARGINALIA_BLOCK_MARKER_PREFIX}${state.counter}`;
  state.counter += 1;
  addRole(block, markerRole);
  return info;
}

function getChildren(block: AsciidoctorAbstractBlock): AsciidoctorAbstractBlock[] {
  const fn = (block as { getBlocks?: () => AsciidoctorAbstractBlock[] }).getBlocks;
  if (typeof fn !== 'function') return [];
  return fn.call(block) ?? [];
}

function getLevel(block: AsciidoctorAbstractBlock): number {
  const fn = (block as { getLevel?: () => number }).getLevel;
  return typeof fn === 'function' ? fn.call(block) : 1;
}

function getTitle(block: AsciidoctorAbstractBlock): string | null {
  const fn = (block as { getTitle?: () => string | undefined }).getTitle;
  if (typeof fn !== 'function') return null;
  return fn.call(block) ?? null;
}

/**
 * Best-effort plain-text extraction for a non-section block. Prefer the
 * rendered content (inline formatting resolved, cross-refs rewritten) and
 * strip tags; fall back to raw source lines. Matches the spirit of
 * mdast-util-to-string which reads children text out of the AST.
 */
function extractBlockText(block: AsciidoctorAbstractBlock): string {
  const contentFn = (block as { getContent?: () => string | undefined }).getContent;
  if (typeof contentFn === 'function') {
    try {
      const html = contentFn.call(block);
      if (typeof html === 'string' && html.length > 0) return stripTags(html);
    } catch {
      /* some block kinds throw on getContent; fall through */
    }
  }
  const sourceFn = (block as { getSource?: () => string | undefined }).getSource;
  if (typeof sourceFn === 'function') {
    const src = sourceFn.call(block);
    if (typeof src === 'string') return src;
  }
  const linesFn = (block as { getSourceLines?: () => string[] | undefined }).getSourceLines;
  if (typeof linesFn === 'function') {
    const lines = linesFn.call(block);
    if (Array.isArray(lines)) return lines.join('\n');
  }
  return '';
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function addRole(block: AsciidoctorAbstractBlock, role: string): void {
  const fn = (block as { addRole?: (r: string) => void }).addRole;
  if (typeof fn === 'function') {
    fn.call(block, role);
    return;
  }
  // Fallback: poke through setAttribute — older/some block types may
  // not have addRole. Asciidoctor reads `role` attribute when it renders.
  const attrFn = (block as { setAttribute?: (k: string, v: string) => void }).setAttribute;
  const getAttrFn = (block as { getAttribute?: (k: string) => string | undefined }).getAttribute;
  if (typeof attrFn === 'function') {
    const existing = typeof getAttrFn === 'function' ? (getAttrFn.call(block, 'role') ?? '') : '';
    const next = existing ? `${existing} ${role}` : role;
    attrFn.call(block, 'role', next);
  }
}

/**
 * AsciiDoc's document-header attributes (doctitle, author, revdate, plus
 * arbitrary `:key: value` declarations) are the closest analog to YAML
 * frontmatter in markdown. Asciidoctor blends ~80 built-in attributes
 * into the same `getAttributes()` bag as user-defined ones, so we diff
 * against a freshly-parsed empty document and only surface the deltas.
 */
let DEFAULT_ATTRS: Set<string> | null = null;
function defaultAttrKeys(): Set<string> {
  if (DEFAULT_ATTRS) return DEFAULT_ATTRS;
  const empty = asciidoctor.load('', { safe: 'safe', standalone: false });
  const attrs =
    (empty as { getAttributes?: () => Record<string, unknown> | undefined }).getAttributes?.() ??
    {};
  DEFAULT_ATTRS = new Set(Object.keys(attrs));
  return DEFAULT_ATTRS;
}

function extractFrontmatter(doc: AsciidoctorAbstractBlock): Record<string, unknown> {
  const fn = (doc as { getAttributes?: () => Record<string, unknown> | undefined }).getAttributes;
  if (typeof fn !== 'function') return {};
  const attrs = fn.call(doc) ?? {};
  const defaults = defaultAttrKeys();
  const out: Record<string, unknown> = {};
  const authorKeys = new Set([
    'doctitle',
    'author',
    'authors',
    'authorinitials',
    'firstname',
    'middlename',
    'lastname',
    'email',
    'revdate',
    'revnumber',
    'revremark',
  ]);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') continue;
    if (authorKeys.has(key)) {
      out[key] = value;
      continue;
    }
    if (defaults.has(key)) continue; // built-in, skip
    if (!/^[A-Za-z][\w-]*$/.test(key)) continue;
    out[key] = value;
  }
  const titleFn = (doc as { getDocumentTitle?: () => string | undefined }).getDocumentTitle;
  if (typeof titleFn === 'function') {
    const t = titleFn.call(doc);
    if (typeof t === 'string' && t.length > 0) out.title = t;
  }
  return out;
}

// Marker-prefix constants + SubBlockEntry live in `./asciidoc-markers.ts`
// so the block-ids plugin can import them without creating a circular
// dependency on this file. We use them above; external callers should
// import directly from `./asciidoc-markers.js`.

export type { HastRoot };
