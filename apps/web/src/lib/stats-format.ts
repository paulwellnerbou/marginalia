/**
 * How the statistics dialog spells its numbers. Pure so the rounding
 * rules can be tested; `locale` exists for the tests, the app leaves it
 * to the browser.
 */

export function formatCount(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n);
}

/**
 * Pages at `wordsPerPage` a page. One decimal below ten pages, where a
 * whole page is too coarse for a section, whole pages above.
 */
export function formatPages(words: number, wordsPerPage: number, locale?: string): string {
  if (words === 0) return '0';
  const pages = words / wordsPerPage;
  if (pages < 0.05) return '< 0.1';
  if (pages < 10) {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(pages);
  }
  return formatCount(pages, locale);
}

/** Minutes at `wordsPerMinute`, as `< 1 min`, `12 min`, `1 h 5 min` or `2 h`. */
export function formatReadingTime(words: number, wordsPerMinute: number): string {
  if (words === 0) return '0 min';
  const minutes = words / wordsPerMinute;
  if (minutes < 1) return '< 1 min';
  if (minutes < 59.5) return `${Math.round(minutes)} min`;
  const rounded = Math.round(minutes);
  const hours = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** `part` as a share of `total`, rounded, with `< 1%` for a sliver. */
export function formatShare(part: number, total: number): string {
  if (total === 0 || part <= 0) return '0%';
  const percent = (part / total) * 100;
  if (percent < 0.5) return '< 1%';
  return `${Math.round(percent)}%`;
}
