import { Cross2Icon, Pencil1Icon, PlusIcon } from '@radix-ui/react-icons';
import { Tooltip } from '@radix-ui/themes';
import { useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { closeTab, neighbourOf, type OpenTab, tabUrl } from '../lib/open-tabs.js';
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
  const editing = useLocation().pathname.endsWith('/edit');
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
    </nav>
  );
}
