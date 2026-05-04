import { Fragment, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconButton, Text, TextField } from '@radix-ui/themes';
import { ChevronDownIcon, Cross2Icon, MagnifyingGlassIcon } from '@radix-ui/react-icons';
import type { TocNode } from '../lib/api.js';

export function Toc({ nodes, activeId }: { nodes: TocNode[]; activeId?: string | null }) {
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const deferredQuery = useDeferredValue(query);
  const filteredNodes = useMemo(() => filterNodes(nodes, deferredQuery.trim()), [deferredQuery, nodes]);

  if (nodes.length === 0) return <Text size="1" color="gray" className="toc-empty">No headings</Text>;

  return (
    <nav className="toc">
      <div className="toc-search">
        <TextField.Root
          ref={searchInputRef}
          size="1"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter contents"
          className="toc-search-field"
        >
          <TextField.Slot className="toc-search-slot">
            <MagnifyingGlassIcon className="toc-search-icon" />
          </TextField.Slot>
          {query.length > 0 && (
            <TextField.Slot side="right" className="toc-search-clear-slot">
              <button
                type="button"
                className="toc-search-clear"
                aria-label="Clear TOC filter"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setQuery('');
                  searchInputRef.current?.focus({ preventScroll: true });
                }}
              >
                <Cross2Icon className="toc-search-clear-icon" />
              </button>
            </TextField.Slot>
          )}
        </TextField.Root>
      </div>
      {filteredNodes.length > 0 ? (
        <TocList
          nodes={filteredNodes}
          activeId={activeId ?? null}
          query={deferredQuery.trim()}
        />
      ) : (
        <Text size="1" color="gray" className="toc-empty">No headings match "{query.trim()}".</Text>
      )}
    </nav>
  );
}

function TocList({
  nodes,
  activeId,
  query,
}: {
  nodes: TocNode[];
  activeId: string | null;
  query: string;
}) {
  return (
    <ul className="toc-list">
      {nodes.map((n) => (
        <TocItem
          key={n.id}
          node={n}
          activeId={activeId}
          query={query}
        />
      ))}
    </ul>
  );
}

function TocItem({
  node,
  activeId,
  query,
}: {
  node: TocNode;
  activeId: string | null;
  query: string;
}) {
  const hasChildren = node.children.length > 0;
  const [open, setOpen] = useState(true);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const isActive = activeId === node.id;
  const hasActiveDescendant = containsNodeId(node.children, activeId);
  const queryActive = Boolean(query);

  // Auto-expand on navigation: every time the active item lands
  // inside this subtree, open up so the user can see where they
  // are. We re-run on every `activeId` change (not just on the
  // transition into the subtree) so scrolling between siblings
  // inside this branch also re-reveals it.
  //
  // We deliberately do NOT include this in `effectiveOpen` as a
  // continuous override — once the user clicks the chevron to
  // collapse, that intent is honored until they navigate somewhere
  // new. Earlier behaviour kept the section forced open whenever
  // the active item was inside it, which made the toggle feel
  // dead.
  useEffect(() => {
    if (hasActiveDescendant) setOpen(true);
  }, [activeId, hasActiveDescendant]);

  useEffect(() => {
    if (!isActive) return;
    const link = linkRef.current;
    const container = link?.closest<HTMLElement>('.toc')?.querySelector<HTMLElement>(':scope > .toc-list');
    if (!link || !container) return;

    const linkRect = link.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    if (linkRect.top >= containerRect.top && linkRect.bottom <= containerRect.bottom) return;

    link.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [isActive, query]);

  // Search-driven force-open stays in `effectiveOpen` only — we
  // never write `open` for it, so a user's manual collapse is
  // restored when they clear the query.
  const effectiveOpen = !hasChildren ? false : queryActive || open;

  return (
    <li className={`toc-item toc-l${node.level} ${isActive ? 'active' : ''}`}>
      <div className={`toc-row ${isActive ? 'active' : ''}`}>
        {hasChildren ? (
          <IconButton
            size="1"
            variant="ghost"
            onClick={() => setOpen((v) => !v)}
            aria-label={effectiveOpen ? 'Collapse' : 'Expand'}
            aria-expanded={effectiveOpen}
            className="toc-toggle"
          >
            {/* One icon, rotated via CSS — keeps the chevron motion in
                lockstep with the height/opacity animation below
                instead of swapping two separate SVGs mid-transition. */}
            <ChevronDownIcon />
          </IconButton>
        ) : (
          <span className="toc-toggle-spacer" aria-hidden />
        )}
        <a ref={linkRef} href={`#${node.id}`} className={isActive ? 'active' : undefined}>
          {renderHighlightedText(stripHtml(node.text), query)}
        </a>
      </div>
      {hasChildren && (
        // Always rendered so the children animate in/out instead of
        // popping. `is-collapsed` toggles the grid-row + opacity
        // transitions defined in app.css. `inert` on the inner
        // wrapper takes hidden links out of the focus order and the
        // accessibility tree so keyboard and screen-reader users
        // don't tab into a section that visually appears closed.
        <div className={`toc-collapse-section ${effectiveOpen ? '' : 'is-collapsed'}`}>
          <div className="toc-collapse-section-inner" inert={!effectiveOpen}>
            <TocList
              nodes={node.children}
              activeId={activeId}
              query={query}
            />
          </div>
        </div>
      )}
    </li>
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function filterNodes(nodes: TocNode[], query: string): TocNode[] {
  if (!query) return nodes;
  const queryLower = query.toLocaleLowerCase();
  const filtered: TocNode[] = [];

  for (const node of nodes) {
    const children = filterNodes(node.children, query);
    if (stripHtml(node.text).toLocaleLowerCase().includes(queryLower) || children.length > 0) {
      filtered.push({ ...node, children });
    }
  }

  return filtered;
}

function containsNodeId(nodes: TocNode[], targetId: string | null): boolean {
  if (!targetId) return false;
  for (const node of nodes) {
    if (node.id === targetId || containsNodeId(node.children, targetId)) return true;
  }
  return false;
}

function renderHighlightedText(text: string, query: string) {
  if (!query) return text;

  const loweredText = text.toLocaleLowerCase();
  const loweredQuery = query.toLocaleLowerCase();
  const parts: ReactNode[] = [];
  let cursor = 0;
  let matchIndex = 0;

  while (cursor < text.length) {
    const found = loweredText.indexOf(loweredQuery, cursor);
    if (found < 0) break;
    if (found > cursor) {
      parts.push(<Fragment key={`text-${matchIndex}`}>{text.slice(cursor, found)}</Fragment>);
    }
    const end = found + query.length;
    parts.push(
      <mark key={`match-${matchIndex}`} className="toc-match">
        {text.slice(found, end)}
      </mark>,
    );
    cursor = end;
    matchIndex += 1;
  }

  if (cursor < text.length) {
    parts.push(<Fragment key={`tail-${matchIndex}`}>{text.slice(cursor)}</Fragment>);
  }

  return parts;
}
