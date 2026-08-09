/**
 * True on Apple's engine — Safari, and every browser on iOS and iPadOS,
 * which are all WebKit underneath.
 *
 * Sniffing an engine is a last resort, and it is kept for the two places
 * where what is being detected is a silent rendering bug with nothing to
 * feature-detect: paginated columns that lay out correctly and never
 * paint, and `text-indent` landing on the wrong line after inline content
 * is spliced into a paragraph. Both need real work to steer around, and
 * neither workaround is worth paying for on an engine that renders the
 * page correctly.
 */
export function isAppleWebKit(): boolean {
  return /^Apple/.test(navigator.vendor ?? '');
}
