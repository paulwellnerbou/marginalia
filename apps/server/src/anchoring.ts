import type { BlockInfo } from '@markdowner/renderer';
import type { CommentRow, CommentStatus } from './db.js';

/**
 * Re-anchor a stored comment against a fresh block map.
 *
 * Outcomes (REQUIREMENTS §3.6):
 * - 'active'          — block with same ID still contains the quote
 * - 'low-confidence'  — quote found elsewhere (different block, or shifted
 *                       within the same block); client should flag for confirmation
 * - 'orphaned'        — no match found; comment preserved but surfaces in
 *                       the orphaned list
 *
 * Replies (parent_id !== null) inherit their parent's status — we don't
 * re-anchor them independently.
 */
export interface AnchorUpdate {
  status: CommentStatus;
  blockId: string | null;
  startOffset: number | null;
  endOffset: number | null;
}

export function reanchor(comment: CommentRow, blocks: BlockInfo[]): AnchorUpdate {
  const quote = comment.anchor_quote;
  if (!quote) {
    return noop(comment);
  }

  const byId = new Map<string, BlockInfo>();
  for (const b of blocks) byId.set(b.id, b);

  // 1. Block with same ID: quote still present? confident.
  const sameBlock = comment.anchor_block_id ? byId.get(comment.anchor_block_id) : undefined;
  if (sameBlock) {
    const idx = sameBlock.text.indexOf(quote);
    if (idx >= 0) {
      return {
        status: 'active',
        blockId: sameBlock.id,
        startOffset: idx,
        endOffset: idx + quote.length,
      };
    }
    // Block survives but quote is gone or partial — low-confidence if at
    // least 70% of the quote survives as a contiguous substring.
    const partial = longestCommonSubstringLength(sameBlock.text, quote);
    if (partial >= quote.length * 0.7) {
      return {
        status: 'low-confidence',
        blockId: sameBlock.id,
        startOffset: null,
        endOffset: null,
      };
    }
  }

  // 2. Quote present in a different block? low-confidence.
  for (const b of blocks) {
    if (b.id === comment.anchor_block_id) continue;
    const idx = b.text.indexOf(quote);
    if (idx >= 0) {
      return {
        status: 'low-confidence',
        blockId: b.id,
        startOffset: idx,
        endOffset: idx + quote.length,
      };
    }
  }

  // 3. prefix + quote + suffix fuzzy search anywhere.
  const context =
    (comment.anchor_prefix ?? '') + quote + (comment.anchor_suffix ?? '');
  if (context.length > quote.length) {
    for (const b of blocks) {
      const idx = b.text.indexOf(context);
      if (idx >= 0) {
        const start = idx + (comment.anchor_prefix?.length ?? 0);
        return {
          status: 'low-confidence',
          blockId: b.id,
          startOffset: start,
          endOffset: start + quote.length,
        };
      }
    }
  }

  // 4. Orphaned — no match.
  return { status: 'orphaned', blockId: null, startOffset: null, endOffset: null };
}

function noop(comment: CommentRow): AnchorUpdate {
  return {
    status: comment.status,
    blockId: comment.anchor_block_id,
    startOffset: comment.anchor_start_offset,
    endOffset: comment.anchor_end_offset,
  };
}

/**
 * Length of the longest contiguous substring appearing in both inputs.
 * Used as a cheap fuzzy-similarity metric — no diff-match-patch dependency.
 */
function longestCommonSubstringLength(a: string, b: string): number {
  if (!a || !b) return 0;
  const la = a.length;
  const lb = b.length;
  // Use two rolling rows to stay O(min(la, lb)) memory.
  let prev = new Array<number>(lb + 1).fill(0);
  let curr = new Array<number>(lb + 1).fill(0);
  let best = 0;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : 0;
      if (curr[j]! > best) best = curr[j]!;
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  return best;
}
