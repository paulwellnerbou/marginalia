import type { ProposalStatus } from '../../lib/api.js';

/**
 * An open proposal's text can change in place, making a displayed diff
 * stale. Closed proposal payloads deliberately omit that text, though, so
 * their string -> null transition must not evict the diff just before the
 * dialog closes.
 */
export function proposalDiffNeedsRefresh(
  status: ProposalStatus,
  previousText: string | null,
  currentText: string | null,
): boolean {
  return status === 'open' && previousText !== currentText;
}
