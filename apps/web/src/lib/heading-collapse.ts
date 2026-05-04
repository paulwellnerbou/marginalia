/**
 * Wraps the content under each heading in the rendered article so the
 * reader can collapse / expand sections by clicking a chevron.
 *
 * The server emits flat HTML — `<h2>`, then a run of siblings, then the
 * next heading. To make the run collapsible as a unit (and to nest
 * subheadings inside their parent's collapse), we walk the article's
 * direct children and group everything between a heading and the next
 * heading of equal-or-higher level into a `<div class="collapse-section">`.
 * The grouping is recursive, so collapsing an h2 also hides every h3
 * section inside it.
 *
 * Animation uses the `grid-template-rows: 1fr ↔ 0fr` trick: the wrapper
 * is a one-row grid whose row collapses smoothly, and the child has
 * `overflow: hidden`. Works in all modern browsers without measuring
 * the content height ahead of time, unlike a `height: auto` transition.
 */

const HEADING_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

const CHEVRON_SVG = `<svg viewBox="0 0 15 15" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6.1584 3.13508C6.35985 2.94621 6.67627 2.95642 6.86514 3.15788L10.6151 7.15788C10.7954 7.3502 10.7954 7.64949 10.6151 7.84182L6.86514 11.8418C6.67627 12.0433 6.35985 12.0535 6.1584 11.8646C5.95694 11.6757 5.94673 11.3593 6.1356 11.1579L9.565 7.49985L6.1356 3.84182C5.94673 3.64036 5.95694 3.32394 6.1584 3.13508Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/></svg>`;

function headingLevel(node: Node): number | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const tag = (node as Element).tagName;
  if (!HEADING_TAGS.has(tag)) return null;
  return Number.parseInt(tag.slice(1), 10);
}

/**
 * Idempotent: safe to call repeatedly. If wrappers already exist (e.g.
 * the html effect re-ran in strict mode without changing the html), the
 * function bails so collapse state isn't reset.
 */
export function installHeadingCollapse(article: HTMLElement): void {
  // Any heading with content produces a `.collapse-section` placed at
  // the top of the article (subsequent same-or-higher headings start
  // their own top-level wrapper). If we find one, we've already
  // installed.
  if (article.querySelector(':scope > .collapse-section')) return;

  const grouped = groupChildren(Array.from(article.childNodes), 0);

  // After `groupChildren`, some original nodes have already moved into
  // wrapper subtrees. `replaceChildren` reattaches everything in the
  // new order in one shot.
  article.replaceChildren(...grouped);
}

/**
 * Recursively groups a flat list of sibling nodes. For each heading at
 * a level greater than `parentLevel`, gathers the following siblings
 * (until the next heading at level <= the heading's level) into a
 * collapsible wrapper attached after the heading. Subheadings inside
 * that range are processed recursively, producing nested wrappers.
 */
function groupChildren(children: Node[], parentLevel: number): Node[] {
  const result: Node[] = [];
  let i = 0;
  while (i < children.length) {
    const node = children[i] as Node;
    const lvl = headingLevel(node);

    if (lvl !== null && lvl > parentLevel) {
      result.push(node);
      let j = i + 1;
      while (j < children.length) {
        const nextLvl = headingLevel(children[j] as Node);
        if (nextLvl !== null && nextLvl <= lvl) break;
        j++;
      }
      const sectionChildren = children.slice(i + 1, j);
      if (sectionChildren.length > 0) {
        const processed = groupChildren(sectionChildren, lvl);
        const wrapper = createWrapper(lvl);
        const inner = wrapper.firstElementChild as HTMLElement;
        for (const n of processed) inner.appendChild(n);
        result.push(wrapper);
        addToggleButton(node as HTMLElement, wrapper);
      }
      i = j;
    } else {
      result.push(node);
      i++;
    }
  }
  return result;
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
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  button.setAttribute('aria-label', collapsed ? 'Expand section' : 'Collapse section');
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
    // keep aria state in sync.
    const heading = section.previousElementSibling;
    const button = heading
      ? (heading.querySelector(':scope > .heading-collapse-toggle') as HTMLButtonElement | null)
      : null;
    if (button) {
      button.setAttribute('aria-expanded', 'true');
      button.setAttribute('aria-label', 'Collapse section');
    }
    // Continue walking from the section's parent — outer wrappers may
    // also be collapsed.
    el = section.parentElement;
  }
}
