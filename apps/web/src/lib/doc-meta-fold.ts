import {
  DOC_META_ATTR,
  DOC_META_KINDS,
  type DocMetaKind,
  isDocMetaKind,
} from '@marginalia/renderer/doc-meta';

/**
 * Folds for a document's summary and about regions (see the renderer's
 * `doc-meta.ts`). Each region gets a labelled toggle and is wrapped in the
 * same `.collapse-section` structure heading folds use, so `expandAncestors`
 * opens it when a thread, search hit or link inside needs to be seen.
 *
 * With a storage key, a region starts folded and remembers what the reader
 * last chose; an expansion forced by a jump is not remembered. Without one
 * (the editor's preview) regions start open and nothing is stored.
 */

const LABELS: Record<DocMetaKind, string> = { summary: 'Summary', about: 'About' };

const CHEVRON_SVG = `<svg viewBox="0 0 15 15" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M6.1584 3.13508C6.35985 2.94621 6.67627 2.95642 6.86514 3.15788L10.6151 7.15788C10.7954 7.3502 10.7954 7.64949 10.6151 7.84182L6.86514 11.8418C6.67627 12.0433 6.35985 12.0535 6.1584 11.8646C5.95694 11.6757 5.94673 11.3593 6.1356 11.1579L9.565 7.49985L6.1356 3.84182C5.94673 3.64036 5.95694 3.32394 6.1584 3.13508Z" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd"/></svg>`;

type OpenState = Partial<Record<DocMetaKind, boolean>>;

function storageKeyFor(docKey: string): string {
  return `marginalia.docMeta.${docKey}`;
}

type StateStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Which folds a reader left open; anything unreadable counts as all closed. */
export function readOpenState(docKey: string, storage: StateStorage = localStorage): OpenState {
  try {
    const raw = JSON.parse(storage.getItem(storageKeyFor(docKey)) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: OpenState = {};
    for (const [k, v] of Object.entries(raw)) if (isDocMetaKind(k) && v === true) out[k] = true;
    return out;
  } catch {
    return {};
  }
}

export function writeOpenState(
  docKey: string,
  kind: DocMetaKind,
  open: boolean,
  storage: StateStorage = localStorage,
): void {
  try {
    const state = readOpenState(docKey, storage);
    if (open) state[kind] = true;
    else delete state[kind];
    storage.setItem(storageKeyFor(docKey), JSON.stringify(state));
  } catch {
    // Storage blocked: the fold still works for this visit.
  }
}

/**
 * Characters as a story platform counts them: the text a reader sees,
 * whitespace runs as one space, paragraphs one line break apart.
 */
export function countDocMetaCharacters(paragraphs: readonly string[]): number {
  const parts = paragraphs.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return Array.from(parts.join('\n')).length;
}

/** The region's paragraphs, through AsciiDoc's `.content` wrapper. */
function regionCharacterCount(region: Element): number {
  const content = region.querySelector(':scope > .content') ?? region;
  return countDocMetaCharacters(Array.from(content.children, (el) => el.textContent ?? ''));
}

/** For readers who may edit or propose: how to reach a region in the editor. */
export interface DocMetaLinks {
  href: (kind: DocMetaKind) => string;
  /** A plain click; modified clicks follow `href` so a new tab still works. */
  open: (kind: DocMetaKind) => void;
  /** Offer the regions the document lacks too — editors only. */
  canAdd: boolean;
}

/**
 * Idempotent; also refreshes the counts after a patch changed the text,
 * the "Edit" links after the role changed, and the "Add …" row after a
 * region came or went.
 */
export function installDocMetaFolds(
  article: HTMLElement,
  docKey: string | null,
  links: DocMetaLinks | null = null,
): void {
  const stored = docKey ? readOpenState(docKey) : null;
  const present = new Set<DocMetaKind>();
  for (const region of article.querySelectorAll<HTMLElement>(`[${DOC_META_ATTR}]`)) {
    const kind = region.getAttribute(DOC_META_ATTR);
    if (!isDocMetaKind(kind)) continue;
    present.add(kind);
    const existing = region.closest<HTMLElement>('.doc-meta-fold');
    const wrapper =
      existing ?? wrapRegion(region, kind, stored ? stored[kind] !== true : false, docKey);
    const header = wrapper.previousElementSibling;
    if (header instanceof HTMLElement && header.classList.contains('doc-meta-header')) {
      updateCount(header, region);
      syncEditLink(header, kind, links);
    }
  }
  syncAddRow(article, docKey, links?.canAdd ? links : null, present);
}

const ADD_LABELS: Record<DocMetaKind, string> = { summary: 'Add summary', about: 'Add about' };

function addRowKey(docKey: string): string {
  return `marginalia.docMetaAdd.${docKey}`;
}

export function isAddRowDismissed(docKey: string, storage: StateStorage = localStorage): boolean {
  try {
    return storage.getItem(addRowKey(docKey)) === 'dismissed';
  } catch {
    return false;
  }
}

function dismissAddRow(docKey: string): void {
  try {
    localStorage.setItem(addRowKey(docKey), 'dismissed');
  } catch {
    // Storage blocked: hidden for this visit only.
  }
}

/**
 * Where the folds would be — after them, else under the title — a quiet
 * row offering the missing ones, so an editor learns they exist.
 */
function syncAddRow(
  article: HTMLElement,
  docKey: string | null,
  add: DocMetaLinks | null,
  present: ReadonlySet<DocMetaKind>,
): void {
  article.querySelector('.doc-meta-add')?.remove();
  const missing = DOC_META_KINDS.filter((k) => !present.has(k));
  if (!add || !docKey || missing.length === 0 || isAddRowDismissed(docKey)) return;

  const row = document.createElement('div');
  row.className = 'doc-meta-header doc-meta-add';
  for (const kind of missing) {
    const link = document.createElement('a');
    link.className = 'doc-meta-add-link';
    link.href = add.href(kind);
    link.textContent = ADD_LABELS[kind];
    followInApp(link, () => add.open(kind));
    row.appendChild(link);
  }
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'doc-meta-add-dismiss';
  dismiss.textContent = '×';
  dismiss.title = 'Hide for this document';
  dismiss.setAttribute('aria-label', 'Hide the summary and about suggestions for this document');
  dismiss.addEventListener('click', () => {
    dismissAddRow(docKey);
    row.remove();
  });
  row.appendChild(dismiss);

  const folds = article.querySelectorAll('.doc-meta-fold');
  const lastFold = folds[folds.length - 1];
  const first = article.firstElementChild;
  if (lastFold) lastFold.after(row);
  else if (first && (first.tagName === 'H1' || first.id === 'header')) first.after(row);
  else article.prepend(row);
}

function wrapRegion(
  region: HTMLElement,
  kind: DocMetaKind,
  collapsed: boolean,
  docKey: string | null,
): HTMLElement {
  const header = document.createElement('div');
  header.className = 'doc-meta-header';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'doc-meta-toggle';
  button.innerHTML = CHEVRON_SVG;
  const label = document.createElement('span');
  label.textContent = LABELS[kind];
  button.appendChild(label);
  header.appendChild(button);

  const wrapper = document.createElement('div');
  wrapper.className = 'collapse-section doc-meta-fold';
  wrapper.dataset.docMetaFold = kind;
  const inner = document.createElement('div');
  inner.className = 'collapse-section-inner';
  wrapper.appendChild(inner);

  region.before(header);
  header.after(wrapper);
  inner.appendChild(region);

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
    if (docKey) writeOpenState(docKey, kind, !nowCollapsed);
    wrapper.dispatchEvent(new CustomEvent('marginalia:collapse-toggle', { bubbles: true }));
  });
  // `expandAncestors` opens the wrapper itself; follow it here.
  wrapper.addEventListener('marginalia:collapse-toggle', (e) => {
    if (e.target === wrapper) sync();
  });
  return wrapper;
}

/** Router navigation for a plain click; a modified click opens `href` as a link would. */
function followInApp(link: HTMLAnchorElement, open: () => void): void {
  link.addEventListener('click', (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open();
  });
}

/** Right after the toggle, so the "Edit" link stays last. */
function updateCount(header: HTMLElement, region: Element): void {
  let count = header.querySelector<HTMLElement>('.doc-meta-count');
  if (!count) {
    count = document.createElement('span');
    count.className = 'doc-meta-count';
    header.querySelector('.doc-meta-toggle')?.after(count);
  }
  const n = regionCharacterCount(region);
  count.textContent = `${n.toLocaleString()} ${n === 1 ? 'character' : 'characters'}`;
}

function syncEditLink(header: HTMLElement, kind: DocMetaKind, links: DocMetaLinks | null): void {
  const existing = header.querySelector('.doc-meta-edit');
  if (!links) {
    existing?.remove();
    return;
  }
  if (existing) return;
  const link = document.createElement('a');
  link.className = 'doc-meta-edit';
  link.href = links.href(kind);
  link.textContent = 'Edit';
  link.setAttribute('aria-label', kind === 'summary' ? 'Edit the summary' : 'Edit the about text');
  followInApp(link, () => links.open(kind));
  header.appendChild(link);
}
