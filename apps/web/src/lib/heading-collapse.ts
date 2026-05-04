/**
 * Wraps the content under each heading in the rendered article so the
 * reader can collapse / expand sections by clicking a chevron.
 *
 * The renderer emits two different heading shapes:
 *   - Markdown: flat — `<h2>`, then a run of sibling content nodes,
 *     then the next heading at the same DOM depth.
 *   - AsciiDoc: nested — `<div class="sect1"><h2>…</h2><div class="
 *     sectionbody">…</div></div>`, with the heading sitting inside a
 *     wrapping section element.
 *
 * To handle both, we iterate every heading in document order via
 * `querySelectorAll` and, for each, gather its following siblings
 * (within whatever container the heading happens to live in) up to
 * the next heading at the same-or-higher level. Those siblings move
 * into a `.collapse-section` wrapper that is inserted right after the
 * heading. Outer headings are processed before inner ones so deeper
 * sections automatically end up nested inside their ancestor's
 * wrapper — collapsing an h2 also hides every h3 below it.
 *
 * Animation uses the `grid-template-rows: 1fr ↔ 0fr` trick: the
 * wrapper is a one-row grid whose row collapses smoothly. The inner
 * uses `clip-path: inset(0 -2em)` rather than `overflow: hidden` so
 * heading-anchor sigils (positioned at `left: -0.9em` of each
 * heading) remain visible — per-axis overflow values are coerced to
 * `auto` when one side is `visible`, so `clip-path` is the only way
 * to keep vertical clipping while permitting horizontal slack.
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
 * Return the heading level of an AsciiDoc-style section container,
 * or `null` if `node` isn't one. AsciiDoc renders sections as
 * `<div class="sectN"><hN+1>…</hN+1><div class="sectionbody">…</div></div>`
 * — these divs are real section boundaries and we want the
 * collection loop to stop at them.
 *
 * The check is deliberately narrow:
 *   - element must be a `<div>`,
 *   - with a `sectN` class (AsciiDoc's section wrappers),
 *   - whose first DIRECT child is a heading.
 *
 * Without this narrowness, a Markdown blockquote that happens to
 * contain a heading (`> ## inside`) would falsely mark itself as a
 * sibling section and stop collection too early.
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

/**
 * Idempotent: safe to call repeatedly. Marks the article with
 * `data-collapse-installed` on first run; subsequent calls bail out.
 * A class-based check would false-positive on user-authored content
 * that happens to use the same name.
 */
export function installHeadingCollapse(article: HTMLElement): void {
  if (article.getAttribute(INSTALLED_ATTR) === 'true') return;
  article.setAttribute(INSTALLED_ATTR, 'true');

  // Capture all headings up front. The NodeList is static; subsequent
  // DOM moves don't invalidate the references. Iterating in document
  // order means each heading is processed before any heading nested
  // inside its (forthcoming) section — so deeper sections naturally
  // end up inside their parent's wrapper.
  const headings = Array.from(article.querySelectorAll<HTMLElement>(HEADING_SELECTOR));

  // The opening h1 — and only the opening h1 — is treated as the
  // document title and skipped. Wrapping it would re-parent its
  // siblings, which breaks several theme selectors:
  //   - AsciiDoc's `#header > #toc.toc2` (the desktop TOC) expects
  //     #toc.toc2 to be a direct child of #header.
  //   - The `beautiful` theme's drop-cap selector
  //     `.marginalia > h1:first-child + p::first-letter` expects
  //     the first paragraph to remain a direct sibling of the h1.
  // Collapsing the entire document under its title is also rarely
  // useful, so the trade-off favours keeping these theme rules
  // working.
  //
  // The check looks at the first heading of any level: only an h1
  // in that position counts as the title. A document whose first
  // heading is an h2 (or that introduces an h1 mid-body) gets all
  // its sections processed normally — we don't want to silently
  // strip a collapse toggle from a real section heading just
  // because no earlier heading happened to be an h1.
  const firstHeading = headings[0];
  const documentTitle = firstHeading?.tagName === 'H1' ? firstHeading : null;

  for (const heading of headings) {
    if (heading === documentTitle) continue;

    const lvl = headingLevel(heading);
    if (lvl === null) continue;

    const sectionNodes = collectSectionNodes(heading, lvl);
    // Leaf headings — those immediately followed by another heading
    // at the same-or-higher level, with no body content of their
    // own — get no toggle. There's nothing to collapse, and a
    // chevron would be misleading.
    if (sectionNodes.length === 0) continue;

    const wrapper = createWrapper(lvl);
    const inner = wrapper.firstElementChild as HTMLElement;
    for (const node of sectionNodes) inner.appendChild(node);
    heading.after(wrapper);
    addToggleButton(heading, wrapper);
  }
}

/**
 * Gather siblings following `heading` (within whatever element is its
 * parent) up to — but not including — the next heading at level
 * `<= ourLevel`. The boundary check considers two cases:
 *   - the sibling itself is such a heading (Markdown's flat layout),
 *   - the sibling is a container whose top heading is at our level
 *     (AsciiDoc's `.sect1` siblings, each holding their own h2).
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

  // Append as the last child. The button is absolutely positioned at
  // the right of the heading via CSS, but DOM order still drives
  // keyboard tab order and screen-reader announcement: putting the
  // toggle after the heading text matches its visual position and
  // reads as "[heading], Collapse section".
  heading.appendChild(button);
}

function toggleSection(button: HTMLElement, wrapper: HTMLElement): void {
  const collapsed = wrapper.classList.toggle('is-collapsed');
  applyCollapsedState(button, wrapper, collapsed);
}

/**
 * Mirror DOM/ARIA state to the visual collapsed/expanded state.
 * Setting `inert` on the inner wrapper takes the section's contents
 * out of the focus order and the accessibility tree, so links and
 * other interactive elements inside a closed section can't be
 * reached by Tab or announced by a screen reader. (CSS-only hiding
 * via `opacity: 0` and `grid-template-rows: 0fr` does not.)
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
 * Walk up from `target` and expand every `.collapse-section` ancestor
 * that is currently collapsed. Used before scroll-into-view from TOC
 * links, in-doc anchors, and active search results so a hidden target
 * is revealed before being scrolled to.
 *
 * Returns a Promise that resolves once any expand animations have
 * settled, so callers can `await` it before computing the target's
 * final scroll position. With `prefers-reduced-motion: reduce`
 * (transitions disabled) the Promise resolves on the next tick.
 */
export function expandAncestors(target: Element): Promise<void> {
  const expanded: HTMLElement[] = [];
  let el: Element | null = target;
  while (el) {
    const section = el.closest('.collapse-section.is-collapsed') as HTMLElement | null;
    if (!section) break;
    expanded.push(section);
    section.classList.remove('is-collapsed');
    // The heading sitting just before the wrapper owns the toggle button;
    // keep aria + inert state in sync.
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
    // Continue walking from the section's parent — outer wrappers may
    // also be collapsed.
    el = section.parentElement;
  }
  if (expanded.length === 0) return Promise.resolve();
  // All ancestors animate in parallel (same duration, same start
  // tick). Wait on the outermost — its `transitionend` lines up
  // with the moment the deepest layout settles.
  return waitForExpansionToSettle(expanded[expanded.length - 1] as HTMLElement);
}

/**
 * Resolve once the wrapper finishes its current `grid-template-rows`
 * transition. Falls back to a timeout slightly longer than the
 * computed duration so callers don't hang if `transitionend` is
 * suppressed (reduced-motion, hidden tab, etc.).
 */
export function waitForExpansionToSettle(wrapper: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    const cs = getComputedStyle(wrapper);
    const durationMs = Number.parseFloat(cs.transitionDuration) * 1000;
    if (!durationMs || Number.isNaN(durationMs)) {
      // `transition: none` (reduced motion) or the wrapper has no
      // animation declared — the new layout is already in effect.
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
    // Buffer past the declared duration so a slightly delayed event
    // (some browsers fire transitionend a beat after the visual
    // settle) doesn't lose the race with our fallback.
    const fallbackId = setTimeout(finish, durationMs + 80);
  });
}
