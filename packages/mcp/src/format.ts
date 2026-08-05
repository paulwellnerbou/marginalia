import { createPatch } from 'diff';
import type { DocumentWire, ThreadWire } from './api-types.js';
import {
  anchorNeighbourhood,
  clip,
  type DocumentBlock,
  type DocumentBlockMap,
  type DocumentSection,
} from './blocks.js';
import type { DocumentRef } from './document-ref.js';
import { documentUrl } from './document-ref.js';

/**
 * Human-and-model-readable rendering of the API's payloads.
 *
 * Everything here is plain text rather than JSON: threads and blocks
 * carry multi-line prose, and JSON escaping turns a readable paragraph
 * into a wall of `\n`. Verbatim text is quoted with a `| ` gutter so
 * structure markers can never be confused with content.
 */

export function gutter(text: string, prefix = '  | '): string {
  if (text === '') return `${prefix}(empty)`;
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

export function timestamp(ms: number | null | undefined): string {
  if (!ms) return 'unknown time';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function documentHeader(doc: DocumentWire, ref: DocumentRef, map: DocumentBlockMap): string {
  const lines = [
    `document: ${doc.name ?? '(untitled)'}`,
    `uid: ${doc.uid}`,
    `url: ${documentUrl(ref)}`,
    `format: ${doc.format}`,
    `your role: ${doc.role}${roleHint(doc.role)}`,
    `password protected: ${doc.password_protected ? 'yes' : 'no'}`,
    `updated: ${timestamp(doc.updated_at)}`,
    `whole document: ${size(doc.source)}`,
    `blocks: ${map.blocks.length}, sections: ${map.sections.length}`,
  ];
  if (doc.attached_assets.length > 0) {
    lines.push(
      `assets: ${doc.attached_assets.map((a) => `${a.ref_name} (${a.mime}, ${a.size}B)`).join(', ')}`,
    );
  }
  const warnings = doc.rendered.warnings ?? [];
  if (warnings.length > 0) {
    lines.push(
      `render warnings: ${warnings.map((w) => `${w.kind}${w.line ? `@${w.line}` : ''}: ${w.message}`).join('; ')}`,
    );
  }
  return lines.join('\n');
}

function roleHint(role: string): string {
  switch (role) {
    case 'reader':
      return ' (read-only — you cannot comment or propose; ask for a collaborator invite link)';
    case 'collaborator':
      return ' (can comment and create edit proposals, but not accept them)';
    case 'editor':
      return ' (can comment, propose, edit the source, and accept/reject proposals)';
    case 'admin':
      // Marginalia re-labels an admin link with the display name of
      // whoever uses it, so an agent working through the owner's own
      // link quietly renames it. Worth one line of warning.
      return (
        ' (full control — this is the document’s admin link. Marginalia relabels an admin link ' +
        'with the name of whoever uses it, so working through it renames the owner’s link. For ' +
        'ongoing work ask for a dedicated editor link instead: create_invite.)'
      );
    default:
      return '';
  }
}

/**
 * The document's sections with their size, so a caller can decide what
 * to read before paying for it. Each line is addressable: the heading
 * text (or its slug) is what `section` takes.
 */
export function outline(sections: DocumentSection[]): string {
  if (sections.length === 0) return '(no headings — this document has no sections)';
  const lines = sections.map((section) => {
    const indent = '  '.repeat(section.depth - 1);
    const slug = section.slug ? `  #${section.slug}` : '';
    return (
      `${indent}- ${section.heading}${slug}\n` +
      `${indent}    lines ${section.startLine}-${section.endLine}, ${size(section.source)}`
    );
  });
  // Text before the first heading belongs to no section, so a caller
  // reading section by section would never see it. Say so rather than
  // let it disappear.
  const preamble = (sections[0] as DocumentSection).start;
  if (preamble > 0) {
    lines.unshift(
      `(${preamble} chars before the first heading are outside every section — read the whole ` +
        'document to see them)',
    );
  }
  return lines.join('\n');
}

export function sectionHeader(section: DocumentSection): string {
  return [
    `section: ${section.path.join(' › ')}`,
    section.slug ? `slug: #${section.slug}` : null,
    `lines ${section.startLine}-${section.endLine}, ${size(section.source)}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function size(text: string): string {
  const chars = text.length;
  const lines = text.split('\n').length;
  const human = chars >= 1000 ? `${(chars / 1000).toFixed(1)}k chars` : `${chars} chars`;
  return `${human}, ${lines} lines`;
}

export interface BlockListOptions {
  includeSource: boolean;
  sourceLimit: number;
}

export function blockList(
  blocks: DocumentBlock[],
  total: number,
  options: BlockListOptions,
): string {
  if (blocks.length === 0) return 'No blocks matched.';
  const parts = blocks.map((block) => {
    const location =
      block.startLine !== null
        ? `lines ${block.startLine}-${block.endLine}`
        : 'source range unknown';
    const heading =
      block.headingPath.length > 0 ? block.headingPath.join(' › ') : '(document root)';
    const head =
      `#${block.index} block_id=${block.id}\n` +
      `  kind: ${block.kind}  ${location}\n` +
      `  section: ${heading}`;
    if (!options.includeSource) return `${head}\n  text: ${clip(block.text, 160)}`;
    if (block.source === null) {
      return `${head}\n  source: unavailable locally\n  text: ${clip(block.text, 200)}`;
    }
    const source =
      block.source.length > options.sourceLimit
        ? `${block.source.slice(0, options.sourceLimit)}\n…(truncated, ${block.source.length} chars total)`
        : block.source;
    return `${head}\n  source:\n${gutter(source)}`;
  });
  return `${blocks.length} of ${total} blocks\n\n${parts.join('\n\n')}`;
}

export interface ThreadListOptions {
  /** Include the anchored block's current source under each thread. */
  includeAnchorSource: boolean;
  /** Whole blocks of surrounding source to add either side of it. */
  contextBlocks: number;
  blockMap: DocumentBlockMap | null;
}

export function threadList(threads: ThreadWire[], options: ThreadListOptions): string {
  if (threads.length === 0) return 'No threads matched.';
  return threads
    .map((thread, i) => threadDetail(thread, i + 1, threads.length, options))
    .join('\n\n');
}

export function threadDetail(
  thread: ThreadWire,
  position: number,
  total: number,
  options: ThreadListOptions,
): string {
  const kind = thread.proposal ? 'EDIT PROPOSAL' : 'COMMENT THREAD';
  const status = threadStatus(thread);
  const lines: string[] = [];
  lines.push(`=== ${kind} ${position}/${total} — ${status} ===`);
  lines.push(`thread_id: ${thread.id}`);

  const anchor = thread.anchor;
  const findBlock = (id: string | null): DocumentBlock | null =>
    id ? (options.blockMap?.blocks.find((b) => b.id === id) ?? null) : null;
  const block = findBlock(anchor.block_id);
  // A comment can cover several blocks, and the anchor records only its
  // two endpoints. Showing the first alone would present a fragment of
  // the quote as the whole of it.
  //
  // The span is read from the anchor, not from what resolved: a document
  // edited since keeps the id but loses the block, and a span that
  // printed as single-block there would hide the reason its quote looks
  // truncated.
  const spanEndId =
    anchor.end_block_id && anchor.end_block_id !== anchor.block_id ? anchor.end_block_id : null;
  const endBlock = spanEndId ? findBlock(spanEndId) : null;
  const where = block
    ? `${blockSpan(block, endBlock, spanEndId !== null)}, section ${
        block.headingPath.length > 0 ? block.headingPath.join(' › ') : '(document root)'
      }`
    : anchor.heading_path?.length
      ? `section ${anchor.heading_path.join(' › ')}`
      : 'unknown location';
  lines.push(
    `anchor: block_id=${anchor.block_id ?? 'none'}${
      spanEndId ? ` end_block_id=${spanEndId}` : ''
    } (${where}) link_status=${thread.link_status}`,
  );
  if (anchor.quote) lines.push(`quoted text: ${JSON.stringify(clip(anchor.quote, 240))}`);
  if (thread.proposal?.whole_document) lines.push('scope: replaces the WHOLE document on accept');
  if (thread.resolution) {
    lines.push(
      `${thread.resolution.kind}ed by ${thread.resolution.by_name ?? 'unknown'} at ${timestamp(thread.resolution.at)}`,
    );
  }
  lines.push(`you can: ${enabledCapabilities(thread)}`);
  // Both ends of the comment → proposal link, so a reader of either
  // thread can find the other without a second call.
  if (thread.proposal?.answers_thread_id) {
    lines.push(`answers comment thread: ${thread.proposal.answers_thread_id}`);
  }
  if (thread.answered_by_thread_ids.length > 0) {
    lines.push(`answered by proposal(s): ${thread.answered_by_thread_ids.join(', ')}`);
  }

  lines.push('messages:');
  thread.comments.forEach((comment, index) => {
    const role = index === 0 ? 'opener' : `reply ${index}`;
    lines.push(
      `  [${role}] ${comment.author.display_name} · ${timestamp(comment.created_at)} · comment_id=${comment.id}`,
    );
    lines.push(gutter(comment.body, '    | '));
    if (comment.reactions.length > 0) {
      lines.push(
        `    reactions: ${comment.reactions.map((r) => `${r.emoji}×${r.count}`).join(' ')}`,
      );
    }
  });

  const around =
    options.includeAnchorSource && options.blockMap && block
      ? anchorNeighbourhood(options.blockMap, block, endBlock, options.contextBlocks)
      : null;
  if (around?.before) {
    lines.push(`source before the anchor (${plural(around.beforeBlocks, 'block')}):`);
    lines.push(gutter(around.before));
  }
  if (thread.proposal) {
    lines.push('proposal — current text:');
    lines.push(gutter(thread.proposal.source_snapshot ?? '(unavailable)'));
    lines.push('proposal — proposed replacement:');
    lines.push(gutter(thread.proposal.proposed_text ?? '(unavailable)'));
  } else if (around) {
    lines.push(`${anchoredSourceLabel(endBlock !== null, spanEndId !== null)}:`);
    lines.push(gutter(around.anchored));
  }
  if (around?.after) {
    lines.push(`source after the anchor (${plural(around.afterBlocks, 'block')}):`);
    lines.push(gutter(around.after));
  }

  return lines.join('\n');
}

/**
 * What the source printed underneath actually covers.
 *
 * A span whose end block is gone can only be shown from its start, while
 * the quote above it covers more. Left as "the anchored block" that
 * reads as the whole of it, and the missing text looks like a
 * discrepancy in the quote rather than in the document.
 */
function anchoredSourceLabel(spanResolved: boolean, isSpan: boolean): string {
  if (spanResolved) return 'current source of the anchored blocks';
  if (isSpan) {
    return 'current source of the anchored block — the START of the span only, since its end block is not in this document';
  }
  return 'current source of the anchored block';
}

/**
 * "paragraph, lines 4-6", or both endpoints when the anchor spans blocks.
 *
 * A block the local source walk could not place has no line numbers, and
 * a range defaulted to 0 would read as a real location in the document.
 * Say the range is unknown instead.
 */
function blockSpan(first: DocumentBlock, last: DocumentBlock | null, spanned: boolean): string {
  if (!spanned) return `${first.kind}, ${lineRange(first.startLine, first.endLine)}`;
  if (!last) return `${first.kind}…? span, end block not in this document`;
  return `${first.kind}…${last.kind} span, ${lineRange(
    bound(first.startLine, last.startLine, Math.min),
    bound(first.endLine, last.endLine, Math.max),
  )}`;
}

function lineRange(from: number | null, to: number | null): string {
  return from === null || to === null ? 'source range unknown' : `lines ${from}-${to}`;
}

/** Null when either endpoint is unplaced — half a range would understate the span. */
function bound(
  a: number | null,
  b: number | null,
  pick: (x: number, y: number) => number,
): number | null {
  return a === null || b === null ? null : pick(a, b);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function threadStatus(thread: ThreadWire): string {
  if (!thread.proposal) return thread.state === 'open' ? 'open' : 'resolved';
  if (thread.state === 'open') return 'open';
  if (thread.resolution?.kind === 'accept') return 'accepted';
  if (thread.resolution?.kind === 'reject') return 'rejected';
  return 'closed';
}

function enabledCapabilities(thread: ThreadWire): string {
  const enabled = Object.entries(thread.capabilities)
    .filter(([, allowed]) => allowed)
    .map(([name]) => name);
  const nodes = thread.comments
    .filter((c) => c.capabilities.edit || c.capabilities.delete)
    .map((c) => `${c.capabilities.edit ? 'edit' : 'delete'} ${c.id}`);
  const all = [...enabled, ...nodes];
  return all.length > 0 ? all.join(', ') : 'nothing (read-only access)';
}

/**
 * Unified diff, so a change can be checked without re-reading both
 * versions in full. Context is kept tight because whole-document
 * proposals would otherwise echo the entire book back.
 */
export function lineDiff(before: string, after: string): string {
  const patch = createPatch('document', before, after, '', '', { context: 3 });
  // Drop jsdiff's file header — there is no file here, just two strings.
  const body = patch.split('\n').slice(4).join('\n').trimEnd();
  return body || '(no textual difference)';
}
