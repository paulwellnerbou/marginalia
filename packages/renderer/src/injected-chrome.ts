/**
 * Chrome grafted into the rendered document that is not part of the
 * document: the rehype `#` permalink sigil, the fold toggle the viewer
 * injects at runtime, and the card that stands in for an image whose bytes
 * are missing.
 *
 * Both sides of comment anchoring read block text off the rendered tree —
 * the server in `plugins/block-text.ts`, the browser in the web app's
 * `blockTextOf` — and both have to skip exactly these. A class only one side
 * knew about would put the two texts back out of step by its own length, so
 * the list lives here, on its own, with nothing else to import.
 *
 * `missing-asset` is the one the server cannot see at all: the placeholder
 * is built in the browser, only for refs that fail to resolve, and carries
 * roughly fifty characters of label. Skipping it leaves the paragraph
 * reading as the empty string the server has for it — which is what an
 * image contributes to text either way.
 */

export const INJECTED_CHROME_CLASSES: readonly string[] = [
  'heading-anchor',
  'heading-collapse-toggle',
  'missing-asset',
];

export const INJECTED_CHROME_SELECTOR = INJECTED_CHROME_CLASSES.map((c) => `.${c}`).join(', ');
