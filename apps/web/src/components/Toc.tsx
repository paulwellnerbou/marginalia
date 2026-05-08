import { ChevronDownIcon, Cross2Icon, MagnifyingGlassIcon } from '@radix-ui/react-icons';
import { IconButton, Text, TextField } from '@radix-ui/themes';
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

export function Toc({ nodes, activeId }: { nodes: TocNode[]; activeId?: string | null }) {
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const deferredQuery = useDeferredValue(query);
  const filteredNodes = useMemo(
    () => filterNodes(nodes, deferredQuery.trim()),
    [deferredQuery, nodes],
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
      {filteredNodes.length > 0 ? (
        <TocList nodes={filteredNodes} activeId={activeId ?? null} query={deferredQuery.trim()} />
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
}: {
  nodes: TocNode[];
  activeId: string | null;
  query: string;
}) {
  return (
    <ul className="toc-list">
      {nodes.map((n) => (
        <TocItem key={n.id} node={n} activeId={activeId} query={query} />
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

  // Query force-open stays in `effectiveOpen` only — never written to
  // `open`, so a manual collapse is restored when the query clears.
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
            {/* One icon rotated via CSS so the chevron animates in
                lockstep with the height transition. */}
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
        // Always rendered so children animate in/out (rather than
        // popping); `inert` keeps closed-section links out of the
        // focus order and a11y tree.
        <div className={`toc-collapse-section ${effectiveOpen ? '' : 'is-collapsed'}`}>
          <div className="toc-collapse-section-inner" inert={!effectiveOpen}>
            <TocList nodes={node.children} activeId={activeId} query={query} />
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
