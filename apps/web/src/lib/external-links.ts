/**
 * Links that leave the app open in a new browser tab.
 *
 * Document and comment HTML comes from authors, so the links carry no
 * `target`; a plain click would replace the reader — and in the installed
 * PWA, swap the app window for someone else's site with no way back.
 */

/** The URL to open externally, or null when the link should behave as it does. */
export function externalLinkUrl(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === origin) return null;
  return url.href;
}

export function installExternalLinkHandler(): void {
  document.addEventListener('click', (e) => {
    // A modified click already opens a tab or window of the user's choosing,
    // and a handler that prevented the default (thread highlights) owns it.
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const link = (e.target as Element | null)?.closest?.('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;
    if (link.hasAttribute('target') || link.hasAttribute('download')) return;
    const url = externalLinkUrl(link.href, window.location.origin);
    if (!url) return;
    e.preventDefault();
    window.open(url, '_blank', 'noopener,noreferrer');
  });
}
