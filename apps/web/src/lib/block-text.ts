/**
 * Reading a block's text the way the server's block map sees it.
 *
 * The rendered DOM carries chrome that has no counterpart in the document:
 * the rehype `#` permalink sigil and the runtime fold toggle, both grafted
 * into headings. The server reads its block text off the same rendered tree
 * (`rehypeBlockText`) and skips the same chrome, so the selector is imported
 * rather than restated — a class that only one side knew about would put the
 * two texts back out of step.
 */

import { INJECTED_CHROME_SELECTOR } from '@marginalia/renderer/injected-chrome';

export { INJECTED_CHROME_SELECTOR };

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
 * ever lives under a heading, so most blocks answer no and fall straight
 * through to `textContent`. Testing the block's own tag name instead would
 * be cheaper but wrong — headings nest inside blockquotes and list items,
 * and the plugin decorates those too.
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

/**
 * Every block's text in rendered `html`, as the server's block map reads
 * it: the text an anchor's quote has to match when the server re-anchors
 * it after a save. The source-range parser's `text` is the markdown AST's
 * reading, which runs list items together; a quote taken from it matches
 * nothing and orphans the anchor on the next save.
 */
export function renderedBlockTexts(html: string): Map<string, string> {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const texts = new Map<string, string>();
  for (const el of parsed.querySelectorAll<HTMLElement>('[data-block]')) {
    const id = el.dataset.block;
    if (id && !texts.has(id)) texts.set(id, blockTextOf(el));
  }
  return texts;
}
