/**
 * Wraps the content under each heading so the reader can collapse /
 * expand sections by clicking a chevron.
 *
 * The renderer emits two heading shapes — Markdown's flat siblings
 * (`<h2>` then sibling content) and AsciiDoc's nested
 * `<div class="sectN">` containers. For each heading we gather the
 * following siblings (within whatever element is the heading's parent)
 * up to the next heading at the same-or-higher level, and move them
 * into a `.collapse-section` wrapper. Iterating in document order
 * makes deeper sections naturally end up nested inside their
 * ancestor's wrapper.
 *
 * The animation uses `grid-template-rows: 1fr ↔ 0fr`. The inner uses
 * `clip-path: inset(0 -2em)` instead of `overflow: hidden` so
 * heading-anchor `#` sigils (positioned at `left: -0.9em` of each
 * heading) aren't cropped — per-axis overflow values get coerced to
 * `auto` when one side is `visible`, so `clip-path` is the only clean
 * way to keep the vertical clip while allowing horizontal slack.
 */

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const INSTALLED_ATTR = 'data-collapse-installed';

const CHEVRON_SVG = `<svg viewBox="0 0 15 15" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6.1584 3.13508C6.35985 2.94621 6.67627 2.95642 6.86514 3.15788L10.6151 7.15788C10.7954 7.3502 10.7954 7.64949 10.6151 7.84182L6.86514 11.8418C6.67627 12.0433 6.35985 12.0535 6.1584 11.8646C5.95694 11.6757 5.94673 11.3593 6.1356 11.1579L9.565 7.49985L6.1356 3.84182C5.94673 3.64036 5.95694 3.32394 6.1584 3.13508Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/></svg>`;

function headingLevel(node: Node): number | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const tag = (node as Element).tagName;
  if (!HEADING_TAGS.has(tag)) return null;
  return Number.parseInt(tag.slice(1), 10);
}

/**
 * Heading level of an AsciiDoc-style `<div class="sectN">` container,
 * or `null` if `node` isn't one. The check is deliberately narrow
 * (DIV with `sectN` class whose first direct child is a heading) so
 * a Markdown blockquote like `> ## inside` doesn't falsely terminate
 * the parent section's collection.
 */
const SECTION_DIV_CLASS_RE = /(?:^|\s)sect\d+(?:\s|$)/;
function sectionContainerHeadingLevel(node: Node): number | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  if (el.tagName !== 'DIV' || !SECTION_DIV_CLASS_RE.test(el.className)) return null;
  for (const child of el.children) {
    if (HEADING_TAGS.has(child.tagName)) {
      return Number.parseInt(child.tagName.slice(1), 10);
    }
  }
  return null;
}

/** Idempotent: an attribute-based marker is more robust than a
 * class-based check, which could false-positive on user-authored
 * content that happens to reuse the class name.
 */
export function installHeadingCollapse(article: HTMLElement): void {
  if (article.getAttribute(INSTALLED_ATTR) === 'true') return;
  article.setAttribute(INSTALLED_ATTR, 'true');

  const headings = Array.from(article.querySelectorAll<HTMLElement>(HEADING_SELECTOR));

  // Skip the opening h1 (and only the opening h1) — wrapping it
  // re-parents its siblings, which breaks AsciiDoc's
  // `#header > #toc.toc2` and the `beautiful` theme's
  // `.marginalia > h1:first-child + p::first-letter` drop-cap. A doc
  // that starts with h2, or introduces an h1 mid-body, isn't
  // affected: only h1 at heading position 0 counts as a title.
  const firstHeading = headings[0];
  const documentTitle = firstHeading?.tagName === 'H1' ? firstHeading : null;

  for (const heading of headings) {
    if (heading === documentTitle) continue;

    const lvl = headingLevel(heading);
    if (lvl === null) continue;

    const sectionNodes = collectSectionNodes(heading, lvl);
    // No content under this heading — no toggle. A chevron over an
    // empty section would be misleading.
    if (sectionNodes.length === 0) continue;

    const wrapper = createWrapper(lvl);
    const inner = wrapper.firstElementChild as HTMLElement;
    for (const node of sectionNodes) inner.appendChild(node);
    heading.after(wrapper);
    addToggleButton(heading, wrapper);
  }
}

/** Boundary check considers a sibling that IS a heading (Markdown)
 * AND a sibling container whose own heading is at our level
 * (AsciiDoc's `.sect1` siblings, each holding their own h2).
 */
function collectSectionNodes(heading: Element, ourLevel: number): Node[] {
  const nodes: Node[] = [];
  let cursor: Node | null = heading.nextSibling;
  while (cursor) {
    const lvl = headingLevel(cursor) ?? sectionContainerHeadingLevel(cursor);
    if (lvl !== null && lvl <= ourLevel) break;
    nodes.push(cursor);
    cursor = cursor.nextSibling;
  }
  return nodes;
}

function createWrapper(level: number): HTMLDivElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'collapse-section';
  wrapper.dataset.collapseLevel = String(level);
  const inner = document.createElement('div');
  inner.className = 'collapse-section-inner';
  wrapper.appendChild(inner);
  return wrapper;
}

function addToggleButton(heading: HTMLElement, wrapper: HTMLElement): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'heading-collapse-toggle';
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-label', 'Collapse section');
  button.innerHTML = CHEVRON_SVG;
  button.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleSection(button, wrapper);
  });

  // Last child = matches the right-side visual position in tab order
  // and screen-reader announcement ("[heading], Collapse section").
  heading.appendChild(button);
}

function toggleSection(button: HTMLElement, wrapper: HTMLElement): void {
  const collapsed = wrapper.classList.toggle('is-collapsed');
  applyCollapsedState(button, wrapper, collapsed);
}

/** `inert` on the inner takes a closed section's contents out of the
 * focus order and a11y tree — CSS-only hiding (`opacity: 0`,
 * `grid-template-rows: 0fr`) doesn't.
 */
function applyCollapsedState(button: HTMLElement, wrapper: HTMLElement, collapsed: boolean): void {
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  button.setAttribute('aria-label', collapsed ? 'Expand section' : 'Collapse section');
  const inner = wrapper.firstElementChild as HTMLElement | null;
  if (!inner) return;
  if (collapsed) {
    inner.setAttribute('inert', '');
  } else {
    inner.removeAttribute('inert');
  }
}

/**
 * Reveal `target` by expanding every collapsed `.collapse-section`
 * ancestor. Returns a Promise that resolves once the expand
 * animations have settled, so callers can `await` it before
 * `scrollIntoView` — measuring during the transition lands at the
 * pre-expansion offset.
 */
export function expandAncestors(target: Element): Promise<void> {
  const expanded: HTMLElement[] = [];
  let el: Element | null = target;
  while (el) {
    const section = el.closest('.collapse-section.is-collapsed') as HTMLElement | null;
    if (!section) break;
    expanded.push(section);
    section.classList.remove('is-collapsed');
    const heading = section.previousElementSibling;
    const button = heading
      ? (heading.querySelector(':scope > .heading-collapse-toggle') as HTMLButtonElement | null)
      : null;
    if (button) {
      applyCollapsedState(button, section, false);
    } else {
      const inner = section.firstElementChild as HTMLElement | null;
      inner?.removeAttribute('inert');
    }
    el = section.parentElement;
  }
  if (expanded.length === 0) return Promise.resolve();
  // All ancestors animate in parallel; the outermost is the last to
  // settle, so it owns the scroll-ready moment.
  return waitForExpansionToSettle(expanded[expanded.length - 1] as HTMLElement);
}

/** Falls back to a timeout slightly longer than the computed duration
 * so callers don't hang if `transitionend` is suppressed (reduced
 * motion, hidden tab, Chrome under CDP).
 */
export function waitForExpansionToSettle(wrapper: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const cs = getComputedStyle(wrapper);
    const durationMs = Number.parseFloat(cs.transitionDuration) * 1000;
    if (!durationMs || Number.isNaN(durationMs)) {
      resolve();
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      wrapper.removeEventListener('transitionend', onEnd);
      clearTimeout(fallbackId);
      resolve();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target !== wrapper) return;
      if (e.propertyName !== 'grid-template-rows') return;
      finish();
    };
    wrapper.addEventListener('transitionend', onEnd);
    const fallbackId = setTimeout(finish, durationMs + 80);
  });
}
