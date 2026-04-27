/**
 * App-wide timestamp formatters. Single source of truth so the
 * comment side panes, history list, and home-page card metadata
 * all render the same way.
 *
 * Built on `Intl.DateTimeFormat` — that *is* the localization
 * primitive every modern date library wraps. For the two compact
 * formats this app needs, a library would be bundle weight without
 * functional gain.
 *
 * Formatter instances are constructed once at module load and
 * reused — `Intl.DateTimeFormat` construction is the expensive
 * part, and re-creating one per call would show up in tight loops
 * (every comment / history row / doc card re-renders one call).
 */

const sameDayFormatter = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
});

const sameYearFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

const olderFormatter = new Intl.DateTimeFormat(undefined, {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

const longFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
});

/**
 * Compact, scrolling-list-friendly timestamp.
 *   - same day → "10:21"
 *   - same year → "4 Mar, 10:21"
 *   - older → "4 Mar 2025"
 */
export function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return sameDayFormatter.format(d);
  if (d.getFullYear() === now.getFullYear()) return sameYearFormatter.format(d);
  return olderFormatter.format(d);
}

/** Tooltip-style full-detail timestamp. */
export function formatTimestampLong(ts: number): string {
  return longFormatter.format(new Date(ts));
}
