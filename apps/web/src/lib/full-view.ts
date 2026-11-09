/**
 * Full view: the document, its contents and its comments, without the
 * app around them. Carried in the address bar (`?view=full`) so a link
 * can open straight into it.
 */

export const FULL_VIEW_PARAM = 'view';
export const FULL_VIEW_VALUE = 'full';

export function isFullViewSearch(search: string): boolean {
  return new URLSearchParams(search).get(FULL_VIEW_PARAM) === FULL_VIEW_VALUE;
}

/** `search` with full view switched on or off; other parameters are kept. */
export function withFullView(search: string, on: boolean): string {
  const params = new URLSearchParams(search);
  if (on) params.set(FULL_VIEW_PARAM, FULL_VIEW_VALUE);
  else if (params.get(FULL_VIEW_PARAM) === FULL_VIEW_VALUE) params.delete(FULL_VIEW_PARAM);
  const next = params.toString();
  return next ? `?${next}` : '';
}

/** An absolute link with full view switched on or off. */
export function linkWithFullView(href: string, on: boolean): string {
  const url = new URL(href);
  url.search = withFullView(url.search, on);
  return url.href;
}

/**
 * Rewrites the address in place. Replaced rather than pushed: the router
 * does not know this location, and a Back step into it would hand the
 * router a history entry it never made.
 */
export function writeFullViewToUrl(on: boolean): void {
  const { pathname, search, hash } = window.location;
  const nextSearch = withFullView(search, on);
  if (nextSearch === search) return;
  window.history.replaceState(window.history.state, '', `${pathname}${nextSearch}${hash}`);
}
