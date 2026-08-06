import { ChevronDownIcon, Cross2Icon, MagnifyingGlassIcon } from '@radix-ui/react-icons';
import { Button, IconButton, Text, TextField } from '@radix-ui/themes';
import { FunnelIcon } from 'lucide-react';
import {
  Fragment,
  type ReactNode,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TocNode } from '../lib/api.js';
import { waitForExpansionToSettle } from '../lib/heading-collapse.js';
import { computeSectionRelations, type SectionRelation } from '../lib/section-filter.js';

interface TocFilter {
  ids: ReadonlySet<string>;
  relations: ReadonlyMap<string, SectionRelation> | null;
  onToggle: (id: string) => void;
}

export function Toc({
  nodes,
  activeId,
  filterIds,
  onToggleFilter,
  onClearFilter,
}: {
  nodes: TocNode[];
  activeId?: string | null;
  filterIds: ReadonlySet<string>;
  onToggleFilter: (id: string) => void;
  onClearFilter: () => void;
}) {
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const deferredQuery = useDeferredValue(query);
  const filteredNodes = useMemo(
    () => filterNodes(nodes, deferredQuery.trim()),
    [deferredQuery, nodes],
  );
  const filter = useMemo<TocFilter>(
    () => ({
      ids: filterIds,
      relations: filterIds.size > 0 ? computeSectionRelations(nodes, filterIds) : null,
      onToggle: onToggleFilter,
    }),
    [nodes, filterIds, onToggleFilter],
  );

  if (nodes.length === 0)
    return (
      <Text size="1" color="gray" className="toc-empty">
        No headings
      </Text>
    );

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
      {filterIds.size > 0 && (
        <div className="toc-filter-banner">
          <FunnelIcon className="toc-filter-banner-icon" aria-hidden />
          <Text size="1" color="gray" className="toc-filter-banner-text">
            {filterIds.size === 1
              ? 'Focused on 1 section'
              : `Focused on ${filterIds.size} sections`}
          </Text>
          <Button size="1" variant="ghost" onClick={onClearFilter}>
            Clear
          </Button>
        </div>
      )}
      {filteredNodes.length > 0 ? (
        <TocList
          nodes={filteredNodes}
          activeId={activeId ?? null}
          query={deferredQuery.trim()}
          filter={filter}
        />
      ) : (
        <Text size="1" color="gray" className="toc-empty">
          No headings match "{query.trim()}".
        </Text>
      )}
    </nav>
  );
}

function TocList({
  nodes,
  activeId,
  query,
  filter,
}: {
  nodes: TocNode[];
  activeId: string | null;
  query: string;
  filter: TocFilter;
}) {
  return (
    <ul className="toc-list">
      {nodes.map((n) => (
        <TocItem key={n.id} node={n} activeId={activeId} query={query} filter={filter} />
      ))}
    </ul>
  );
}

function TocItem({
  node,
  activeId,
  query,
  filter,
}: {
  node: TocNode;
  activeId: string | null;
  query: string;
  filter: TocFilter;
}) {
  const hasChildren = node.children.length > 0;
  const [open, setOpen] = useState(true);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const isActive = activeId === node.id;
  const hasActiveDescendant = containsNodeId(node.children, activeId);
  const queryActive = Boolean(query);
  const relation = filter.relations?.get(node.id) ?? null;
  const isFiltered = filter.ids.has(node.id);
  const plainText = stripHtml(node.text);

  // Auto-expand on every `activeId` change that lands inside this
  // subtree. Kept as a one-shot `setOpen(true)` rather than a
  // continuous `effectiveOpen` override so a user's manual collapse
  // is honored until the next navigation.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeId is the explicit re-trigger so re-clicking the same heading still re-expands a manually collapsed parent.
  useEffect(() => {
    if (hasActiveDescendant) setOpen(true);
  }, [activeId, hasActiveDescendant]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: query is the re-trigger so the active row re-scrolls after a search-driven force-open changes the surrounding layout.
  useEffect(() => {
    if (!isActive) return;
    const link = linkRef.current;
    if (!link) return;

    let cancelled = false;
    const doScroll = () => {
      if (cancelled) return;
      const container = link
        .closest<HTMLElement>('.toc')
        ?.querySelector<HTMLElement>(':scope > .toc-list');
      if (!container) return;
      const linkRect = link.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      if (linkRect.top >= containerRect.top && linkRect.bottom <= containerRect.bottom) return;
      link.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };

    // Effects run child-first, so the parent's auto-expand hasn't
    // committed yet. Defer one frame for the class swap, then wait
    // only if an ancestor is actually mid-animation — without the
    // `getAnimations()` check, every active-heading update would
    // pay a 360ms+ wait even when nothing is animating.
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      let outermost: HTMLElement | null = null;
      let walker: Element | null = link.parentElement;
      while (walker) {
        const section = walker.closest<HTMLElement>('.toc-collapse-section');
        if (!section) break;
        if (section.getAnimations().length > 0) outermost = section;
        walker = section.parentElement;
      }
      if (outermost) {
        void waitForExpansionToSettle(outermost).then(doScroll);
      } else {
        doScroll();
      }
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [isActive, query]);

  // Neither the query force-open nor the section-filter locks are ever
  // written to `open`, so the reader's manual collapse state is
  // restored when the query clears or the filter is lifted. A live
  // query outranks the locks — search results must stay reachable even
  // inside a filtered-out branch.
  const locked = !queryActive && (relation === 'unrelated' || relation === 'ancestor');
  const effectiveOpen = !hasChildren
    ? false
    : queryActive
      ? true
      : relation === 'unrelated'
        ? false
        : relation === 'ancestor'
          ? true
          : open;

  const filterLabel = isFiltered
    ? `Stop focusing on "${plainText}"`
    : `Focus on "${plainText}" only`;

  return (
    <li className={`toc-item toc-l${node.level} ${isActive ? 'active' : ''}`}>
      <div
        className={`toc-row ${isActive ? 'active' : ''} ${
          relation === 'unrelated' ? 'section-filter-out' : ''
        }`}
      >
        {hasChildren ? (
          <IconButton
            size="1"
            variant="ghost"
            onClick={() => setOpen((v) => !v)}
            aria-label={effectiveOpen ? 'Collapse' : 'Expand'}
            aria-expanded={effectiveOpen}
            className="toc-toggle"
            disabled={locked}
          >
            {/* One icon rotated via CSS so the chevron animates in
                lockstep with the height transition. */}
            <ChevronDownIcon />
          </IconButton>
        ) : (
          <span className="toc-toggle-spacer" aria-hidden />
        )}
        <a ref={linkRef} href={`#${node.id}`} className={isActive ? 'active' : undefined}>
          {renderHighlightedText(plainText, query)}
        </a>
        <IconButton
          size="1"
          variant="ghost"
          {...(isFiltered ? {} : { color: 'gray' as const })}
          className="toc-filter-btn"
          data-active={isFiltered ? 'true' : undefined}
          aria-pressed={isFiltered}
          aria-label={filterLabel}
          title={filterLabel}
          onClick={() => filter.onToggle(node.id)}
        >
          <FunnelIcon />
        </IconButton>
      </div>
      {hasChildren && (
        // Always rendered so children animate in/out (rather than
        // popping); `inert` keeps closed-section links out of the
        // focus order and a11y tree.
        <div className={`toc-collapse-section ${effectiveOpen ? '' : 'is-collapsed'}`}>
          <div className="toc-collapse-section-inner" inert={!effectiveOpen}>
            <TocList nodes={node.children} activeId={activeId} query={query} filter={filter} />
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
