/**
 * Fold for an AsciiDoc document's own table of contents (`:toc:`). The
 * title becomes the toggle and the list is wrapped in the
 * `.collapse-section` structure heading folds use, so it animates the
 * same way and `expandAncestors` opens it when a search hit inside needs
 * to be seen.
 *
 * The TOC starts open. With a storage key, a reader's fold is remembered
 * per document; an expansion forced by a jump is not.
 */

const CHEVRON_SVG = `<svg viewBox="0 0 15 15" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6.1584 3.13508C6.35985 2.94621 6.67627 2.95642 6.86514 3.15788L10.6151 7.15788C10.7954 7.3502 10.7954 7.64949 10.6151 7.84182L6.86514 11.8418C6.67627 12.0433 6.35985 12.0535 6.1584 11.8646C5.95694 11.6757 5.94673 11.3593 6.1356 11.1579L9.565 7.49985L6.1356 3.84182C5.94673 3.64036 5.95694 3.32394 6.1584 3.13508Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/></svg>`;

type StateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function storageKeyFor(docKey: string): string {
  return `marginalia.tocFold.${docKey}`;
}

export function readTocCollapsed(docKey: string, storage: StateStorage = localStorage): boolean {
  try {
    return storage.getItem(storageKeyFor(docKey)) === 'collapsed';
  } catch {
    return false;
  }
}

export function writeTocCollapsed(
  docKey: string,
  collapsed: boolean,
  storage: StateStorage = localStorage,
): void {
  try {
    if (collapsed) storage.setItem(storageKeyFor(docKey), 'collapsed');
    else storage.removeItem(storageKeyFor(docKey));
  } catch {
    // Storage blocked: the fold still works for this visit.
  }
}

/** Idempotent: a TOC that already has its fold is left alone. */
export function installTocFolds(article: HTMLElement, docKey: string | null): void {
  const collapsed = docKey ? readTocCollapsed(docKey) : false;
  article.querySelectorAll<HTMLElement>('.toc').forEach((toc, i) => {
    if (toc.querySelector(':scope > .toc-fold')) return;
    const title = toc.querySelector<HTMLElement>(':scope > :is(#toctitle, .toctitle)');
    const list = toc.querySelector<HTMLElement>(':scope > ul');
    if (!title || !list) return;
    wrapToc(toc, title, list, collapsed, docKey, `${toc.id || 'toc'}-fold-${i}`);
  });
}

function wrapToc(
  toc: HTMLElement,
  title: HTMLElement,
  list: HTMLElement,
  collapsed: boolean,
  docKey: string | null,
  innerId: string,
): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'toc-toggle';
  button.innerHTML = CHEVRON_SVG;
  const label = document.createElement('span');
  // Keep whatever inline markup a `:toc-title:` carries.
  label.append(...title.childNodes);
  button.appendChild(label);
  title.appendChild(button);

  const wrapper = document.createElement('div');
  wrapper.className = 'collapse-section toc-fold';
  const inner = document.createElement('div');
  inner.className = 'collapse-section-inner';
  inner.id = innerId;
  button.setAttribute('aria-controls', innerId);
  list.before(wrapper);
  wrapper.appendChild(inner);
  inner.appendChild(list);
  toc.classList.add('toc-foldable');

  const sync = () => {
    const isCollapsed = wrapper.classList.contains('is-collapsed');
    button.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    if (isCollapsed) inner.setAttribute('inert', '');
    else inner.removeAttribute('inert');
  };
  wrapper.classList.toggle('is-collapsed', collapsed);
  sync();

  button.addEventListener('click', (e) => {
    e.preventDefault();
    const nowCollapsed = wrapper.classList.toggle('is-collapsed');
    sync();
    if (docKey) writeTocCollapsed(docKey, nowCollapsed);
    wrapper.dispatchEvent(new CustomEvent('marginalia:collapse-toggle', { bubbles: true }));
  });
  // `expandAncestors` opens the wrapper itself; follow it here.
  wrapper.addEventListener('marginalia:collapse-toggle', (e) => {
    if (e.target === wrapper) sync();
  });
}
