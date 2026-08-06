import { locateAllBlocks, locateAllBlocksAsciidoc } from '@marginalia/renderer';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Cross2Icon,
  LetterCaseToggleIcon,
  MagnifyingGlassIcon,
} from '@radix-ui/react-icons';
import {
  Badge,
  Button,
  Flex,
  IconButton,
  Select,
  Slider,
  Tabs,
  Text,
  TextField,
  Tooltip,
} from '@radix-ui/themes';
import { WholeWordIcon } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  CommentAnchor,
  Document,
  DocumentSettingsResponse,
  Thread,
  TocNode,
} from '../lib/api.js';
import {
  ApiError,
  acceptEditProposal as apiAcceptProposal,
  createComment as apiCreate,
  createEditProposal as apiCreateProposal,
  deleteComment as apiDelete,
  deleteThread as apiDeleteThread,
  rejectEditProposal as apiRejectProposal,
  repairEditProposalAnchor as apiRepairProposalAnchor,
  resolveThread as apiResolve,
  restoreHistoryVersion as apiRestoreHistoryVersion,
  revertHistoryVersion as apiRevertHistoryVersion,
  toggleCommentReaction as apiToggleReaction,
  updateComment as apiUpdate,
  type Comment,
  getDocument,
  getHistoryDiff,
  type HistoryEntry,
  isProposal,
  listThreads,
  uploadAsset,
} from '../lib/api.js';
import { highlightRange } from '../lib/block-span.js';
import { documentTitle } from '../lib/doc-title.js';
import { subscribeToDocumentEvents } from '../lib/events.js';
import { expandAncestors } from '../lib/heading-collapse.js';
import { getClientId, setDisplayName, useDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { savePendingNewDocumentDraft } from '../lib/new-document-draft.js';
import { ensureNotificationPermission, notify } from '../lib/notifications.js';
import {
  anchorTouchesSections,
  applySectionFilterToDocument,
  collectBlockSectionIds,
  computeSectionRelations,
  threadTouchesSections,
} from '../lib/section-filter.js';
import {
  applyTheme,
  BUILT_IN_THEMES,
  getUserThemeOverride,
  setUserThemeOverride,
} from '../lib/themes.js';
import { APP_ACCENT_COLOR } from '../styles/theme.js';
import { AccessControlDialog } from './AccessControlDialog.js';
import { ActivityList } from './ActivityList.js';
import { AppBar } from './AppBar.js';
import { BlockActions } from './BlockActions.js';
import {
  type DocumentSearchResult,
  DocumentSearchResultsPane,
} from './DocumentSearchResultsPane.js';
import { DocumentSettingsDialog } from './DocumentSettingsDialog.js';
import { DownloadMenu } from './DownloadMenu.js';
import { HistoryList } from './HistoryList.js';
import { InlineCommentsLayer } from './inline-comments/InlineCommentsLayer.js';
import { InlineCommentsList } from './inline-comments/InlineCommentsList.js';
import { COMMENT_FLASH_MS } from './inline-comments/inlineUtils.js';
import { McpPanel } from './McpPanel.js';
import { ReadAloudControls } from './ReadAloudControls.js';
import { type DocumentSearchOptions, RenderedDoc } from './RenderedDoc.js';
import { ResizeHandle } from './ResizeHandle.js';
import { type ProposalTarget, SelectionToolbar } from './SelectionToolbar.js';
import { ProposalComposer } from './ThreadComposer.js';
import { Toc } from './Toc.js';

const MAX_WIDTH_KEY = 'marginalia.maxWidth';
const TEXT_ZOOM_KEY = 'marginalia.textZoom';
const TOC_WIDTH_KEY = 'marginalia.tocWidth';
const COMMENTS_WIDTH_KEY = 'marginalia.commentsWidth';
const INLINE_COMMENTS_OPEN_KEY = 'marginalia.inlineCommentsOpen';
const INLINE_COMMENTS_STACKING_KEY = 'marginalia.inlineCommentsStacking';
const INLINE_COMMENTS_HIDE_RESOLVED_KEY = 'marginalia.inlineCommentsHideResolved';
const COLLAPSED_WIDTH = 36;
/** Delay before scrolling to a specific reply after the parent thread has expanded (ms). */
const REPLY_SCROLL_DELAY_MS = 900;
const EMPTY_SECTION_FILTER: ReadonlySet<string> = new Set();

interface Props {
  doc: Document;
  /** Called by admin settings when the server-side settings change. */
  onDocSettingsChanged?: (s: DocumentSettingsResponse) => void;
  children?: ReactNode;
}

interface ThreadFocusTarget {
  threadId: string;
  nonce: number;
  scroll: boolean;
}

type PendingDraft =
  | { mode: 'comment'; anchor: CommentAnchor }
  | { mode: 'proposal'; target: ProposalTarget };

export function DocumentLayout({ doc, onDocSettingsChanged, children }: Props) {
  const navigate = useNavigate();
  const canComment = doc.role !== 'reader';
  const [tocOpen, setTocOpen] = useState(true);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [inlineCommentsOpen, setInlineCommentsOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(INLINE_COMMENTS_OPEN_KEY);
    return saved === null ? true : saved === 'true';
  });
  const [inlineCommentsStacking, setInlineCommentsStacking] = useState<boolean>(() => {
    const saved = localStorage.getItem(INLINE_COMMENTS_STACKING_KEY);
    return saved === null ? true : saved === 'true';
  });
  const [inlineCommentsHideResolved, setInlineCommentsHideResolved] = useState<boolean>(() => {
    const saved = localStorage.getItem(INLINE_COMMENTS_HIDE_RESOLVED_KEY);
    return saved === 'true';
  });
  const [rightTab, setRightTab] = useState<
    'comments' | 'history' | 'search' | 'activities' | 'mcp'
  >('activities');
  const [historyVersion, setHistoryVersion] = useState(0);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  // Gates the deferred scrolls launched by `scrollToAnchor` (now
  // async because of the expand wait). A stale promise that resolves
  // after the user clicks a different thread bails out instead of
  // yanking the viewport back.
  const scrollToAnchorSeq = useRef(0);
  const [docSearchOpen, setDocSearchOpen] = useState(false);
  const [docSearchQuery, setDocSearchQuery] = useState('');
  const [docSearchCaseSensitive, setDocSearchCaseSensitive] = useState(false);
  const [docSearchWholeWords, setDocSearchWholeWords] = useState(false);
  const deferredDocSearchQuery = useDeferredValue(docSearchQuery);
  const [searchResults, setSearchResults] = useState<DocumentSearchResult[]>([]);
  const [activeSearchTarget, setActiveSearchTarget] = useState<{
    id: string;
    nonce: number;
  } | null>(null);

  const [maxWidth, setMaxWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(MAX_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : 72;
  });
  const [textZoom, setTextZoom] = useState<number>(() => {
    const saved = Number(localStorage.getItem(TEXT_ZOOM_KEY));
    return Number.isFinite(saved) && saved >= 80 && saved <= 140 ? saved : 100;
  });
  const [tocWidth, setTocWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(TOC_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= 160 ? saved : 260;
  });
  const [commentsWidth, setCommentsWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(COMMENTS_WIDTH_KEY));
    return Number.isFinite(saved) && saved >= 160 ? saved : 320;
  });

  const [threads, setThreads] = useState<Thread[]>([]);
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const pendingAnchor = pendingDraft?.mode === 'comment' ? pendingDraft.anchor : null;
  const pendingProposalTarget = pendingDraft?.mode === 'proposal' ? pendingDraft.target : null;
  const [focusedThread, setFocusedThread] = useState<ThreadFocusTarget | null>(null);
  /** Mirror of `doc.source` and `doc.rendered`, mutated when a proposal is
   *  accepted (auto-merged) so the displayed doc stays fresh without a reload. */
  const [liveSource, setLiveSource] = useState<string>(doc.source);
  const [liveRendered, setLiveRendered] = useState(doc.rendered);
  const [error, setError] = useState<string | null>(null);

  // Pending comment / proposal anchors carry block_ids that are only
  // valid for the current document content. Drop any in-flight draft
  // when:
  //  - the document changes (doc.uid), so the composer can't submit a
  //    previous document's anchor against a new one;
  //  - the live source mutates in place (proposal accepted, refresh),
  //    since block_ids are content-derived and may no longer point at
  //    the same content the user originally selected.
  //
  // The snapshots live in `useState`, not refs: under React 19's
  // concurrent renderer an interrupted render can mutate a ref and
  // discard the matching setState, leaving a stale draft open. State
  // updates only commit if the render commits, keeping snapshot and
  // reset in lockstep.
  const [trackedDocUid, setTrackedDocUid] = useState(doc.uid);
  const [trackedLiveSource, setTrackedLiveSource] = useState(liveSource);
  if (trackedDocUid !== doc.uid || trackedLiveSource !== liveSource) {
    setTrackedDocUid(doc.uid);
    setTrackedLiveSource(liveSource);
    setPendingDraft(null);
  }

  /**
   * Comment ID parsed from the URL hash on mount (e.g. `#comment-<id>`).
   * Cleared after the deep link is processed so thread refreshes don't
   * re-trigger the scroll.
   */
  const pendingDeepLinkCommentId = useRef<string | null>(null);

  // Capture the URL hash once on mount so deep links survive async thread load.
  // Re-runs on doc.uid change to handle SPA navigation to a deep-linked document.
  // biome-ignore lint/correctness/useExhaustiveDependencies: doc.uid is the intentional re-run trigger; the body only writes to a ref.
  useEffect(() => {
    const hash = window.location.hash;
    pendingDeepLinkCommentId.current = hash.startsWith('#comment-')
      ? hash.slice('#comment-'.length) || null
      : null;
  }, [doc.uid]);

  /*
   * Per-block source ranges for the live document. Shared by the
   * ProposalComposer (extracts the clicked block's source into
   * the textarea) and CommentsPane (passed down to ThreadItems for diff
   * display). Recomputed only when the source or format changes, so editors
   * don't pay the parse cost on unrelated re-renders.
   */
  const blockRanges = useMemo(
    () =>
      doc.format === 'asciidoc' ? locateAllBlocksAsciidoc(liveSource) : locateAllBlocks(liveSource),
    [doc.format, liveSource],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: doc.uid is kept so a doc swap reseeds live state even if the new doc has identical source/rendered strings.
  useEffect(() => {
    setLiveSource(doc.source);
    setLiveRendered(doc.rendered);
  }, [doc.uid, doc.source, doc.rendered]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: doc.uid is the intentional re-run trigger; the body only calls stable setters.
  useEffect(() => {
    setDocSearchOpen(false);
    setDocSearchQuery('');
    setDocSearchCaseSensitive(false);
    setDocSearchWholeWords(false);
    setSearchResults([]);
    setActiveSearchTarget(null);
    setActiveHeadingId(null);
  }, [doc.uid]);

  const docSearchOptions = useMemo<DocumentSearchOptions>(
    () => ({
      caseSensitive: docSearchCaseSensitive,
      wholeWords: docSearchWholeWords,
    }),
    [docSearchCaseSensitive, docSearchWholeWords],
  );

  // Hoisted above the effects/callbacks that list them as deps so the dep
  // array doesn't reference these in their TDZ during render.
  const refreshDoc = useCallback(async () => {
    try {
      const fresh = await getDocument(doc.uid);
      setLiveSource(fresh.source);
      setLiveRendered(fresh.rendered);
    } catch (err) {
      reportError('DocumentLayout.refreshDoc', err, { uid: doc.uid });
    }
  }, [doc.uid]);

  const refreshThreads = useCallback(async () => {
    try {
      const res = await listThreads(doc.uid, { consumeMentions: false });
      setThreads(res.threads);
      setMentionCandidates(res.mention_candidates);
    } catch (err) {
      reportError('DocumentLayout.refreshThreads', err, { uid: doc.uid });
    }
  }, [doc.uid]);

  // Reactive across UserMenu, composer, invite-load seeding, other tabs.
  const displayName = useDisplayName();
  const effectiveDisplayName = displayName;
  const [theme, setTheme] = useState<string>(
    () => getUserThemeOverride(doc.uid) ?? doc.default_theme,
  );

  const docRef = useRef<HTMLElement>(null);
  const docScrollRef = useRef<HTMLDivElement>(null);
  const docSearchInputRef = useRef<HTMLInputElement>(null);
  const [inlineCommentsColumnWidth, setInlineCommentsColumnWidth] = useState(0);

  useEffect(() => {
    localStorage.setItem(MAX_WIDTH_KEY, String(maxWidth));
  }, [maxWidth]);
  useEffect(() => {
    localStorage.setItem(TEXT_ZOOM_KEY, String(textZoom));
  }, [textZoom]);
  useEffect(() => {
    localStorage.setItem(TOC_WIDTH_KEY, String(tocWidth));
  }, [tocWidth]);
  useEffect(() => {
    localStorage.setItem(COMMENTS_WIDTH_KEY, String(commentsWidth));
  }, [commentsWidth]);
  useEffect(() => {
    localStorage.setItem(INLINE_COMMENTS_OPEN_KEY, String(inlineCommentsOpen));
  }, [inlineCommentsOpen]);
  useEffect(() => {
    localStorage.setItem(INLINE_COMMENTS_STACKING_KEY, String(inlineCommentsStacking));
  }, [inlineCommentsStacking]);
  useEffect(() => {
    localStorage.setItem(INLINE_COMMENTS_HIDE_RESOLVED_KEY, String(inlineCommentsHideResolved));
  }, [inlineCommentsHideResolved]);
  useEffect(() => {
    void applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    setTheme(getUserThemeOverride(doc.uid) ?? doc.default_theme);
  }, [doc.uid, doc.default_theme]);

  useEffect(() => {
    if (!canComment) setPendingDraft(null);
  }, [canComment]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: inlineCommentsOpen is the intentional re-run trigger so the column is re-measured when the panel toggles.
  useLayoutEffect(() => {
    const scroll = docScrollRef.current;
    const column = scroll?.querySelector<HTMLElement>('.ic-column') ?? null;

    const updateWidth = () => {
      if (!column) {
        setInlineCommentsColumnWidth(0);
        return;
      }
      const style = window.getComputedStyle(column);
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        column.getClientRects().length > 0;
      setInlineCommentsColumnWidth(visible ? column.getBoundingClientRect().width : 0);
    };

    updateWidth();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    const observer = new ResizeObserver(updateWidth);
    if (scroll) observer.observe(scroll);
    if (column) observer.observe(column);
    window.addEventListener('resize', updateWidth);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateWidth);
    };
  }, [inlineCommentsOpen]);

  const headingIds = useMemo(() => flattenTocIds(liveRendered.toc), [liveRendered.toc]);
  const headingIdSet = useMemo(() => new Set(headingIds), [headingIds]);

  /** Heading ids the reader focused via the TOC funnel buttons; empty = no filter. */
  const [sectionFilter, setSectionFilter] = useState<ReadonlySet<string>>(EMPTY_SECTION_FILTER);
  const sectionFilterActive = sectionFilter.size > 0;
  /**
   * block id → enclosing heading-id chain, walked from the live
   * article DOM. `null` until the first walk. Recomputed whenever the
   * rendered HTML is rewritten (this effect runs after RenderedDoc's
   * innerHTML effect — child effects fire first).
   */
  const [blockSectionIds, setBlockSectionIds] = useState<Map<string, string[]> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: liveRendered.html is the re-walk trigger — after an innerHTML rewrite the same heading ids point at brand-new DOM nodes.
  useEffect(() => {
    const root = docRef.current;
    setBlockSectionIds(root ? collectBlockSectionIds(root, headingIdSet) : null);
  }, [liveRendered.html, headingIdSet]);

  // Heading ids are content-derived slugs, so an edit can invalidate a
  // focused id. Drop the stale ones instead of filtering against
  // sections that no longer exist.
  useEffect(() => {
    setSectionFilter((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => headingIdSet.has(id)));
      if (next.size === prev.size) return prev;
      return next.size === 0 ? EMPTY_SECTION_FILTER : next;
    });
  }, [headingIdSet]);

  const sectionRelations = useMemo(
    () => (sectionFilterActive ? computeSectionRelations(liveRendered.toc, sectionFilter) : null),
    [sectionFilterActive, liveRendered.toc, sectionFilter],
  );

  /**
   * Enforce the filter on the document's collapse state, and keep
   * enforcing it: outside code (deep links, thread jumps, TOC clicks)
   * calls `expandAncestors`, which reopens held-closed sections — each
   * such change fires `marginalia:collapse-toggle`, and the listener
   * re-asserts. The `applying` flag ignores the events our own
   * (synchronous) application dispatches.
   */
  const prevSectionFilterRef = useRef<ReadonlySet<string>>(EMPTY_SECTION_FILTER);
  // biome-ignore lint/correctness/useExhaustiveDependencies: liveRendered.html re-applies against the fresh DOM after an innerHTML rewrite wipes the filter's markers.
  useEffect(() => {
    const root = docRef.current;
    if (!root) return;
    const prev = prevSectionFilterRef.current;
    prevSectionFilterRef.current = sectionFilter;
    const added = new Set([...sectionFilter].filter((id) => !prev.has(id)));

    let applying = true;
    applySectionFilterToDocument(root, sectionRelations, added);
    applying = false;

    if (!sectionRelations) return;
    // Re-assert only when the toggled section is one the filter locks
    // (unrelated: held closed, ancestor: held open). Reader toggles
    // inside focused sections are free and shouldn't pay the undo/
    // re-apply pass. The event fires on the `.collapse-section`
    // wrapper, whose previous sibling is its heading.
    const reassert = (event: Event) => {
      if (applying) return;
      const wrapper = event.target instanceof HTMLElement ? event.target : null;
      const headingId = wrapper?.previousElementSibling?.id;
      const relation = headingId ? sectionRelations.get(headingId) : undefined;
      if (relation !== 'unrelated' && relation !== 'ancestor') return;
      applying = true;
      applySectionFilterToDocument(root, sectionRelations);
      applying = false;
    };
    root.addEventListener('marginalia:collapse-toggle', reassert);
    return () => root.removeEventListener('marginalia:collapse-toggle', reassert);
  }, [sectionRelations, sectionFilter, liveRendered.html]);

  const toggleSectionFilter = useCallback((id: string) => {
    setSectionFilter((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Removing the last id hands back the canonical empty set, so
      // "no filter" keeps one stable identity everywhere.
      return next.size === 0 ? EMPTY_SECTION_FILTER : next;
    });
  }, []);
  const clearSectionFilter = useCallback(() => {
    setSectionFilter(EMPTY_SECTION_FILTER);
  }, []);
  const headingIdsKey = useMemo(() => headingIds.join('\u0000'), [headingIds]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: headingIdsKey is the deduped trigger derived from headingIds; liveRendered.html drives a re-attach against the new DOM nodes.
  useEffect(() => {
    const container = docScrollRef.current;
    const root = docRef.current;
    if (!container || !root || headingIds.length === 0) {
      setActiveHeadingId(null);
      return;
    }

    const headings = headingIds
      .map((id) => root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`))
      .filter((heading): heading is HTMLElement => Boolean(heading));

    if (headings.length === 0) {
      setActiveHeadingId(null);
      return;
    }

    let frame = 0;
    const updateActiveHeading = () => {
      frame = 0;
      const containerTop = container.getBoundingClientRect().top;
      const threshold = containerTop + 96;
      // Skip headings hidden inside a folded `.collapse-section` —
      // their `getBoundingClientRect()` still reports the wrapper's
      // collapsed position, so without this filter the TOC would
      // happily highlight a heading the reader can't see.
      const visible = headings.filter((h) => !h.closest('.collapse-section.is-collapsed'));
      if (visible.length === 0) {
        // Every heading is currently inside a folded section — clear
        // the highlight so the TOC doesn't keep pointing at one of
        // them.
        setActiveHeadingId(null);
        return;
      }
      let current = visible[0]!.id;

      for (const heading of visible) {
        if (heading.getBoundingClientRect().top <= threshold) {
          current = heading.id;
          continue;
        }
        break;
      }

      setActiveHeadingId((prev) => (prev === current ? prev : current));
    };

    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateActiveHeading);
    };

    scheduleUpdate();
    container.addEventListener('scroll', scheduleUpdate, { passive: true });
    window.addEventListener('resize', scheduleUpdate);
    // Section-collapse toggles change which headings are visible
    // without firing scroll or resize, so the scan would otherwise
    // keep highlighting a heading that just got hidden until the
    // next scroll.
    root.addEventListener('marginalia:collapse-toggle', scheduleUpdate);
    return () => {
      container.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
      root.removeEventListener('marginalia:collapse-toggle', scheduleUpdate);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [headingIdsKey, liveRendered.html]);

  useEffect(() => {
    if (!docSearchOpen) return;
    const input = docSearchInputRef.current;
    if (!input) return;
    const frame = window.requestAnimationFrame(() => input.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [docSearchOpen]);

  useEffect(() => {
    if (!docSearchOpen) return;
    setCommentsOpen(true);
  }, [docSearchOpen]);

  useEffect(() => {
    if (!docSearchOpen || deferredDocSearchQuery.trim()) return;
    setActiveSearchTarget(null);
  }, [deferredDocSearchQuery, docSearchOpen]);

  useEffect(() => {
    if (!docSearchOpen || !deferredDocSearchQuery.trim()) return;
    if (searchResults.length === 0) {
      setActiveSearchTarget(null);
      return;
    }

    setActiveSearchTarget((prev) => {
      if (prev && searchResults.some((result) => result.id === prev.id)) return prev;
      return { id: searchResults[0]!.id, nonce: (prev?.nonce ?? 0) + 1 };
    });
  }, [docSearchOpen, deferredDocSearchQuery, searchResults]);

  useEffect(() => {
    let cancelled = false;
    listThreads(doc.uid).then(
      (r) => {
        if (cancelled) return;
        setThreads(r.threads);
        setMentionCandidates(r.mention_candidates);
        notifyPendingMentions(r.threads, r.pending_mentions);
      },
      (err) => reportError('DocumentLayout.listThreads', err, { uid: doc.uid }),
    );
    return () => {
      cancelled = true;
    };
  }, [doc.uid]);

  // Process a pending deep-link comment once threads have loaded.
  useEffect(() => {
    const commentId = pendingDeepLinkCommentId.current;
    if (!commentId || threads.length === 0) return;

    const thread = threads.find((t) => t.comments.some((c) => c.id === commentId));
    if (!thread) return;

    // Clear so subsequent thread refreshes don't re-scroll.
    pendingDeepLinkCommentId.current = null;

    // Ensure the inline comments column is visible.
    setInlineCommentsOpen(true);

    // Focus + scroll the thread card (works for both inline column and right pane).
    setFocusedThread((prev) => ({
      threadId: thread.id,
      nonce: (prev?.nonce ?? 0) + 1,
      scroll: true,
    }));

    // For reply comments, additionally scroll to and flash the specific reply
    // element after the thread card has had time to expand.
    const isReply = thread.comments[0]?.id !== commentId;
    if (!isReply) return;

    // innerTimer is assigned inside the outer callback; the ref lets the
    // cleanup cancel it even if the component unmounts after the outer fires.
    const innerTimer = { current: null as number | null };
    const outerTimer = window.setTimeout(() => {
      const el = document.getElementById(`comment-${commentId}`);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      el.classList.add('ic-row-flash');
      innerTimer.current = window.setTimeout(
        () => el.classList.remove('ic-row-flash'),
        COMMENT_FLASH_MS,
      );
    }, REPLY_SCROLL_DELAY_MS);

    return () => {
      window.clearTimeout(outerTimer);
      if (innerTimer.current !== null) window.clearTimeout(innerTimer.current);
    };
    // threads is the real trigger; setInlineCommentsOpen/setFocusedThread are
    // stable useState dispatchers; pendingDeepLinkCommentId is a ref (not reactive).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads]);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void refreshThreads();
      }, 300);
    }
    void ensureNotificationPermission();
    const sub = subscribeToDocumentEvents(doc.uid, (event) => {
      switch (event.type) {
        case 'comment.created':
        case 'comment.updated':
        case 'comment.deleted':
        case 'edit_proposal.updated':
        case 'edit_proposal.deleted': {
          scheduleRefresh();
          break;
        }
        case 'mention.created': {
          void listThreads(doc.uid)
            .then((res) => {
              if (cancelled) return;
              setThreads(res.threads);
              setMentionCandidates(res.mention_candidates);
              notifyPendingMentions(res.threads, res.pending_mentions);
            })
            .catch((err) => reportError('DocumentLayout.mention.created', err, { uid: doc.uid }));
          break;
        }
        case 'edit_proposal.created': {
          void refreshThreads();
          const raw = event.edit_proposal as Record<string, unknown>;
          const comment = raw.comment as Record<string, unknown> | undefined;
          const author = comment?.author as { display_name?: string } | undefined;
          notify('New edit proposal', `${author?.display_name ?? 'Someone'} proposed a change.`);
          break;
        }
        case 'document.updated': {
          setHistoryVersion((v) => v + 1);
          notify('Document updated', `${event.author} saved a new version.`, {
            label: 'Reload',
            onClick: () => window.location.reload(),
          });
          break;
        }
      }
    });
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      sub.close();
    };
  }, [doc.uid, refreshThreads]);

  // Memoized so downstream useCallbacks can list it as a single dep instead
  // of mirroring [displayName, effectiveDisplayName] each time.
  const resolveIdentity = useCallback(
    (providedName?: string) => {
      const name = providedName?.trim() || effectiveDisplayName;
      if (!name) return null;
      // setDisplayName fires an in-app event → useDisplayName re-runs, so all
      // mirror components (AppBar UserMenu, etc.) stay in sync. The server
      // now treats subsequent-visit header names as authoritative, so
      // renames always flow through here cleanly.
      if (name !== displayName) setDisplayName(name);
      return { clientId: getClientId(), displayName: name };
    },
    [displayName, effectiveDisplayName],
  );

  const scrollToAnchor = useCallback(
    (blockId: string, quote?: string | null, threadId?: string, scrollOffset = 0) => {
      const root = docRef.current;
      if (!root) return;

      let target: HTMLElement | null = null;
      if (threadId) {
        target = root.querySelector<HTMLElement>(
          `mark[data-comment-thread-id="${CSS.escape(threadId)}"]`,
        );
      }

      if (!target) {
        const escaped = CSS.escape(blockId);
        target = root.querySelector<HTMLElement>(
          `[data-block="${escaped}"], [data-subblock="${escaped}"]`,
        );
        if (!target) return;
        // Recovery for comments anchored before sub-block-aware capture
        // landed: their stored block_id points at the enclosing top-level
        // block. If the quote uniquely identifies one sub-block, flash
        // that one instead of the whole container.
        if (target.dataset.block && quote) {
          const subEls = target.querySelectorAll<HTMLElement>('[data-subblock]');
          let narrowed: HTMLElement | null = null;
          let unique = true;
          for (const sub of subEls) {
            const text = (sub.textContent ?? '').replace(/\s+/gu, ' ').trim();
            if (text.includes(quote)) {
              if (narrowed) {
                unique = false;
                break;
              }
              narrowed = sub;
            }
          }
          if (unique && narrowed) target = narrowed;
        }
      }

      // Reveal the target if it sits inside a folded section before
      // measuring — otherwise the scroll lands at the pre-expansion
      // offset and the user ends up at an empty spot. The seq guard
      // discards a stale promise if another thread is clicked during
      // the expand window.
      const scroll = docScrollRef.current;
      const finalTarget = target;
      const seq = ++scrollToAnchorSeq.current;
      void expandAncestors(target).then(() => {
        if (seq !== scrollToAnchorSeq.current) return;
        if (scrollOffset > 0 && scroll) {
          const targetTop =
            finalTarget.getBoundingClientRect().top -
            scroll.getBoundingClientRect().top +
            scroll.scrollTop;
          scroll.scrollTo({ top: targetTop - scrollOffset, behavior: 'smooth' });
        } else {
          finalTarget.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        finalTarget.classList.add('anchor-flash');
        window.setTimeout(() => finalTarget.classList.remove('anchor-flash'), 1600);
      });
    },
    [],
  );

  const onCreate = useCallback(
    async (payload: { anchor: CommentAnchor; body: string; display_name?: string }) => {
      if (!canComment) {
        setError('You have read-only access to this document.');
        return;
      }
      const identity = resolveIdentity(payload.display_name);
      if (!identity) {
        setError('Please set your display name first.');
        return;
      }
      try {
        await apiCreate(doc.uid, { anchor: payload.anchor, body: payload.body }, identity);
        setPendingDraft(null);
        setError(null);
        // A comment on a spot the section filter hides (preamble, an
        // ancestor heading) would vanish the moment it posts — lift
        // the filter so the author sees their own thread.
        if (
          sectionFilterActive &&
          blockSectionIds &&
          !anchorTouchesSections(payload.anchor, blockSectionIds, sectionFilter)
        ) {
          clearSectionFilter();
        }
        await refreshThreads();
      } catch (err) {
        reportError('DocumentLayout.createComment', err, { uid: doc.uid });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Failed to post');
      }
    },
    [
      canComment,
      doc.uid,
      resolveIdentity,
      refreshThreads,
      sectionFilterActive,
      blockSectionIds,
      sectionFilter,
      clearSectionFilter,
    ],
  );

  const onReply = useCallback(
    async (threadId: string, body: string, name?: string) => {
      const identity = resolveIdentity(name);
      if (!identity) return;
      try {
        await apiCreate(doc.uid, { parent_id: threadId, body }, identity);
        await refreshThreads();
      } catch (err) {
        reportError('DocumentLayout.replyToThread', err, { uid: doc.uid, threadId });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Failed to reply');
      }
    },
    [doc.uid, resolveIdentity, refreshThreads],
  );

  const onResolveThread = useCallback(
    async (
      id: string,
      kind: 'resolve' | 'reopen' | 'accept' | 'reject',
      body?: string,
      name?: string,
    ): Promise<boolean> => {
      const identity = resolveIdentity(name);
      if (!identity) {
        // Match the other identity-gated actions in this file — without
        // this, the diff dialog's Accept/Reject just silently no-ops for
        // generic invitees who haven't set a display name yet.
        setError('Please set your display name first.');
        return false;
      }
      try {
        if (kind === 'resolve' || kind === 'reopen') {
          await apiResolve(doc.uid, id, kind === 'resolve', identity, body);
          await refreshThreads();
        } else if (kind === 'accept') {
          await apiAcceptProposal(doc.uid, id, identity, body);
          await Promise.all([refreshDoc(), refreshThreads()]);
          setHistoryVersion((v) => v + 1);
        } else {
          await apiRejectProposal(doc.uid, id, identity, body);
          await refreshThreads();
        }
        // Clear any stale error (e.g. an earlier missing-display-name
        // toast) so the toolbar doesn't keep showing it after a later
        // successful workflow action.
        setError(null);
        return true;
      } catch (err) {
        reportError('DocumentLayout.resolveThread', err, { id, kind });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : `${kind} failed`);
        // Signal failure so callers (composer / diff dialog) don't clear
        // drafts or close on a failed accept/reject. Don't re-throw —
        // `void runWorkflow(...)` callsites would surface the rejection
        // through `unhandledrejection` even though it's already toasted.
        return false;
      }
    },
    [doc.uid, resolveIdentity, refreshThreads, refreshDoc],
  );

  const onRepairThread = useCallback(
    async (id: string): Promise<boolean> => {
      const identity = resolveIdentity();
      if (!identity) {
        setError('Please set your display name first.');
        return false;
      }
      try {
        const repaired = await apiRepairProposalAnchor(doc.uid, id, identity);
        setThreads((prev) => {
          const index = prev.findIndex((thread) => thread.id === repaired.id);
          const next =
            index >= 0
              ? prev.map((thread, idx) => (idx === index ? repaired : thread))
              : [...prev, repaired];
          next.sort((a, b) => a.comments[0].created_at - b.comments[0].created_at);
          return next;
        });
        setError(null);
        return true;
      } catch (err) {
        reportError('DocumentLayout.repairThread', err, { id });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Repair failed');
        return false;
      }
    },
    [doc.uid, resolveIdentity],
  );

  const onEdit = useCallback(
    async (id: string, body: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        await apiUpdate(doc.uid, id, body, identity);
        await refreshThreads();
      } catch (err) {
        reportError('DocumentLayout.editComment', err, { commentId: id });
      }
    },
    [doc.uid, resolveIdentity, refreshThreads],
  );

  const canEdit = doc.role === 'admin' || doc.role === 'editor';

  // Editors can fill missing-asset placeholders directly in view mode
  // without navigating to the editor. Upload, then re-fetch so the
  // server-rewritten HTML points the <img> at the new proxy URL.
  const onMissingAssetUpload = useCallback(
    async (refName: string, file: File) => {
      const identity = resolveIdentity();
      if (!identity) {
        setError('Please set your display name first.');
        return;
      }
      try {
        await uploadAsset(doc.uid, refName, file, identity);
        await refreshDoc();
      } catch (err) {
        reportError('DocumentLayout.uploadAsset', err, { uid: doc.uid, refName });
        if (err instanceof ApiError) setError(`Upload failed: ${err.status} ${err.code}`);
        else setError('Upload failed');
      }
    },
    [doc.uid, resolveIdentity, refreshDoc],
  );

  const onCreateProposal = useCallback(
    async (payload: { proposed_text: string; rationale?: string; display_name?: string }) => {
      if (!pendingProposalTarget) return;
      const identity = resolveIdentity(payload.display_name);
      if (!identity) {
        setError('Please set your display name first.');
        return;
      }
      try {
        const req: Parameters<typeof apiCreateProposal>[1] = {
          anchor_block_id: pendingProposalTarget.block_id,
          anchor_quote: pendingProposalTarget.block_text,
          proposed_text: payload.proposed_text,
        };
        if (pendingProposalTarget.end_block_id) {
          req.anchor_end_block_id = pendingProposalTarget.end_block_id;
        }
        if (payload.rationale) req.rationale = payload.rationale;
        await apiCreateProposal(doc.uid, req, identity);
        setPendingDraft(null);
        setError(null);
        if (
          sectionFilterActive &&
          blockSectionIds &&
          !anchorTouchesSections(
            {
              block_id: pendingProposalTarget.block_id,
              end_block_id: pendingProposalTarget.end_block_id ?? null,
            },
            blockSectionIds,
            sectionFilter,
          )
        ) {
          clearSectionFilter();
        }
        await refreshThreads();
      } catch (err) {
        reportError('DocumentLayout.createProposal', err, { uid: doc.uid });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Failed to propose');
      }
    },
    [
      doc.uid,
      resolveIdentity,
      refreshThreads,
      pendingProposalTarget,
      sectionFilterActive,
      blockSectionIds,
      sectionFilter,
      clearSectionFilter,
    ],
  );

  const onDeleteThread = useCallback(
    async (threadId: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        await apiDeleteThread(doc.uid, threadId, identity);
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
      } catch (err) {
        reportError('DocumentLayout.deleteThread', err, { threadId });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Delete failed');
        await refreshThreads();
      }
    },
    [doc.uid, resolveIdentity, refreshThreads],
  );

  const onDeleteNode = useCallback(
    async (nodeId: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        await apiDelete(doc.uid, nodeId, identity);
        setThreads((prev) =>
          prev.map((t) => {
            if (!t.comments.slice(1).some((r) => r.id === nodeId)) return t;
            const [head, ...tail] = t.comments;
            return {
              ...t,
              comments: [head, ...tail.filter((c) => c.id !== nodeId)] as [Comment, ...Comment[]],
            };
          }),
        );
      } catch (err) {
        reportError('DocumentLayout.deleteNode', err, { nodeId });
      }
    },
    [doc.uid, resolveIdentity],
  );

  const onReact = useCallback(
    async (nodeId: string, emoji: string) => {
      const identity = resolveIdentity();
      if (!identity) {
        setError('Please set your display name first.');
        return;
      }
      try {
        // Server returns the updated thread; splice it into local state
        // in place so a reaction toggle costs one network round-trip
        // instead of one POST + one full listThreads refetch.
        const updated = await apiToggleReaction(doc.uid, nodeId, emoji, identity);
        setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
      } catch (err) {
        reportError('DocumentLayout.toggleReaction', err, { nodeId });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Reaction failed');
      }
    },
    [doc.uid, resolveIdentity],
  );

  const onRestoreHistoryVersion = useCallback(
    async (oid: string) => {
      const identity = resolveIdentity();
      if (!identity) {
        setError('Please set your display name first.');
        throw new Error('display-name-required');
      }
      try {
        await apiRestoreHistoryVersion(doc.uid, oid, identity);
        await Promise.all([refreshDoc(), refreshThreads()]);
        setHistoryVersion((v) => v + 1);
        setError(null);
      } catch (err) {
        reportError('DocumentLayout.restoreHistoryVersion', err, { oid, uid: doc.uid });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Restore failed');
        throw err;
      }
    },
    [doc.uid, resolveIdentity, refreshDoc, refreshThreads],
  );

  const onRestoreAsNewDocument = useCallback(
    async (oid: string) => {
      try {
        const diff = await getHistoryDiff(doc.uid, oid);
        savePendingNewDocumentDraft({
          source: diff.after,
          format: doc.format,
        });
        navigate('/');
      } catch (err) {
        reportError('DocumentLayout.restoreAsNewDocument', err, { oid, uid: doc.uid });
        setError(
          err instanceof ApiError ? `${err.status}: ${err.code}` : 'Could not open as new document',
        );
        throw err;
      }
    },
    [doc.format, doc.uid, navigate],
  );

  const tocPx = tocOpen ? tocWidth : COLLAPSED_WIDTH;
  const commentsPx = commentsOpen ? commentsWidth : COLLAPSED_WIDTH;
  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `${tocPx}px 1fr ${commentsPx}px`,
  };

  const title = documentTitle(doc);

  /**
   * Threads inside the focused sections — every thread while no filter
   * is set. Feeds the inline column, the Threads tab, and its badge.
   * Activities and the in-document highlights keep the full list: the
   * feed is a log, and highlights in held-closed sections are invisible
   * anyway.
   */
  const sectionVisibleThreads = useMemo(() => {
    if (!sectionFilterActive || !blockSectionIds) return threads;
    return threads.filter((t) => threadTouchesSections(t, blockSectionIds, sectionFilter));
  }, [threads, sectionFilterActive, blockSectionIds, sectionFilter]);
  const threadCount = sectionVisibleThreads.length;

  const commentHighlights = useMemo(() => {
    const highlights: Array<{
      scope: 'range' | 'block';
      threadId?: string;
      blockId: string;
      endBlockId?: string | null;
      quote: string;
      startOffset: number;
      endOffset: number;
      state?: Thread['state'];
    }> = [];

    for (const thread of threads) {
      // Orphaned threads have no anchor at all; skip them. Linked and
      // low-confidence threads both still carry a block_id + quote and
      // can drive a highlight — the renderer's `findHighlightBlock`
      // narrowing pass recovers the right element regardless of which
      // confidence band the server assigned.
      if (thread.link_status === 'orphaned') continue;
      if (!thread.anchor.block_id || !thread.anchor.quote) continue;

      if (!isProposal(thread)) {
        const range = highlightRange(thread.anchor);
        if (range) {
          highlights.push({
            scope: 'range',
            threadId: thread.id,
            blockId: thread.anchor.block_id,
            endBlockId: thread.anchor.end_block_id ?? null,
            quote: thread.anchor.quote,
            ...range,
            state: thread.state,
          });
        }
      } else if (thread.state === 'open') {
        // Block-scope highlights are visual + interactive on the *whole*
        // anchored block. For resolved proposals that would silently turn
        // the whole paragraph into a click target (and intercept clicks on
        // links inside it), so only emit them while the proposal is open.
        // Activities-tab navigation falls back to [data-block]/[data-subblock]
        // via blockId, so scroll-to-anchor still works for resolved ones.
        highlights.push({
          scope: 'block',
          threadId: thread.id,
          blockId: thread.anchor.block_id,
          endBlockId: thread.anchor.end_block_id ?? null,
          quote: thread.anchor.quote,
          startOffset: 0,
          endOffset: thread.anchor.quote.length,
          state: thread.state,
        });
      }
    }

    const pendingRange = canComment && pendingAnchor ? highlightRange(pendingAnchor) : null;
    if (pendingAnchor && pendingRange) {
      highlights.push({
        scope: 'range',
        blockId: pendingAnchor.block_id,
        endBlockId: pendingAnchor.end_block_id ?? null,
        quote: pendingAnchor.quote,
        ...pendingRange,
      });
    }

    return highlights;
  }, [canComment, threads, pendingAnchor]);

  /**
   * The inline column can be off-screen even when `inlineCommentsOpen`
   * is true: the container query on `.doc-scroll` hides `.ic-column`
   * on narrow viewports. Detect the rendered visibility of the column
   * directly so this stays in sync with CSS — duplicating the
   * breakpoint in JS would drift the moment someone tweaks the rule.
   */
  const inlineCommentsVisible = useCallback((): boolean => {
    if (!inlineCommentsOpen) return false;
    const scroll = docScrollRef.current;
    if (!scroll) return true;
    const column = scroll.querySelector<HTMLElement>('.ic-column');
    if (!column) return false;
    const style = window.getComputedStyle(column);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    return column.getClientRects().length > 0;
  }, [inlineCommentsOpen]);

  useEffect(() => {
    if (!canComment || !pendingAnchor) return;

    if (!inlineCommentsOpen) {
      setInlineCommentsOpen(true);
      return;
    }

    if (!inlineCommentsVisible()) {
      setCommentsOpen(true);
      setRightTab('comments');
    }
  }, [canComment, pendingAnchor, inlineCommentsOpen, inlineCommentsVisible]);

  const startCommentDraft = useCallback((anchor: CommentAnchor) => {
    const scrollTop = docScrollRef.current?.scrollTop ?? null;
    setInlineCommentsOpen(true);
    setPendingDraft({ mode: 'comment', anchor });

    if (scrollTop === null) return;

    const restoreScroll = () => {
      const scroll = docScrollRef.current;
      if (scroll) scroll.scrollTop = scrollTop;
    };

    restoreScroll();
    window.requestAnimationFrame(() => {
      restoreScroll();
      window.requestAnimationFrame(restoreScroll);
    });
  }, []);

  const openCommentThread = useCallback(
    (
      threadId: string,
      options?: {
        scroll?: boolean;
        jumpToAnchor?: boolean;
      },
    ) => {
      const jumpToAnchor = options?.jumpToAnchor ?? true;
      const scroll = options?.scroll ?? !jumpToAnchor;
      // Opening a thread the section filter hides (from Activities,
      // History, a deep link) wins over the filter — lift it so the
      // thread card can actually appear.
      if (sectionFilterActive && !sectionVisibleThreads.some((t) => t.id === threadId)) {
        clearSectionFilter();
      }
      // Prefer the inline column when it's actually visible; otherwise
      // fall back to the right pane (and open it if it's collapsed).
      if (!inlineCommentsVisible()) {
        setCommentsOpen(true);
        setRightTab('comments');
      }

      if (jumpToAnchor) {
        const thread = threads.find((t) => t.id === threadId);
        const blockId = thread?.anchor.block_id;
        if (thread && blockId) {
          scrollToAnchor(blockId, thread.anchor.quote, thread.id);
        }
      }

      setFocusedThread((prev) => ({ threadId, nonce: (prev?.nonce ?? 0) + 1, scroll }));
    },
    [
      inlineCommentsVisible,
      scrollToAnchor,
      threads,
      sectionFilterActive,
      sectionVisibleThreads,
      clearSectionFilter,
    ],
  );

  const onRevertLatestHistoryVersion = useCallback(
    async (entry: HistoryEntry) => {
      const identity = resolveIdentity();
      if (!identity) {
        setError('Please set your display name first.');
        throw new Error('display-name-required');
      }
      try {
        const res = await apiRevertHistoryVersion(doc.uid, entry.oid, identity);
        await Promise.all([refreshDoc(), refreshThreads()]);
        setHistoryVersion((v) => v + 1);
        setError(null);

        const reopenedThreadId = res.reopened_proposal_id;
        if (reopenedThreadId) openCommentThread(reopenedThreadId);
      } catch (err) {
        reportError('DocumentLayout.revertLatestHistoryVersion', err, {
          oid: entry.oid,
          uid: doc.uid,
        });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Revert failed');
        throw err;
      }
    },
    [doc.uid, resolveIdentity, openCommentThread, refreshDoc, refreshThreads],
  );

  const updateSearchResults = useCallback((results: DocumentSearchResult[]) => {
    setSearchResults(results);
  }, []);

  const focusSearchResult = useCallback((id: string) => {
    setCommentsOpen(true);
    setRightTab('search');
    setActiveSearchTarget((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  const navigateSearchResult = useCallback(
    (direction: -1 | 1) => {
      if (searchResults.length === 0) return;

      const currentIndex = activeSearchTarget
        ? searchResults.findIndex((result) => result.id === activeSearchTarget.id)
        : -1;
      const baseIndex = currentIndex >= 0 ? currentIndex : direction > 0 ? -1 : 0;
      const nextIndex = (baseIndex + direction + searchResults.length) % searchResults.length;
      const next = searchResults[nextIndex];
      if (!next) return;

      setActiveSearchTarget((prev) => ({ id: next.id, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [activeSearchTarget, searchResults],
  );

  const closeDocumentSearch = useCallback(() => {
    setDocSearchOpen(false);
    setDocSearchQuery('');
    setSearchResults([]);
    setActiveSearchTarget(null);
    setRightTab((prev) => (prev === 'search' ? 'comments' : prev));
  }, []);

  const activeSearchIndex = activeSearchTarget
    ? searchResults.findIndex((result) => result.id === activeSearchTarget.id)
    : -1;
  const hasSearchResults = docSearchOpen && searchResults.length > 0;

  useEffect(() => {
    if (rightTab !== 'search') return;
    if (hasSearchResults) return;
    setRightTab('comments');
  }, [hasSearchResults, rightTab]);

  return (
    <div className="doc-page">
      <AppBar
        docTitle={title}
        role={doc.role}
        docUid={doc.uid}
        passwordProtected={doc.password_protected}
        onLogout={() => window.location.reload()}
        format={doc.format}
      />

      <div className="doc-layout" style={gridStyle}>
        <aside className={`pane pane-toc ${tocOpen ? 'open' : 'closed'}`}>
          <Flex align="center" gap="2" px="2" py="2" className="pane-header">
            <Tooltip content={tocOpen ? 'Collapse' : 'Expand contents'}>
              <IconButton variant="ghost" size="1" onClick={() => setTocOpen((v) => !v)}>
                {tocOpen ? <ChevronLeftIcon /> : <ChevronRightIcon />}
              </IconButton>
            </Tooltip>
            {tocOpen && (
              <Text size="1" color="gray" weight="medium">
                Contents
              </Text>
            )}
          </Flex>
          {tocOpen && (
            <Toc
              nodes={liveRendered.toc}
              activeId={activeHeadingId}
              filterIds={sectionFilter}
              onToggleFilter={toggleSectionFilter}
              onClearFilter={clearSectionFilter}
            />
          )}
          {tocOpen && <ResizeHandle side="left" width={tocWidth} onResize={setTocWidth} />}
        </aside>

        <main className="pane pane-doc">
          {/* Document-specific toolbar lives inside the doc pane so it sits
              only over the document column, not above the side panes. */}
          <Flex align="center" gap="3" px="3" py="2" className="doc-chrome">
            <Flex align="center" gap="2" className="width-slider">
              <Text size="1" color="gray">
                Reading width
              </Text>
              <Slider
                size="1"
                style={{ width: 116 }}
                min={40}
                max={120}
                step={1}
                value={[maxWidth]}
                onValueChange={(v) => setMaxWidth(v[0] ?? maxWidth)}
              />
              <Text
                size="1"
                color="gray"
                style={{ minWidth: '4ch', whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                {maxWidth}ch
              </Text>
            </Flex>
            <Flex align="center" gap="2" className="width-slider">
              <Text size="1" color="gray">
                Text size
              </Text>
              <Slider
                size="1"
                style={{ width: 92 }}
                min={80}
                max={140}
                step={1}
                value={[textZoom]}
                onValueChange={(v) => setTextZoom(v[0] ?? textZoom)}
              />
              <Text
                size="1"
                color="gray"
                style={{ minWidth: '4ch', whiteSpace: 'nowrap', flexShrink: 0 }}
              >
                {textZoom}%
              </Text>
              <Button
                size="1"
                variant="ghost"
                onClick={() => setTextZoom(100)}
                disabled={textZoom === 100}
              >
                Reset
              </Button>
            </Flex>
            <Flex align="center" gap="2">
              <Text size="1" color="gray" as="label" htmlFor="doc-theme-select">
                Theme
              </Text>
              <Select.Root
                value={theme}
                size="1"
                onValueChange={(next) => {
                  setTheme(next);
                  setUserThemeOverride(doc.uid, next === doc.default_theme ? null : next);
                }}
              >
                <Select.Trigger id="doc-theme-select" variant="soft" />
                <Select.Content position="popper" style={{ maxHeight: 360 }}>
                  {BUILT_IN_THEMES.map((t) => (
                    <Select.Item key={t.id} value={t.id}>
                      {t.label}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Flex>
            <span className="spacer" />
            {error && (
              <Text size="1" color="red">
                {error}
              </Text>
            )}
            {/* Download is available to any reader — unlike settings /
                access control which are admin-only. Sits next to the
                gear so the whole toolbar cluster reads as a single set
                of per-document actions. */}
            <DownloadMenu
              doc={doc}
              source={liveSource}
              theme={theme}
              reviewExportEnabled={inlineCommentsOpen}
            />
            {children}
            {doc.role === 'admin' && onDocSettingsChanged && (
              <>
                <DocumentSettingsDialog doc={doc} onChange={onDocSettingsChanged} />
                <AccessControlDialog doc={doc} onChange={onDocSettingsChanged} />
              </>
            )}
            <ReadAloudControls
              rootRef={docRef}
              htmlKey={liveRendered.html}
              frontmatter={liveRendered.frontmatter}
              inlineCommentsOffset={inlineCommentsColumnWidth}
            />
            <Tooltip content={docSearchOpen ? 'Close document search' : 'Search document'}>
              <IconButton
                variant="soft"
                color={APP_ACCENT_COLOR}
                size="2"
                className={`doc-search-trigger ${docSearchOpen ? 'active' : ''}`}
                onClick={() => {
                  if (docSearchOpen) {
                    closeDocumentSearch();
                    return;
                  }
                  setDocSearchOpen(true);
                }}
                aria-label={docSearchOpen ? 'Close document search' : 'Search document'}
              >
                <MagnifyingGlassIcon />
              </IconButton>
            </Tooltip>
          </Flex>
          {docSearchOpen && (
            <div
              className="doc-search-popover"
              style={
                inlineCommentsColumnWidth > 0
                  ? ({
                      '--doc-search-inline-comments-offset': `${inlineCommentsColumnWidth}px`,
                    } as React.CSSProperties)
                  : undefined
              }
            >
              <Flex align="center" gap="2" className="doc-search-toolbar">
                <TextField.Root
                  ref={docSearchInputRef}
                  size="1"
                  type="search"
                  value={docSearchQuery}
                  onChange={(event) => setDocSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                    event.preventDefault();
                    navigateSearchResult(event.shiftKey ? -1 : 1);
                  }}
                  placeholder="Search this document"
                  className="doc-search-field"
                >
                  <TextField.Slot>
                    <MagnifyingGlassIcon />
                  </TextField.Slot>
                </TextField.Root>
                <Tooltip
                  content={
                    docSearchCaseSensitive ? 'Disable case sensitivity' : 'Enable case sensitivity'
                  }
                >
                  <IconButton
                    size="1"
                    variant="ghost"
                    color="gray"
                    className="doc-toolbar-toggle"
                    aria-label={
                      docSearchCaseSensitive
                        ? 'Disable case-sensitive search'
                        : 'Enable case-sensitive search'
                    }
                    aria-pressed={docSearchCaseSensitive}
                    onClick={() => {
                      setDocSearchCaseSensitive((prev) => !prev);
                      docSearchInputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <LetterCaseToggleIcon />
                  </IconButton>
                </Tooltip>
                <Tooltip
                  content={
                    docSearchWholeWords ? 'Disable whole-word matching' : 'Match whole words only'
                  }
                >
                  <IconButton
                    size="1"
                    variant="ghost"
                    color="gray"
                    className="doc-toolbar-toggle"
                    aria-label={
                      docSearchWholeWords ? 'Disable whole-word search' : 'Enable whole-word search'
                    }
                    aria-pressed={docSearchWholeWords}
                    onClick={() => {
                      setDocSearchWholeWords((prev) => !prev);
                      docSearchInputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <WholeWordIcon />
                  </IconButton>
                </Tooltip>
                <Text size="1" color="gray" className="doc-search-count">
                  {searchResults.length === 0
                    ? '0 results'
                    : `${activeSearchIndex >= 0 ? activeSearchIndex + 1 : 1}/${searchResults.length}`}
                </Text>
                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  aria-label="Previous search result"
                  onClick={() => navigateSearchResult(-1)}
                  disabled={searchResults.length === 0}
                >
                  <ChevronLeftIcon />
                </IconButton>
                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  aria-label="Next search result"
                  onClick={() => navigateSearchResult(1)}
                  disabled={searchResults.length === 0}
                >
                  <ChevronRightIcon />
                </IconButton>
                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  aria-label="Close document search"
                  onClick={closeDocumentSearch}
                >
                  <Cross2Icon />
                </IconButton>
              </Flex>
            </div>
          )}
          {/* `marginalia-theme` is applied here (not just inside the
              article) so the inline comments column inherits the
              document's themed background — otherwise it would sit on
              the surrounding pane-doc background and look like a
              different surface. */}
          <div className="doc-scroll marginalia-theme" ref={docScrollRef}>
            <div
              className={`doc-row${inlineCommentsOpen ? ' doc-row-with-inline' : ''}`}
              style={{ ['--md-max-width' as string]: `${maxWidth}ch` }}
            >
              <div className="doc-body">
                <RenderedDoc
                  rendered={liveRendered}
                  elRef={docRef}
                  maxWidthCh={maxWidth}
                  textZoom={textZoom / 100}
                  highlights={commentHighlights}
                  searchQuery={docSearchOpen ? deferredDocSearchQuery : ''}
                  searchOptions={docSearchOptions}
                  activeSearchResultId={activeSearchTarget?.id ?? null}
                  activeSearchVersion={activeSearchTarget?.nonce ?? 0}
                  onSearchResultsChange={updateSearchResults}
                  onHighlightClick={(threadId) =>
                    openCommentThread(threadId, { scroll: false, jumpToAnchor: false })
                  }
                  onMissingAssetUpload={canEdit ? onMissingAssetUpload : undefined}
                />
                {canComment && (
                  <SelectionToolbar
                    rootRef={docRef}
                    docFormat={doc.format}
                    blockRanges={blockRanges}
                    onAdd={startCommentDraft}
                    onPropose={(target) => setPendingDraft({ mode: 'proposal', target })}
                  />
                )}
                {canComment && (
                  <BlockActions
                    rootRef={docRef}
                    onPropose={(target) => setPendingDraft({ mode: 'proposal', target })}
                  />
                )}
              </div>
              <InlineCommentsLayer
                uid={doc.uid}
                threads={sectionVisibleThreads}
                docHtml={liveRendered.html}
                docElementRef={docRef}
                scrollContainerRef={docScrollRef}
                blockRanges={blockRanges}
                canComment={canComment}
                open={inlineCommentsOpen}
                onToggleOpen={() => setInlineCommentsOpen((v) => !v)}
                stackingEnabled={inlineCommentsStacking}
                onToggleStacking={() => setInlineCommentsStacking((v) => !v)}
                hideResolved={inlineCommentsHideResolved}
                onToggleHideResolved={() => setInlineCommentsHideResolved((v) => !v)}
                pendingAnchor={canComment ? pendingAnchor : null}
                focusedThread={focusedThread}
                displayName={effectiveDisplayName}
                mentionCandidates={mentionCandidates}
                onCancelPending={() => setPendingDraft(null)}
                onCreate={onCreate}
                onReply={onReply}
                onEdit={onEdit}
                onDeleteNode={onDeleteNode}
                onDeleteThread={onDeleteThread}
                onResolveThread={onResolveThread}
                onRepairThread={onRepairThread}
                onReact={onReact}
                onScrollToAnchor={scrollToAnchor}
              />
            </div>
          </div>
        </main>

        <aside className={`pane pane-right ${commentsOpen ? 'open' : 'closed'}`}>
          {commentsOpen && (
            <ResizeHandle side="right" width={commentsWidth} onResize={setCommentsWidth} />
          )}
          {commentsOpen ? (
            <Tabs.Root
              value={rightTab}
              onValueChange={(v) =>
                setRightTab(v as 'comments' | 'history' | 'search' | 'activities' | 'mcp')
              }
              className="right-tabs"
            >
              <Flex align="center" px="2" pt="2" className="pane-header">
                <Tabs.List size="1">
                  <Tabs.Trigger value="activities">Activities</Tabs.Trigger>
                  <Tabs.Trigger value="comments">
                    <Flex align="center" gap="2">
                      Threads
                      {threadCount > 0 && (
                        <Badge size="1" variant="soft" color="gray" radius="full">
                          {threadCount}
                        </Badge>
                      )}
                    </Flex>
                  </Tabs.Trigger>
                  <Tabs.Trigger value="history">History</Tabs.Trigger>
                  <Tabs.Trigger value="mcp">MCP</Tabs.Trigger>
                  {hasSearchResults && (
                    <Tabs.Trigger value="search">
                      <Flex align="center" gap="2">
                        Search Results
                        <Badge size="1" variant="soft" color="gray" radius="full">
                          {searchResults.length}
                        </Badge>
                      </Flex>
                    </Tabs.Trigger>
                  )}
                </Tabs.List>
                <span className="spacer" />
                <Tooltip content="Collapse">
                  <IconButton variant="ghost" size="1" onClick={() => setCommentsOpen(false)}>
                    <ChevronRightIcon />
                  </IconButton>
                </Tooltip>
              </Flex>
              <Tabs.Content value="activities" className="right-tab-panel">
                <ActivityList
                  uid={doc.uid}
                  version={historyVersion}
                  threads={threads}
                  onOpenThread={openCommentThread}
                />
              </Tabs.Content>
              <Tabs.Content value="comments" className="right-tab-panel">
                <InlineCommentsList
                  uid={doc.uid}
                  threads={sectionVisibleThreads}
                  sectionFilterCount={sectionFilter.size}
                  onClearSectionFilter={clearSectionFilter}
                  blockRanges={blockRanges}
                  canComment={canComment}
                  pendingAnchor={canComment ? pendingAnchor : null}
                  focusedThread={focusedThread}
                  onCancelPending={() => setPendingDraft(null)}
                  displayName={effectiveDisplayName}
                  mentionCandidates={mentionCandidates}
                  onCreate={onCreate}
                  onReply={onReply}
                  onEdit={onEdit}
                  onDeleteNode={onDeleteNode}
                  onDeleteThread={onDeleteThread}
                  onResolveThread={onResolveThread}
                  onRepairThread={onRepairThread}
                  onReact={onReact}
                  onScrollToAnchor={scrollToAnchor}
                />
              </Tabs.Content>
              <Tabs.Content value="mcp" className="right-tab-panel">
                <McpPanel uid={doc.uid} canManageInvites={doc.role === 'admin'} />
              </Tabs.Content>
              <Tabs.Content value="history" className="right-tab-panel">
                <HistoryList
                  uid={doc.uid}
                  version={historyVersion}
                  canRestore={canEdit}
                  onRestoreAsNewDocument={onRestoreAsNewDocument}
                  onRevertLatest={onRevertLatestHistoryVersion}
                  onOpenThread={openCommentThread}
                  {...(canEdit ? { onRestoreVersion: onRestoreHistoryVersion } : {})}
                />
              </Tabs.Content>
              {hasSearchResults && (
                <Tabs.Content value="search" className="right-tab-panel">
                  <DocumentSearchResultsPane
                    query={deferredDocSearchQuery}
                    results={searchResults}
                    activeResultId={activeSearchTarget?.id ?? null}
                    onSelectResult={focusSearchResult}
                  />
                </Tabs.Content>
              )}
            </Tabs.Root>
          ) : (
            <Flex align="center" justify="center" py="2">
              <Tooltip content="Expand comments / history">
                <IconButton variant="ghost" size="1" onClick={() => setCommentsOpen(true)}>
                  <ChevronLeftIcon />
                </IconButton>
              </Tooltip>
            </Flex>
          )}
        </aside>
      </div>

      {/*
        Proposal composer lives here (outside the right sidebar) so it
        stays mounted — and therefore openable — even when the user has
        the Threads/History pane collapsed. Radix Dialog portals the
        actual overlay to the body, so its DOM position here doesn't
        affect rendering.
      */}
      <ProposalComposer
        target={pendingProposalTarget}
        docUid={doc.uid}
        docSource={liveSource}
        docFormat={doc.format}
        blockRanges={blockRanges}
        attachedAssets={doc.attached_assets}
        needsName={!displayName}
        onCancel={() => setPendingDraft(null)}
        onSubmit={onCreateProposal}
      />
    </div>
  );
}

function notifyPendingMentions(threads: Thread[], pendingMentionIds: string[]): void {
  if (pendingMentionIds.length === 0) return;
  const byId = new Map<string, Comment>();
  for (const t of threads) {
    for (const c of t.comments) byId.set(c.id, c);
  }
  for (const id of pendingMentionIds) {
    const node = byId.get(id);
    if (node) {
      notify('Mentioned in a comment', `${node.author.display_name}: ${node.body.slice(0, 120)}`);
    }
  }
}

function flattenTocIds(nodes: readonly TocNode[]): string[] {
  const ids: string[] = [];

  const visit = (entries: readonly TocNode[]) => {
    for (const entry of entries) {
      ids.push(entry.id);
      visit(entry.children);
    }
  };

  visit(nodes);
  return ids;
}
