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
 * Return the level of the first heading appearing in DOM order
 * inside `node`, or `null` if there is none. This is the heading
 * the container "introduces" — the boundary between sections.
 * Used to decide whether a non-heading sibling element (e.g. an
 * AsciiDoc `<div class="sect1">`) should terminate the current
 * section's collection: a sect1 sibling whose own h2 sits at the
 * same level as our heading marks the boundary.
 *
 * Note: this is the FIRST heading in DOM order, not necessarily
 * the prominentmost in level — but for the rendered shapes we
 * support (AsciiDoc sect divs, Markdown flat headings) the first
 * heading in a container IS the section's heading.
 */
function leadingHeadingLevel(node: Node): number | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const inner = (node as Element).querySelector(HEADING_SELECTOR);
  return inner ? headingLevel(inner) : null;
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

  for (const heading of headings) {
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
    const lvl = headingLevel(cursor) ?? leadingHeadingLevel(cursor);
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
 */
export function expandAncestors(target: Element): void {
  let el: Element | null = target;
  while (el) {
    const section = el.closest('.collapse-section.is-collapsed') as HTMLElement | null;
    if (!section) break;
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
}
