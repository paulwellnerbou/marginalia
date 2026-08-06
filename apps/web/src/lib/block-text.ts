/**
 * Reading a block's text the way the server's block map sees it.
 *
 * The rendered DOM carries chrome that has no counterpart in the source:
 * the rehype `#` permalink sigil and the runtime fold toggle, both
 * grafted into headings. The server builds its block map from mdast,
 * where neither exists, so any client-side text used to talk to the
 * server — heading paths, anchor offsets — has to leave them out or it
 * describes a document the server never saw.
 */

export const INJECTED_CHROME_SELECTOR = '.heading-anchor, .heading-collapse-toggle';

export function isInjectedChromeText(node: Text): boolean {
  return node.parentElement?.closest(INJECTED_CHROME_SELECTOR) != null;
}

export function normalizeWs(s: string): string {
  return s.replace(/\s+/gu, ' ').trim();
}

/** `el`'s normalized text, minus the injected chrome. */
export function blockTextOf(el: HTMLElement): string {
  if (!el.querySelector(INJECTED_CHROME_SELECTOR)) return normalizeWs(el.textContent ?? '');
  let raw = '';
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      raw += node.nodeValue ?? '';
    } else if (node instanceof HTMLElement && !node.matches(INJECTED_CHROME_SELECTOR)) {
      raw += node.textContent ?? '';
    }
  }
  return normalizeWs(raw);
}
