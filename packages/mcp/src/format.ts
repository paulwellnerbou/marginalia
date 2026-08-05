import { createPatch } from 'diff';
import type { DocumentWire, ThreadWire, TocNodeWire } from './api-types.js';
import { clip, type DocumentBlock, type DocumentBlockMap } from './blocks.js';
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

export function documentHeader(doc: DocumentWire, ref: DocumentRef): string {
  const lines = [
    `document: ${doc.name ?? '(untitled)'}`,
    `uid: ${doc.uid}`,
    `url: ${documentUrl(ref)}`,
    `format: ${doc.format}`,
    `your role: ${doc.role}${roleHint(doc.role)}`,
    `password protected: ${doc.password_protected ? 'yes' : 'no'}`,
    `updated: ${timestamp(doc.updated_at)}`,
    `source length: ${doc.source.length} chars, ${doc.source.split('\n').length} lines`,
    `blocks: ${doc.rendered.blocks.length}`,
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

export function outline(toc: TocNodeWire[]): string {
  const lines: string[] = [];
  const walk = (nodes: TocNodeWire[], depth: number): void => {
    for (const node of nodes) {
      lines.push(`${'  '.repeat(depth)}- ${node.text}  (#${node.id})`);
      walk(node.children, depth + 1);
    }
  };
  walk(toc, 0);
  return lines.length > 0 ? lines.join('\n') : '(no headings)';
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
  const block = anchor.block_id
    ? (options.blockMap?.blocks.find((b) => b.id === anchor.block_id) ?? null)
    : null;
  const where = block
    ? `${block.kind}, lines ${block.startLine}-${block.endLine}, section ${
        block.headingPath.length > 0 ? block.headingPath.join(' › ') : '(document root)'
      }`
    : anchor.heading_path?.length
      ? `section ${anchor.heading_path.join(' › ')}`
      : 'unknown location';
  lines.push(
    `anchor: block_id=${anchor.block_id ?? 'none'} (${where}) link_status=${thread.link_status}`,
  );
  if (anchor.quote) lines.push(`quoted text: ${JSON.stringify(clip(anchor.quote, 240))}`);
  if (thread.proposal?.whole_document) lines.push('scope: replaces the WHOLE document on accept');
  if (thread.resolution) {
    lines.push(
      `${thread.resolution.kind}ed by ${thread.resolution.by_name ?? 'unknown'} at ${timestamp(thread.resolution.at)}`,
    );
  }
  lines.push(`you can: ${enabledCapabilities(thread)}`);

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

  if (thread.proposal) {
    lines.push('proposal — current text:');
    lines.push(gutter(thread.proposal.source_snapshot ?? '(unavailable)'));
    lines.push('proposal — proposed replacement:');
    lines.push(gutter(thread.proposal.proposed_text ?? '(unavailable)'));
  } else if (options.includeAnchorSource && block?.source != null) {
    lines.push('current source of the anchored block:');
    lines.push(gutter(block.source));
  }

  return lines.join('\n');
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
