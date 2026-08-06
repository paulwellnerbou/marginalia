/**
 * Reading a block's text the way the server's block map sees it.
 *
 * The rendered DOM carries chrome that has no counterpart in the source:
 * the rehype `#` permalink sigil and the runtime fold toggle, both
 * grafted into headings, and the `↩` backreference that
 * mdast-util-to-hast appends to every footnote definition when it
 * gathers them into the footnotes section. The server builds its block
 * map from mdast, where none of these exist, so any client-side text
 * used to talk to the server — heading paths, anchor offsets — has to
 * leave them out or it describes a document the server never saw.
 */

export const INJECTED_CHROME_SELECTOR =
  '.heading-anchor, .heading-collapse-toggle, [data-footnote-backref]';

export function isInjectedChromeText(node: Text): boolean {
  return node.parentElement?.closest(INJECTED_CHROME_SELECTOR) != null;
}

export function normalizeWs(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

/**
 * `el`'s normalized text, minus the injected chrome.
 *
 * The `querySelector` guard is the fast path, not overhead: chrome only
 * ever lives under a heading or a footnote definition, so most blocks
 * answer no and fall straight through to `textContent`. Testing the
 * block's own tag name instead would be cheaper but wrong — headings nest
 * inside blockquotes and list items, and the plugin decorates those too.
 */
export function blockTextOf(el: HTMLElement): string {
  if (!el.querySelector(INJECTED_CHROME_SELECTOR)) return normalizeWs(el.textContent ?? '');
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      (node.parentElement as HTMLElement | null)?.closest(INJECTED_CHROME_SELECTOR)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let raw = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    raw += (node as Text).data;
  }
  return normalizeWs(raw);
}
