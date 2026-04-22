import type { CommentRow } from '../db.js';

/**
 * Shared comment serialization helper.
 *
 * The public API now lives on `threadsRouter`. This module remains as the
 * canonical mapping from a comment row to the legacy comment wire shape used
 * by realtime events and proposal helpers.
 */

function parseHeadingPath(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : null;
  } catch {
    return null;
  }
}

function parseIntArray(raw: string | null): number[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : null;
  } catch {
    return null;
  }
}

export function toWire(row: CommentRow): Record<string, unknown> {
  const hasAnchor = row.parent_id === null && row.parent_proposal_id === null;
  return {
    id: row.id,
    parent_id: row.parent_id,
    parent_proposal_id: row.parent_proposal_id,
    anchor: hasAnchor
      ? {
          block_id: row.anchor_block_id,
          quote: row.anchor_quote,
          prefix: row.anchor_prefix,
          suffix: row.anchor_suffix,
          start_offset: row.anchor_start_offset,
          end_offset: row.anchor_end_offset,
          heading_path: parseHeadingPath(row.anchor_heading_path),
          section_index: row.anchor_section_index,
          section_index_path: parseIntArray(row.anchor_section_index_path),
        }
      : null,
    author: { client_id: row.author_client_id, display_name: row.author_display_name },
    body: row.body,
    link_status: hasAnchor ? row.link_status : null,
    resolved_at: row.resolved_at,
    resolved_by_name: row.resolved_by_name,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
