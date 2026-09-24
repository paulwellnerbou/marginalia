import { CardStackMinusIcon, Cross2Icon, Pencil1Icon, PlusIcon } from '@radix-ui/react-icons';
import { Tooltip } from '@radix-ui/themes';
import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { showToast } from '../lib/notifications.js';
import {
  closeAllTabs,
  closeTab,
  neighbourOf,
  type OpenTab,
  restoreTabs,
  tabUrl,
} from '../lib/open-tabs.js';
import { FormatBadge } from './FormatBadge.js';

/**
 * The app bar's open-document strip. These are links, not ARIA tabs:
 * each one navigates to its own URL instead of swapping a panel in
 * place, and a tablist that doesn't own a tabpanel only misleads
 * assistive tech.
 *
 * Which tab is active comes from the URL rather than from the loaded
 * document, so a click lights up its tab in the same frame — the page
 * underneath is still fetching for a moment after.
 */
export function DocumentTabs({ tabs }: { tabs: OpenTab[] }) {
  const { uid: activeUid } = useParams<{ uid?: string }>();
  const location = useLocation();
  const editing = location.pathname.endsWith('/edit');
  const navigate = useNavigate();
  const activeRef = useRef<HTMLAnchorElement>(null);

  // The strip scrolls, so a tab reached from elsewhere (a recent-doc
  // card, a shared link) can be parked off-screen when the bar renders.
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeUid is the trigger — a ref can't be one, and the scroll is only wanted when the active tab changes.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [activeUid]);

  if (tabs.length === 0) return null;

  function onClose(tab: OpenTab) {
    const remaining = closeTab(tab.uid);
    if (tab.uid !== activeUid) return;
    // Closing what you're reading has to take you somewhere; leaving the
    // document up with no tab for it would strand it outside the strip.
    const next = neighbourOf(tabs, tab.uid);
    navigate(next && remaining.some((t) => t.uid === next.uid) ? tabUrl(next) : '/');
  }

  // One click clears up to ten tabs, and it sits next to the +, so it
  // offers an undo rather than asking first.
  function onCloseAll() {
    const closed = closeAllTabs();
    const from =
      activeUid && closed.some((t) => t.uid === activeUid)
        ? `${location.pathname}${location.search}${location.hash}`
        : null;
    if (from) navigate('/');
    showToast({
      title: `Closed ${closed.length} tabs`,
      body: 'The documents are still under Your documents.',
      action: {
        label: 'Undo',
        onClick: () => {
          restoreTabs(closed);
          if (from) navigate(from);
        },
      },
    });
  }

  return (
    <nav className="doc-tabs" aria-label="Open documents">
      {tabs.map((tab) => {
        const active = tab.uid === activeUid;
        return (
          <span key={tab.uid} className={`doc-tab${active ? ' doc-tab--active' : ''}`}>
            <Link
              to={tabUrl(tab)}
              className="doc-tab-link"
              title={tab.title}
              {...(active ? { ref: activeRef, 'aria-current': 'page' as const } : {})}
            >
              {active && editing && (
                <Pencil1Icon className="doc-tab-editing" aria-label="Editing" />
              )}
              <span className="doc-tab-title">{tab.title}</span>
              <FormatBadge format={tab.format} />
            </Link>
            <button
              type="button"
              className="doc-tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={() => onClose(tab)}
            >
              <Cross2Icon />
            </button>
          </span>
        );
      })}
      <Tooltip content="Open another document">
        <Link to="/" className="doc-tab-add" aria-label="Open another document">
          <PlusIcon />
        </Link>
      </Tooltip>
      {/* With one tab its own ✕ does the same. */}
      {tabs.length > 1 && (
        <Tooltip content="Close all tabs">
          <button
            type="button"
            className="doc-tab-close-all"
            aria-label="Close all tabs"
            onClick={onCloseAll}
          >
            <CardStackMinusIcon />
          </button>
        </Tooltip>
      )}
    </nav>
  );
}
