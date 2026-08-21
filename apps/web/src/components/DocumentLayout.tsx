import type { BlockSourceRange } from '@marginalia/renderer/locate-block';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Cross2Icon,
  LetterCaseToggleIcon,
  MagnifyingGlassIcon,
  MixerHorizontalIcon,
} from '@radix-ui/react-icons';
import {
  Badge,
  Button,
  Flex,
  IconButton,
  Popover,
  SegmentedControl,
  Select,
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
import { resolveThreadScrollTarget } from '../lib/anchor-target.js';
import type {
  CommentAnchor,
  Document,
  DocumentSettingsResponse,
  Thread,
  TocNode,
} from '../lib/api.js';
import {
  acceptEditProposal as apiAcceptProposal,
  createComment as apiCreate,
  createEditProposal as apiCreateProposal,
  deleteComment as apiDelete,
  deleteThread as apiDeleteThread,
  rejectEditProposal as apiRejectProposal,
  repairEditProposalAnchor as apiRepairProposalAnchor,
  resolveThread as apiResolve,
  resolveEditProposalConflict as apiResolveConflict,
  restoreHistoryVersion as apiRestoreHistoryVersion,
  revertHistoryVersion as apiRevertHistoryVersion,
  setCommentHidden as apiSetCommentHidden,
  toggleCommentReaction as apiToggleReaction,
  updateComment as apiUpdate,
  updateEditProposal as apiUpdateProposal,
  type Comment,
  fetchThread,
  getDocument,
  getHistoryDiff,
  type HistoryEntry,
  isResolved,
  listThreads,
  uploadAsset,
} from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { loadBlockRanges } from '../lib/block-range-loader.js';
import { buildCommentHighlights } from '../lib/comment-highlights.js';
import { documentTitle } from '../lib/doc-title.js';
import { subscribeToDocumentEvents } from '../lib/events.js';
import { expandAncestors } from '../lib/heading-collapse.js';
import { getClientId, setDisplayName, useDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { savePendingNewDocumentDraft } from '../lib/new-document-draft.js';
import {
  ensureNotificationPermission,
  notify,
  showErrorToast,
  showToast,
} from '../lib/notifications.js';
import {
  measurePages,
  PAGED_CLASS,
  PAGED_VERTICAL_CLASS,
  pageIndexAt,
  pageIndexOfElement,
  pageIndexOfOffset,
} from '../lib/paged-reading.js';
import { partitionPendingMentions } from '../lib/pending-mentions.js';
import { retryRequest } from '../lib/retry.js';
import {
  anchorTouchesSections,
  applySectionFilterToDocument,
  collectBlockSectionIds,
  computeSectionRelations,
  reassertSectionFilterOnDocument,
  threadTouchesSections,
} from '../lib/section-filter.js';
import {
  applyTheme,
  BUILT_IN_THEMES,
  getUserThemeOverride,
  setUserThemeOverride,
} from '../lib/themes.js';
import {
  mergeArchiveThreads,
  mergeOpenThreads,
  threadContainingComment,
  threadIdOfComment,
} from '../lib/thread-reconcile.js';
import {
  COARSE_POINTER,
  readUiScale,
  resetUiScale,
  setUiScale,
  UI_SCALE_MAX,
  UI_SCALE_MIN,
  UI_SCALE_POINTER_DEFAULT,
  UI_SCALE_TOUCH_DEFAULT,
} from '../lib/ui-scale.js';
import { useMediaQuery } from '../lib/useMediaQuery.js';
import { usePagedReading } from '../lib/usePagedReading.js';
import { APP_ACCENT_COLOR } from '../styles/theme.js';
import { AccessControlDialog } from './AccessControlDialog.js';
import { ActivityList } from './ActivityList.js';
import { AppBar } from './AppBar.js';
import { BlockActions } from './BlockActions.js';
import { CopyDocumentDialog } from './CopyDocumentDialog.js';
import { DisplayStepper } from './DisplayStepper.js';
import {
  type DocumentSearchResult,
  DocumentSearchResultsPane,
} from './DocumentSearchResultsPane.js';
import { DocumentSettingsDialog } from './DocumentSettingsDialog.js';
import { DownloadMenu } from './DownloadMenu.js';
import { HistoryList } from './HistoryList.js';
import { FloatingCommentsLayer } from './inline-comments/FloatingCommentsLayer.js';
import { FloatingCommentsToolbar } from './inline-comments/FloatingCommentsToolbar.js';
import { InlineCommentsLayer } from './inline-comments/InlineCommentsLayer.js';
import { InlineCommentsList } from './inline-comments/InlineCommentsList.js';
import { COMMENT_FLASH_MS, type ThreadActionResult } from './inline-comments/inlineUtils.js';
import { PendingCommentPopover } from './inline-comments/PendingCommentPopover.js';
import { McpPanel } from './McpPanel.js';
import { PageJump } from './PageJump.js';
import { ReadAloudControls } from './ReadAloudControls.js';
import { type DocumentSearchOptions, RenderedDoc } from './RenderedDoc.js';
import { ResizeHandle } from './ResizeHandle.js';
import { type ProposalTarget, SelectionToolbar } from './SelectionToolbar.js';
import { ProposalComposer, ProposalEditComposer } from './ThreadComposer.js';
import { Toc } from './Toc.js';

const MAX_WIDTH_KEY = 'marginalia.maxWidth';
const TEXT_ZOOM_KEY = 'marginalia.textZoom';
const TOC_WIDTH_KEY = 'marginalia.tocWidth';
const COMMENTS_WIDTH_KEY = 'marginalia.commentsWidth';
const INLINE_COMMENTS_OPEN_KEY = 'marginalia.inlineCommentsOpen';
const INLINE_COMMENTS_STACKING_KEY = 'marginalia.inlineCommentsStacking';
const INLINE_COMMENTS_HIDE_RESOLVED_KEY = 'marginalia.inlineCommentsHideResolved';
const COMMENTS_DISPLAY_MODE_KEY = 'marginalia.commentsDisplayMode';
const READING_MODE_KEY = 'marginalia.readingMode';
const RIGHT_TAB_KEY = 'marginalia.rightTab';
const COLLAPSED_WIDTH = 36;
/**
 * Text-size range, as a percentage of the theme's own size. The ceiling
 * is generous because the small, dense screens that need it most are the
 * ones where a theme's 19px reads as roughly 13 — a tablet renders CSS
 * pixels at about 1.5x the density a desktop monitor does.
 */
const TEXT_ZOOM_MIN = 80;
const TEXT_ZOOM_MAX = 220;
const DEFAULT_MAX_WIDTH = 72;
/** How long a pane takes to fold away. Published to the stylesheet, which
 *  runs the animation, so the two can't drift apart. */
const PANE_COLLAPSE_MS = 240;

/**
 * Whether a pane's body should still be rendered: `open` says yes at once,
 * `closed` only once the pane has finished shrinking. Unmounting on the
 * click instead would leave an empty box collapsing — and the tab panels
 * on the right are live enough (activity feeds, history, MCP) that keeping
 * them mounted through the closed state isn't an option either.
 */
function usePaneBody(open: boolean): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    // Nothing to wait for where the fade the hold exists to cover has
    // been turned off: it would only park an invisible pane's tabs in
    // the tree a fifth of a second longer. Read per collapse, so a
    // preference changed mid-session takes effect at once.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setMounted(false);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), PANE_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);
  return mounted;
}

/**
 * Viewport width up to which the three-pane layout does more harm than
 * good. Both side panes open cost 580px, so on any iPad in portrait the
 * document is left with a couple of hundred pixels — narrow enough that
 * the comment column hides itself and the toolbar loses its right half
 * off the edge. At or below this width the panes start collapsed and
 * comments float over the text instead of taking a margin column.
 *
 * Read once at mount, never re-read: a rotation mid-session shouldn't
 * yank the panes and the comment presentation out from under the reader.
 */
const COMPACT_LAYOUT_MAX_WIDTH = 1024;

const COMPACT_LAYOUT_QUERY = `(max-width: ${COMPACT_LAYOUT_MAX_WIDTH}px)`;

function isCompactViewport(): boolean {
  return window.matchMedia(COMPACT_LAYOUT_QUERY).matches;
}

/**
 * `.doc-scroll` content-box width at or below which app.css hides the
 * margin comment column outright (`@container (max-width: 700px)`).
 * Compare against that element, not the pane around it, or a reserved
 * scrollbar puts the two a few pixels out of step. Below it, column mode
 * shows no comments at all.
 */
const COMMENTS_COLUMN_MIN_WIDTH = 700;

const EMPTY_BLOCK_RANGES = new Map<string, BlockSourceRange>();
/** Delay before scrolling to a specific reply after the parent thread has expanded (ms). */
const REPLY_SCROLL_DELAY_MS = 900;
const EMPTY_SECTION_FILTER: ReadonlySet<string> = new Set();

interface Props {
  doc: Document;
  /** Called by admin settings when the server-side settings change. */
  onDocSettingsChanged?: (uid: string, s: Partial<DocumentSettingsResponse>) => void;
  children?: ReactNode;
  /** Another document is on its way in and this one is only still here
   *  to keep the shell standing. Dimmed and made inert: it belongs to
   *  the tab the reader has already left. */
  pending?: boolean;
}

interface ThreadFocusTarget {
  threadId: string;
  nonce: number;
  scroll: boolean;
}

/** How comment threads render in the document pane: a margin column, or floating cards over the text. */
type CommentsDisplayMode = 'column' | 'floating';

/** How the document advances: continuous scrolling, or discrete pages like an e-reader. */
type ReadingMode = 'scroll' | 'paged';

type RightTab = 'comments' | 'history' | 'search' | 'activities' | 'mcp';

/**
 * 'search' is deliberately absent: it only exists while a document search
 * has hits, so restoring it would land on a tab that isn't there.
 */
function isRememberedRightTab(value: string | null): value is Exclude<RightTab, 'search'> {
  return value === 'comments' || value === 'history' || value === 'activities' || value === 'mcp';
}

type PendingDraft =
  | { mode: 'comment'; anchor: CommentAnchor }
  | { mode: 'proposal'; target: ProposalTarget; answersThreadIds?: string[] };

/**
 * Failures used to land in a text slot in the document toolbar, which is
 * a horizontally scrolling row with a hidden scrollbar — on a narrow doc
 * pane the message simply drifted off the right edge, so a failed accept
 * left no trace anywhere the user was looking. A toast is the only
 * channel guaranteed to be in view. Thread workflow failures also travel
 * back to the card that started them, which keeps the reason attached to
 * the proposal after the toast expires.
 *
 * Module scope on purpose: nothing here closes over render state, so it
 * never has to appear in a hook dependency list.
 */
function reportFailure(message: string): void {
  showErrorToast('That didn’t work', message);
}

/**
 * Run `fn` once the browser is idle, falling back to a macrotask where
 * `requestIdleCallback` is missing (Safari). Deliberately not cancellable:
 * callers use it for follow-up work that must still land if the user
 * navigates within the document.
 */
function whenIdle(fn: () => void): void {
  if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 1000 });
  else window.setTimeout(fn, 0);
}

export function DocumentLayout({ doc, onDocSettingsChanged, children, pending }: Props) {
  const navigate = useNavigate();
  const canComment = doc.role !== 'reader';
  const [compactViewport] = useState(isCompactViewport);
  /**
   * Where the side panes cost more width than the document can spare,
   * they slide *over* it instead of squeezing it: on a tablet in
   * portrait a 260px pane out of 744 leaves a column too narrow to read,
   * and in paged mode every open/close would repaginate the whole book
   * under the reader. Live, not sampled at mount — rotating the device
   * has to switch modes, and the pane widths are what decide it.
   */
  const overlayPanes = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [tocOpen, setTocOpen] = useState(!compactViewport);
  const [commentsOpen, setCommentsOpen] = useState(!compactViewport);
  /**
   * Overlaid, the two panes would stack on top of each other and bury
   * the document between them, so opening one puts the other away.
   */
  const openToc = useCallback(
    (next: boolean) => {
      setTocOpen(next);
      if (next && overlayPanes) setCommentsOpen(false);
    },
    [overlayPanes],
  );
  const openComments = useCallback(
    (next: boolean) => {
      setCommentsOpen(next);
      if (next && overlayPanes) setTocOpen(false);
    },
    [overlayPanes],
  );
  const closeOverlayPanes = useCallback(() => {
    setTocOpen(false);
    setCommentsOpen(false);
  }, []);
  const overlayPaneOpen = overlayPanes && (tocOpen || commentsOpen);

  // A pane that sat beside the document before a rotation would cover it
  // afterwards. Fold both away as the layout flips rather than dropping a
  // panel over whatever the reader was in the middle of.
  const wasOverlay = useRef(overlayPanes);
  useEffect(() => {
    if (wasOverlay.current === overlayPanes) return;
    wasOverlay.current = overlayPanes;
    if (overlayPanes) closeOverlayPanes();
  }, [overlayPanes, closeOverlayPanes]);

  useEffect(() => {
    if (!overlayPaneOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      closeOverlayPanes();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [overlayPaneOpen, closeOverlayPanes]);
  const [inlineCommentsOpen, setInlineCommentsOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(INLINE_COMMENTS_OPEN_KEY);
    return saved === null ? true : saved === 'true';
  });
  const [inlineCommentsStacking, setInlineCommentsStacking] = useState<boolean>(() => {
    const saved = localStorage.getItem(INLINE_COMMENTS_STACKING_KEY);
    return saved === null ? true : saved === 'true';
  });
  /**
   * Settled threads stay out of the document until asked for, and every
   * visit asks again: a resolved highlight is invisible in the text, so
   * a remembered "show resolved" would leave the reader clicking words
   * that carry no marker and getting a card they closed sessions ago.
   * Opening a resolved thread from elsewhere flips it back on for as
   * long as that reading lasts.
   */
  const [inlineCommentsHideResolved, setInlineCommentsHideResolved] = useState(true);
  /**
   * Only an explicit choice is stored, so an untouched preference stays
   * free to follow the device: the margin column on a desktop, floating
   * cards on a tablet where the column would have nowhere to live.
   */
  const [storedCommentsDisplayMode, setCommentsDisplayMode] = useState<CommentsDisplayMode | null>(
    () => {
      const saved = localStorage.getItem(COMMENTS_DISPLAY_MODE_KEY);
      return saved === 'floating' || saved === 'column' ? saved : null;
    },
  );
  const [readingMode, setReadingMode] = useState<ReadingMode>(() =>
    localStorage.getItem(READING_MODE_KEY) === 'paged' ? 'paged' : 'scroll',
  );
  /**
   * Set when this engine turns out not to paint the sideways pagination
   * (see the effect below), which switches the reader to vertical pages.
   * Kept apart from `readingMode` because it is a property of this
   * document at this text size, not a choice they made.
   */
  const [tooWideForPages, setTooWideForPages] = useState(false);
  const paged = readingMode === 'paged';
  /** Pages run down the screen rather than across — same mode, other axis. */
  const pagedVertical = paged && tooWideForPages;
  const commentsDisplayMode: CommentsDisplayMode =
    storedCommentsDisplayMode ?? (compactViewport ? 'floating' : 'column');
  /**
   * Paged mode leaves the margin column nothing to stack against — its
   * cards are placed down a vertical axis the paginated document no
   * longer has — so cards float over the page there regardless of the
   * stored preference, which stays untouched for the way back.
   */
  const floatingComments = paged || commentsDisplayMode === 'floating';
  const [rightTab, setRightTab] = useState<RightTab>(() => {
    const saved = localStorage.getItem(RIGHT_TAB_KEY);
    return isRememberedRightTab(saved) ? saved : 'comments';
  });
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
    return Number.isFinite(saved) && saved > 0 ? saved : DEFAULT_MAX_WIDTH;
  });
  /** Mirrors the stored interface size so the stepper has something to show. */
  const [uiScale, setUiScaleState] = useState<number>(readUiScale);
  /* Live rather than read once, so what the reset advertises and what it
     lands on stay the same answer on a convertible that gains a keyboard
     mid-session. */
  const uiScaleDefault = useMediaQuery(COARSE_POINTER)
    ? UI_SCALE_TOUCH_DEFAULT
    : UI_SCALE_POINTER_DEFAULT;
  const [textZoom, setTextZoom] = useState<number>(() => {
    const saved = Number(localStorage.getItem(TEXT_ZOOM_KEY));
    return Number.isFinite(saved) && saved >= TEXT_ZOOM_MIN && saved <= TEXT_ZOOM_MAX ? saved : 100;
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
  /**
   * An empty list reads as "no comments here", so the first read of a
   * document has to say it is still going — `threadsLoaded` is a ref and
   * cannot drive a render. Only the initial per-document read flips this;
   * later refreshes redraw threads that are already on screen.
   */
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadTabVisibleCount, setThreadTabVisibleCount] = useState<{
    docUid: string;
    sourceThreads: Thread[];
    count: number;
  } | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<string[]>([]);
  /**
   * Full thread/document reads are authoritative snapshots, but the network
   * does not preserve their freshness order. Only the newest read that was
   * started may replace local state; entity-level mutation responses bump the
   * same counter so a read begun before that mutation cannot undo it.
   */
  const threadSnapshotRequestRef = useRef(0);
  const documentRefreshRequestRef = useRef(0);
  /**
   * Set only while the initial archive read is in flight; collects the ids
   * of threads reconciled locally in that window so the merge does not
   * overwrite them with the older archive copy. Null the rest of the time —
   * once the archive has landed there is nothing to protect against.
   */
  const archiveMergeGuard = useRef<Set<string> | null>(null);
  /** The document the in-flight archive read belongs to, so a stale one
   * cannot merge settled threads into a document that has since changed. */
  const archiveUidRef = useRef<string>('');
  /**
   * Current threads, readable from the realtime callback. The subscription
   * must not re-run per keystroke of somebody else's comment, so it cannot
   * close over `threads` itself.
   */
  const threadsRef = useRef<Thread[]>([]);
  /** Reaction controls are local to a comment row. Keep a resource-level
   * queue as well so duplicate renderings of the same comment cannot toggle
   * it concurrently. Different comments may still update in parallel. */
  const reactionQueuesRef = useRef<Map<string, Promise<void>>>(new Map());
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const pendingAnchor = pendingDraft?.mode === 'comment' ? pendingDraft.anchor : null;
  const pendingProposalTarget = pendingDraft?.mode === 'proposal' ? pendingDraft.target : null;
  const pendingProposalAnswersThreadIds =
    pendingDraft?.mode === 'proposal' ? pendingDraft.answersThreadIds : undefined;
  /**
   * Proposal thread whose text is being revised in the edit dialog.
   * A snapshot on purpose: thread refreshes while the dialog is open
   * must not clobber the text under the author's cursor. Unlike
   * `pendingDraft` it survives liveSource changes — the revision is
   * re-anchored server-side against current main on submit anyway.
   */
  const [editingProposal, setEditingProposal] = useState<Thread | null>(null);
  const [focusedThread, setFocusedThread] = useState<ThreadFocusTarget | null>(null);
  /** Mirror of `doc.source` and `doc.rendered`, mutated when a proposal is
   *  accepted (auto-merged) so the displayed doc stays fresh without a reload. */
  const [liveSource, setLiveSource] = useState<string>(doc.source);
  const [liveRendered, setLiveRendered] = useState(doc.rendered);

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
    // The edit dialog only dies with the document: its thread id and
    // text live server-side and are rebuilt against current main on
    // submit, so a liveSource refresh doesn't invalidate it.
    if (trackedDocUid !== doc.uid) setEditingProposal(null);
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

  /**
   * Whether a thread list has ever been applied for this document.
   *
   * An empty column is indistinguishable from a document with no
   * comments, so a load that never succeeded has to be remembered
   * rather than inferred: it is what tells the realtime reconnect
   * handler to fetch instead of skip.
   */
  const threadsLoaded = useRef(false);

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
   * Per-block source ranges are needed for selection comments and proposal
   * source extraction, but not to display the server-rendered document.
   * Load the format-specific parser after the first paint so Markdown pages
   * never pull in Asciidoctor and neither parser delays the document shell.
   */
  const [loadedBlockRanges, setLoadedBlockRanges] = useState<{
    uid: string;
    source: string;
    format: Document['format'];
    ranges: Map<string, BlockSourceRange>;
  } | null>(null);
  const blockRangesAvailable =
    loadedBlockRanges?.uid === doc.uid && loadedBlockRanges.format === doc.format;
  const blockRangesReady = blockRangesAvailable && loadedBlockRanges.source === liveSource;
  const blockRanges = blockRangesAvailable ? loadedBlockRanges.ranges : EMPTY_BLOCK_RANGES;
  const blockRangeSource = blockRangesAvailable ? loadedBlockRanges.source : liveSource;

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void loadBlockRanges(liveSource, doc.format).then(
        (ranges) => {
          if (!cancelled) {
            setLoadedBlockRanges({ uid: doc.uid, source: liveSource, format: doc.format, ranges });
          }
        },
        (err) => reportError('DocumentLayout.blockRanges', err, { uid: doc.uid }),
      );
    };
    const idleHandle = window.requestIdleCallback?.(load, { timeout: 750 });
    const timeoutHandle = idleHandle === undefined ? window.setTimeout(load, 0) : undefined;
    return () => {
      cancelled = true;
      if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle);
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle);
    };
  }, [doc.uid, doc.format, liveSource]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: doc.uid is kept so a doc swap reseeds live state even if the new doc has identical source/rendered strings.
  useEffect(() => {
    // A parent-provided document is newer than any refresh already in flight.
    documentRefreshRequestRef.current += 1;
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
    const requestId = ++documentRefreshRequestRef.current;
    try {
      const fresh = await getDocument(doc.uid);
      if (requestId !== documentRefreshRequestRef.current) return;
      setLiveSource(fresh.source);
      setLiveRendered(fresh.rendered);
    } catch (err) {
      if (requestId !== documentRefreshRequestRef.current) return;
      reportError('DocumentLayout.refreshDoc', err, { uid: doc.uid });
    }
  }, [doc.uid]);

  /** Merge one thread into the list, in the order the server would return it. */
  const landThread = useCallback((thread: Thread) => {
    // A snapshot requested before this mutation completed is stale now.
    threadSnapshotRequestRef.current += 1;
    archiveMergeGuard.current?.add(thread.id);
    setThreads((prev) => {
      const index = prev.findIndex((t) => t.id === thread.id);
      const next = index >= 0 ? prev.map((t, i) => (i === index ? thread : t)) : [...prev, thread];
      next.sort((a, b) => a.comments[0].created_at - b.comments[0].created_at);
      return next;
    });
  }, []);

  threadsRef.current = threads;

  /** Remove a thread that has been deleted or is no longer visible here. */
  const dropThread = useCallback((threadId: string) => {
    threadSnapshotRequestRef.current += 1;
    archiveMergeGuard.current?.add(threadId);
    setThreads((prev) => prev.filter((t) => t.id !== threadId));
  }, []);

  /**
   * Re-read threads the server resolved as a side effect of a mutation.
   *
   * Accepting a proposal also resolves the plain comment threads it
   * answers. Every other client hears about those through `comment.updated`;
   * the acting client is deliberately excluded from that broadcast, and the
   * reconcile behind it reads only the open set — where a thread that has
   * just been resolved no longer appears. So without this the accepting
   * user's own list keeps showing them open until a full refresh.
   *
   * The response names them but not their new shape, so read each one back
   * rather than reconstructing it here: the server decides `capabilities`
   * and `resolution`, which are what the card renders. Never rejects — this
   * corrects what the reader cannot see yet and must not fail the accept.
   */
  const landAnsweredThreads = useCallback(
    async (threadIds: readonly string[]) => {
      await Promise.all(
        threadIds.map((threadId) => {
          archiveMergeGuard.current?.add(threadId);
          return fetchThread(doc.uid, threadId).then(
            (thread) => {
              if (thread) landThread(thread);
              else dropThread(threadId);
            },
            (err) => {
              reportError('DocumentLayout.landAnsweredThreads', err, { uid: doc.uid, threadId });
            },
          );
        }),
      );
    },
    [doc.uid, landThread, dropThread],
  );

  /*
   * Reconcile the thread list after a local mutation, without making the
   * reader wait for it.
   *
   * Every one of these handlers has already applied what changed — the
   * mutation response carries the authoritative thread, and the ones that
   * delete or react update their own row. The full read exists only to
   * catch what the response cannot describe: accepting a proposal
   * resolves the threads it answers, deleting one unlinks them. That is a
   * safety net, and a safety net must not block the UI.
   *
   * It used to be awaited. On a long review the read is hundreds of
   * kilobytes, and one measured edit sat for thirty seconds with the
   * PATCH long since answered in twenty-eight milliseconds — the comment
   * was saved and the interface simply stopped.
   */
  const reconcileRunning = useRef(false);
  const reconcileQueued = useRef(false);
  const reconcileOpenThreadsRef = useRef<(() => Promise<void>) | null>(null);
  const reconcileThreadsSoon = useCallback(() => {
    // Held until the read settles, not just until it starts. Clearing it
    // earlier would let every mutation made while a read was in flight
    // start another one, so a burst of them — resolving a run of threads,
    // say — would put a read in flight for each instead of one for all.
    if (reconcileRunning.current) {
      reconcileQueued.current = true;
      return;
    }
    reconcileRunning.current = true;
    whenIdle(async () => {
      try {
        // Anything asked for while a read was running is answered by one
        // more read, rather than by one per request.
        do {
          reconcileQueued.current = false;
          await reconcileOpenThreadsRef.current?.();
        } while (reconcileQueued.current);
      } finally {
        reconcileRunning.current = false;
      }
    });
  }, []);

  const refreshThreads = useCallback(async () => {
    // Matched to what this session asked for. A reconnect has to distrust
    // everything local, but only for the part the reader wanted: pulling
    // the archive to recover someone who never asked to see settled work
    // would put the whole load-time payload back on the wire.
    //
    // Keyed to the asking, not to whether it arrived. A failed archive read
    // toasts "Reconnecting will retry", and this is the retry — keying it
    // to success would leave the reader who most needs it, the one whose
    // read failed, as the only one it never runs for.
    const withArchive = archiveWanted.current;
    const requestId = ++threadSnapshotRequestRef.current;
    try {
      const res = await retryRequest(() =>
        listThreads(
          doc.uid,
          withArchive
            ? { consumeMentions: false, fresh: true }
            : { state: 'open', consumeMentions: false, fresh: true },
        ),
      );
      if (requestId !== threadSnapshotRequestRef.current) return;
      // Without the archive the fresh open set is not the whole document,
      // so it is merged rather than swapped in — a resolved thread pulled
      // in on its own, by a deep link or a mutation, has to survive.
      setThreads((prev) => (withArchive ? res.threads : mergeOpenThreads(prev, res.threads)));
      // This read was the whole document, so the archive is present again
      // however the last attempt at it ended. Latch it so the next trigger
      // does not fetch it a second time.
      if (withArchive) archiveLoad.current = Promise.resolve();
      setMentionCandidates(res.mention_candidates);
      threadsLoaded.current = true;
    } catch (err) {
      if (requestId !== threadSnapshotRequestRef.current) return;
      reportError('DocumentLayout.refreshThreads', err, { uid: doc.uid });
    }
  }, [doc.uid]);

  /*
   * The read a mutation triggers: the open threads only.
   *
   * `refreshThreads` above re-reads the whole document, which is what a
   * reconnect needs — events were missed, so nothing local can be
   * trusted. A mutation is not that: the change is already applied, and
   * everything settled is still settled. Re-reading it costs 3.17 MB
   * against 32 KB on the document that prompted this.
   */
  const reconcileOpenThreads = useCallback(async () => {
    const requestId = ++threadSnapshotRequestRef.current;
    try {
      const res = await retryRequest(() =>
        listThreads(doc.uid, { state: 'open', consumeMentions: false, fresh: true }),
      );
      if (requestId !== threadSnapshotRequestRef.current) return;
      setThreads((prev) => mergeOpenThreads(prev, res.threads));
      setMentionCandidates(res.mention_candidates);
      threadsLoaded.current = true;
    } catch (err) {
      if (requestId !== threadSnapshotRequestRef.current) return;
      reportError('DocumentLayout.reconcileOpenThreads', err, { uid: doc.uid });
    }
  }, [doc.uid]);
  useEffect(() => {
    reconcileOpenThreadsRef.current = reconcileOpenThreads;
  }, [reconcileOpenThreads]);

  /*
   * The resolved archive, read the first time something needs it.
   *
   * This is the largest thing the page ever fetches: one measured document
   * answers `state=all` with 2343 threads and 518 KB against 6.5 KB for the
   * open set, and 98% of it is settled. A default load renders none of it —
   * the thread list opens filtered to unresolved and resolved highlights are
   * invisible until switched on — so it was 518 KB spent on what the reader
   * cannot see.
   *
   * Every path that can put settled work on screen calls this first: showing
   * resolved threads or highlights, searching, following a link into one, or
   * a mention that turns out to live in one. Reads once per document and
   * remembers; a failure clears the latch so a later trigger can retry.
   */
  const archiveLoad = useRef<Promise<void> | null>(null);
  /** Whether anything has asked for the archive, however that ask ended. */
  const archiveWanted = useRef(false);
  const undeliveredMentions = useRef<string[]>([]);
  const ensureArchive = useCallback((): Promise<void> => {
    archiveWanted.current = true;
    const existing = archiveLoad.current;
    if (existing) return existing;
    const uid = doc.uid;
    // Threads reconciled locally while this read is in flight. It answers a
    // question asked before those landed, so it must not undo them.
    const mutatedDuringArchiveRead = new Set<string>();
    archiveMergeGuard.current = mutatedDuringArchiveRead;
    const releaseGuard = () => {
      if (archiveMergeGuard.current === mutatedDuringArchiveRead) {
        archiveMergeGuard.current = null;
      }
    };
    const run = retryRequest(() =>
      listThreads(uid, { state: 'all', consumeMentions: false, fresh: true }),
    ).then(
      (r) => {
        if (uid !== archiveUidRef.current) return;
        setMentionCandidates(r.mention_candidates);
        setThreads((prev) => mergeArchiveThreads(prev, r.threads, mutatedDuringArchiveRead));
        releaseGuard();
      },
      (err) => {
        releaseGuard();
        archiveLoad.current = null;
        if (uid !== archiveUidRef.current || isAbortError(err)) return;
        reportError('DocumentLayout.listThreads.archive', err, { uid });
        // The open threads are already on screen, so this is a partial
        // failure: say what is missing rather than claiming the column
        // failed to load.
        reportFailure(
          apiErrorMessage(err, 'Could not load resolved comments. Reconnecting will retry.'),
        );
      },
    );
    archiveLoad.current = run;
    return run;
  }, [doc.uid]);

  const scrollToAnchor = useCallback(
    (blockId: string, quote?: string | null, threadId?: string, scrollOffset = 0): boolean => {
      const root = docRef.current;
      const scroll = docScrollRef.current;
      if (!root || !scroll) return false;

      const target = resolveThreadScrollTarget(root, blockId, quote, threadId);
      if (!target) return false;

      // Every navigation to a thread also marks its card, so the reader
      // can tell WHICH thread they landed on — essential when several
      // threads highlight the same text. `scroll: false`: the anchor
      // scroll below already brings the card into view.
      if (threadId) {
        setFocusedThread((prev) => ({ threadId, nonce: (prev?.nonce ?? 0) + 1, scroll: false }));
      }

      // Reveal the target if it sits inside a folded section before
      // measuring — otherwise the scroll lands at the pre-expansion
      // offset and the user ends up at an empty spot. The seq guard
      // discards a stale promise if another thread is clicked during
      // the expand window.
      const seq = ++scrollToAnchorSeq.current;
      void expandAncestors(target).then(() => {
        if (seq !== scrollToAnchorSeq.current) return;
        scrollToTargetAndSettle(scroll, target, scrollOffset, () => {
          return seq === scrollToAnchorSeq.current;
        });
        flashAnchor(target);
      });
      return true;
    },
    [],
  );

  // Reactive across UserMenu, composer, invite-load seeding, other tabs.
  const displayName = useDisplayName();
  const effectiveDisplayName = displayName;
  const [theme, setTheme] = useState<string>(
    () => getUserThemeOverride(doc.uid) ?? doc.default_theme,
  );

  const docRef = useRef<HTMLElement>(null);
  const docPaneRef = useRef<HTMLElement>(null);
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
  // Deliberately not persisted — see the state declaration. Drop what
  // earlier builds stored so a remembered "show resolved" can't outlive
  // them.
  useEffect(() => {
    localStorage.removeItem(INLINE_COMMENTS_HIDE_RESOLVED_KEY);
  }, []);
  useEffect(() => {
    localStorage.setItem(READING_MODE_KEY, readingMode);
  }, [readingMode]);
  // The key exists exactly when there is an explicit choice to remember,
  // so a value written by an older build — or by hand — is cleared rather
  // than left behind for every later read to step over.
  useEffect(() => {
    if (storedCommentsDisplayMode) {
      localStorage.setItem(COMMENTS_DISPLAY_MODE_KEY, storedCommentsDisplayMode);
    } else {
      localStorage.removeItem(COMMENTS_DISPLAY_MODE_KEY);
    }
  }, [storedCommentsDisplayMode]);
  useEffect(() => {
    if (isRememberedRightTab(rightTab)) localStorage.setItem(RIGHT_TAB_KEY, rightTab);
  }, [rightTab]);
  useEffect(() => {
    void applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    setTheme(getUserThemeOverride(doc.uid) ?? doc.default_theme);
  }, [doc.uid, doc.default_theme]);

  useEffect(() => {
    if (!canComment) setPendingDraft(null);
  }, [canComment]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: inlineCommentsOpen / commentsDisplayMode are the intentional re-run triggers so the column is re-measured when the panel toggles or the column (un)mounts.
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
  }, [inlineCommentsOpen, commentsDisplayMode]);

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
    // inside focused sections are free and shouldn't pay any pass at
    // all, and the enforce-only re-assert flips just the wrappers that
    // drifted — no undo sweep, no event storm for other listeners.
    // The event fires on the `.collapse-section` wrapper, whose
    // previous sibling is its heading.
    const reassert = (event: Event) => {
      if (applying) return;
      const wrapper = event.target instanceof HTMLElement ? event.target : null;
      const headingId = wrapper?.previousElementSibling?.id;
      const relation = headingId ? sectionRelations.get(headingId) : undefined;
      if (relation !== 'unrelated' && relation !== 'ancestor') return;
      applying = true;
      reassertSectionFilterOnDocument(root, sectionRelations);
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
      const containerRect = container.getBoundingClientRect();
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

      // Paged mode has no "how far down the page" to threshold against:
      // a heading counts as reached once its page is the one on screen.
      // Metrics are hoisted out of the loop — reading clientWidth per
      // heading would force a layout on every one of them.
      const pitch = paged ? measurePages(container).pitch : 0;
      const scrolled = pagedVertical ? container.scrollTop : container.scrollLeft;
      const currentPage = paged ? pageIndexAt(scrolled, pitch) : 0;
      const threshold = containerRect.top + 96;

      for (const heading of visible) {
        const rect = heading.getBoundingClientRect();
        const start = pagedVertical
          ? rect.top - containerRect.top + scrolled
          : rect.left - containerRect.left + scrolled;
        const reached = paged
          ? pageIndexOfOffset(start, pitch) <= currentPage
          : rect.top <= threshold;
        if (reached) {
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
    // `paged` re-runs the scan: switching layout fires neither scroll
    // nor resize, so the highlight would sit on a stale heading.
  }, [headingIdsKey, liveRendered.html, paged, pagedVertical]);

  /**
   * A section fragment in the URL goes stale the moment the reader moves
   * on — scrolling away, jumping to comments — yet it would sit in the
   * address bar forever. Track where a fragment navigation settled and
   * drop the fragment once the active section leaves that baseline.
   * (#comment- fragments are consumed by the deep-link effect instead.)
   */
  const activeHeadingIdRef = useRef<string | null>(null);
  const hashKeeperSyncRef = useRef<(() => void) | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: headingIdsKey is the deduped stand-in for headingIds.
  useEffect(() => {
    const scroll = docScrollRef.current;
    if (!scroll) return;
    const headingIdSet = new Set(headingIds);
    let tracked: { hash: string; baseline: string | null } | null = null;
    let settleTimer: number | null = null;

    const sectionIdOf = (hash: string): string | null => {
      if (hash.length <= 1) return null;
      let id = hash.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        // keep the raw id
      }
      return headingIdSet.has(id) ? id : null;
    };

    /** Record where a fragment navigation parked the reader (scroll idle). */
    const settle = () => {
      const hash = window.location.hash;
      const id = sectionIdOf(hash);
      if (!id) {
        tracked = null;
        return;
      }
      if (tracked?.hash !== hash) tracked = { hash, baseline: null };
      if (tracked.baseline === null) tracked.baseline = activeHeadingIdRef.current;
    };

    /** Drop the fragment once the reader has moved to another section. */
    const sync = () => {
      const hash = window.location.hash;
      const id = sectionIdOf(hash);
      if (!id) {
        tracked = null;
        return;
      }
      if (tracked?.hash !== hash) tracked = { hash, baseline: null };
      const active = activeHeadingIdRef.current;
      if (active === id) {
        // Reader is at the fragment's own section — it's accurate.
        tracked.baseline = id;
        return;
      }
      // Never clear before the navigation has settled somewhere (a smooth
      // scroll toward the target passes through other sections).
      if (tracked.baseline === null || active === tracked.baseline) return;
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
      tracked = null;
    };

    hashKeeperSyncRef.current = sync;
    const onScroll = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(settle, 320);
    };
    scroll.addEventListener('scroll', onScroll, { passive: true });
    // Fragment navigations that need no scrolling never fire a scroll
    // event — record their baseline shortly after (re)load as well.
    const initialTimer = window.setTimeout(settle, 600);
    return () => {
      hashKeeperSyncRef.current = null;
      scroll.removeEventListener('scroll', onScroll);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      window.clearTimeout(initialTimer);
    };
  }, [headingIdsKey]);

  useEffect(() => {
    activeHeadingIdRef.current = activeHeadingId;
    hashKeeperSyncRef.current?.();
  }, [activeHeadingId]);

  useEffect(() => {
    if (!docSearchOpen) return;
    const input = docSearchInputRef.current;
    if (!input) return;
    const frame = window.requestAnimationFrame(() => input.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [docSearchOpen]);

  useEffect(() => {
    if (!docSearchOpen) return;
    openComments(true);
  }, [docSearchOpen, openComments]);

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

  /*
   * Opening a document reads the open threads and nothing else.
   *
   * The archive is fetched by `ensureArchive`, on demand. Mention
   * consumption moves here with the read that now happens on load: it is a
   * server-side side effect that may only happen once, so it cannot sit on
   * a read that may never be made. What it costs is that a mention inside a
   * settled thread has no comment to name yet — those ids are carried over
   * and delivered once the archive arrives.
   */
  useEffect(() => {
    let cancelled = false;
    threadsLoaded.current = false;
    setThreadsLoading(true);
    const requestId = ++threadSnapshotRequestRef.current;
    archiveUidRef.current = doc.uid;
    archiveLoad.current = null;
    archiveWanted.current = false;
    undeliveredMentions.current = [];

    retryRequest(() => listThreads(doc.uid, { state: 'open' })).then(
      (r) => {
        if (cancelled) return;
        setThreadsLoading(false);
        // A mutation that landed while this was in flight outranks it.
        if (requestId === threadSnapshotRequestRef.current) {
          setThreads(r.threads);
          threadsLoaded.current = true;
        }
        setMentionCandidates(r.mention_candidates);
        // Consumed server-side already, so anything not deliverable from
        // the open threads has to be chased rather than dropped. The effect
        // below does the delivering — this only has to make sure the
        // threads it needs get fetched.
        undeliveredMentions.current = r.pending_mentions;
        if (r.pending_mentions.length > 0) void ensureArchive();
      },
      (err) => {
        if (cancelled) return;
        // The read is over either way; a pane still claiming to load
        // would outlast the failure toast below.
        setThreadsLoading(false);
        if (requestId !== threadSnapshotRequestRef.current || isAbortError(err)) return;
        reportError('DocumentLayout.listThreads', err, { uid: doc.uid });
        // Silence here reads as "this document has no comments" — the
        // column, the highlights and the thread count all agree on it.
        // Say so instead; the realtime reconnect below is what actually
        // recovers, and this explains the gap until it does.
        reportFailure(
          apiErrorMessage(err, 'Could not load comments. They will reappear once you reconnect.'),
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [doc.uid, ensureArchive]);

  // Show resolved threads anywhere and the archive has to be there.
  useEffect(() => {
    if (!inlineCommentsHideResolved) void ensureArchive();
  }, [inlineCommentsHideResolved, ensureArchive]);

  /*
   * Deliver pending mentions as soon as a thread carrying one is on screen.
   *
   * Driven by the threads themselves rather than by whichever read produced
   * them, because the reads race: a remembered "show all" filter starts the
   * archive on mount, alongside the open read that discovers what is still
   * pending. Either can land first, so neither can be the one place that
   * delivers — the archive would find nothing pending yet and then latch,
   * and the open read would get a settled promise back. The server has
   * already cleared these, so a miss here is a notification nobody gets.
   */
  useEffect(() => {
    if (undeliveredMentions.current.length === 0) return;
    undeliveredMentions.current = notifyPendingMentions(threads, undeliveredMentions.current);
  }, [threads]);

  // Process a pending deep-link comment once threads have loaded.
  useEffect(() => {
    const commentId = pendingDeepLinkCommentId.current;
    // Emptiness is now an answer, not a wait: a document whose threads are
    // all settled reads back no open ones, and bailing out on length would
    // never reach the archive fetch below — which is exactly where a link
    // from a mention notification points.
    if (!commentId || !threadsLoaded.current) return;

    const thread = threads.find((t) => t.comments.some((c) => c.id === commentId));
    if (!thread) {
      // A link into a settled thread lands before the archive does. Keep
      // the id pending and fetch it; this effect re-runs when it merges.
      void ensureArchive();
      return;
    }

    // Clear so subsequent thread refreshes don't re-scroll.
    pendingDeepLinkCommentId.current = null;

    // Ensure the inline comments column is visible. In floating mode
    // there is no column, and forcing the flag would clobber the
    // user's persisted column preference.
    if (!floatingComments) setInlineCommentsOpen(true);
    // A link to a settled thread is still a request to read it.
    if (isResolved(thread)) setInlineCommentsHideResolved(false);

    // The fragment is consumed now — drop it from the address bar so it
    // doesn't outlive the navigation it described.
    if (window.location.hash.startsWith('#comment-')) {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }

    // Scroll the DOCUMENT to the thread's anchor (which also focuses and
    // flashes its card). Scrolling the card into view instead would use
    // the card's current stacked position — unrelated to the anchor while
    // the column is stacked at the top on load. Threads whose anchor no
    // longer resolves fall back to centering the card itself.
    const blockId = thread.anchor.block_id;
    const jumped = blockId ? scrollToAnchor(blockId, thread.anchor.quote, thread.id) : false;
    if (!jumped) {
      setFocusedThread((prev) => ({
        threadId: thread.id,
        nonce: (prev?.nonce ?? 0) + 1,
        scroll: true,
      }));
    }

    // For reply comments, additionally scroll to and flash the specific reply
    // element after the thread card has had time to expand.
    const isReply = thread.comments[0]?.id !== commentId;
    if (!isReply) return;

    // innerTimer is assigned inside the outer callback; the ref lets the
    // cleanup cancel it even if the component unmounts after the outer fires.
    const innerTimer = { current: null as number | null };
    const outerTimer = window.setTimeout(() => {
      const el = document.getElementById(`comment-${commentId}`);
      const scroll = docScrollRef.current;
      if (!el || !scroll) return;
      // Usually the anchor scroll has already pinned the thread card at
      // the top, reply row in view — then only flash. If the row sits
      // outside the viewport (very long thread, interrupted scroll),
      // supersede the anchor settle and center the row itself.
      const rowRect = el.getBoundingClientRect();
      const scrollRect = scroll.getBoundingClientRect();
      const fullyVisible = rowRect.top >= scrollRect.top && rowRect.bottom <= scrollRect.bottom;
      if (!fullyVisible) {
        const seq = ++scrollToAnchorSeq.current;
        const centerOffset = Math.max(0, (scroll.clientHeight - rowRect.height) / 2);
        scrollToTargetAndSettle(scroll, el, centerOffset, () => seq === scrollToAnchorSeq.current);
      }
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
    // threads is the real trigger; scrollToAnchor is a stable useCallback;
    // setInlineCommentsOpen/setFocusedThread are stable useState dispatchers;
    // pendingDeepLinkCommentId is a ref (not reactive).
  }, [threads, floatingComments, scrollToAnchor, ensureArchive]);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        void refreshThreads();
      }, 300);
    }

    /*
     * Realtime reconciliation is per thread, not per document.
     *
     * Every one of these events used to schedule a full `state=all` read.
     * On a document with a large review history that is megabytes re-read,
     * re-parsed and re-rendered because one person typed one reply — and
     * during an active discussion it repeated every few seconds. The event
     * already names the thread that changed, so read back just that one.
     *
     * The server is still the authority on the thread's wire shape: this
     * re-reads the thread rather than reconstructing it from the event
     * payload, so the card cannot drift from what a full read would say.
     */
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    function reconcileThread(threadId: string) {
      // Coalesce a burst on one thread — a reply and its mention arrive
      // together — while leaving different threads independent.
      const queued = pending.get(threadId);
      if (queued) clearTimeout(queued);
      pending.set(
        threadId,
        setTimeout(() => {
          pending.delete(threadId);
          if (cancelled) return;
          archiveMergeGuard.current?.add(threadId);
          fetchThread(doc.uid, threadId).then(
            (thread) => {
              if (cancelled) return;
              // Null means gone or no longer visible to this viewer;
              // either way it should leave the column.
              if (thread) landThread(thread);
              else dropThread(threadId);
            },
            (err) => {
              if (cancelled) return;
              // Fall back to a full reconcile rather than leaving the
              // column showing a thread that has moved on without it.
              reportError('DocumentLayout.reconcileThread', err, { uid: doc.uid, threadId });
              scheduleRefresh();
            },
          );
        }, 150),
      );
    }

    void ensureNotificationPermission();
    const sub = subscribeToDocumentEvents(
      doc.uid,
      (event) => {
        switch (event.type) {
          case 'comment.created':
          case 'comment.updated': {
            const id = threadIdOfComment(event.comment);
            if (id) reconcileThread(id);
            else scheduleRefresh();
            break;
          }
          case 'edit_proposal.updated': {
            const id = typeof event.edit_proposal.id === 'string' ? event.edit_proposal.id : null;
            if (id) reconcileThread(id);
            else scheduleRefresh();
            break;
          }
          case 'comment.deleted': {
            // A deleted root leaves outright; a deleted reply means its
            // root has to be re-read to lose that reply.
            const root = threadContainingComment(threadsRef.current, event.comment_id);
            if (root === event.comment_id || root === null) dropThread(event.comment_id);
            else reconcileThread(root);
            break;
          }
          case 'edit_proposal.deleted': {
            dropThread(event.edit_proposal_id);
            break;
          }
          case 'mention.created': {
            const requestId = ++threadSnapshotRequestRef.current;
            void listThreads(doc.uid)
              .then((res) => {
                if (cancelled) return;
                notifyPendingMentions(res.threads, res.pending_mentions);
                if (requestId !== threadSnapshotRequestRef.current) return;
                setThreads(res.threads);
                setMentionCandidates(res.mention_candidates);
              })
              .catch((err) => {
                if (cancelled || requestId !== threadSnapshotRequestRef.current) return;
                reportError('DocumentLayout.mention.created', err, { uid: doc.uid });
              });
            break;
          }
          case 'edit_proposal.created': {
            const raw = event.edit_proposal as Record<string, unknown>;
            const id = typeof raw.id === 'string' ? raw.id : null;
            if (id) reconcileThread(id);
            else scheduleRefresh();
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
      },
      {
        /*
         * Whatever took the socket down took the thread reads with it —
         * a server restart mid-navigation (a redeploy landing between
         * the document GET and the thread GET) leaves the column empty
         * for the rest of the session, and a drop later on silently
         * swallows every comment posted while it was gone. Reconcile on
         * the way back up. The threadsLoaded guard is what separates
         * "recover a load that never happened" (fetch now) from "catch
         * up on missed events" (coalesce with any pending refresh).
         */
        onReconnect: () => {
          if (cancelled) return;
          if (threadsLoaded.current) scheduleRefresh();
          else void refreshThreads();
        },
      },
    );
    return () => {
      cancelled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
      sub.close();
    };
  }, [doc.uid, refreshThreads, landThread, dropThread]);

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

  const onCreate = useCallback(
    async (payload: { anchor: CommentAnchor; body: string; display_name?: string }) => {
      if (!canComment) {
        reportFailure('You have read-only access to this document.');
        return;
      }
      const identity = resolveIdentity(payload.display_name);
      if (!identity) {
        reportFailure('Please set your display name first.');
        return;
      }
      try {
        const created = await apiCreate(
          doc.uid,
          { anchor: payload.anchor, body: payload.body },
          identity,
        );
        // Land the new thread before dropping the draft, in one commit.
        // Waiting for the refresh instead leaves a gap with neither the
        // draft's highlight nor the thread's — on a heavily commented
        // document that re-read takes about a second, and the reader
        // watches their own highlight blink out and come back.
        landThread(created);
        setPendingDraft(null);
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
        reconcileThreadsSoon();
      } catch (err) {
        reportError('DocumentLayout.createComment', err, { uid: doc.uid });
        reportFailure(apiErrorMessage(err, 'Could not post that comment'));
      }
    },
    [
      canComment,
      doc.uid,
      landThread,
      resolveIdentity,
      reconcileThreadsSoon,
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
        const updated = await apiCreate(doc.uid, { parent_id: threadId, body }, identity);
        landThread(updated);
        reconcileThreadsSoon();
      } catch (err) {
        reportError('DocumentLayout.replyToThread', err, { uid: doc.uid, threadId });
        reportFailure(apiErrorMessage(err, 'Could not post that reply'));
      }
    },
    [doc.uid, landThread, resolveIdentity, reconcileThreadsSoon],
  );

  const onResolveThread = useCallback(
    async (
      id: string,
      kind: 'resolve' | 'reopen' | 'accept' | 'reject',
      body?: string,
      name?: string,
    ): Promise<ThreadActionResult> => {
      const identity = resolveIdentity(name);
      if (!identity) {
        // Match the other identity-gated actions in this file — without
        // this, the diff dialog's Accept/Reject just silently no-ops for
        // generic invitees who haven't set a display name yet.
        const message = 'Please set your display name first.';
        reportFailure(message);
        return { ok: false, message };
      }
      try {
        if (kind === 'resolve' || kind === 'reopen') {
          const updated = await apiResolve(doc.uid, id, kind === 'resolve', identity, body);
          landThread(updated);
          reconcileThreadsSoon();
        } else if (kind === 'accept') {
          const {
            thread: updated,
            document: accepted,
            resolvedAnsweredThreadIds,
          } = await apiAcceptProposal(doc.uid, id, identity, body);
          landThread(updated);
          // The response already carries the rewritten document, so only fall
          // back to a re-fetch if an older server left it out.
          if (accepted) {
            setLiveSource(accepted.source);
            setLiveRendered(accepted.rendered);
            // A snapshot requested before this accept described the old text.
            documentRefreshRequestRef.current += 1;
            // The new text and the card's own state are what the user is
            // waiting on, and both are in hand now. Re-reading the thread
            // list and the history panel only corrects things they cannot
            // see yet, so let this action finish and do that work at idle —
            // otherwise the button sits spinning through a full re-render of
            // every comment card.
            whenIdle(() => setHistoryVersion((v) => v + 1));
          } else {
            void refreshDoc();
            setHistoryVersion((v) => v + 1);
          }
          // Before the reconcile, not alongside it: landing a thread marks
          // any read already in flight as stale, so doing these afterwards
          // would throw away the very reconcile they precede.
          void landAnsweredThreads(resolvedAnsweredThreadIds).then(reconcileThreadsSoon);
        } else {
          const updated = await apiRejectProposal(doc.uid, id, identity, body);
          landThread(updated);
          reconcileThreadsSoon();
        }
        return { ok: true };
      } catch (err) {
        reportError('DocumentLayout.resolveThread', err, { id, kind });
        const message = apiErrorMessage(err, `Could not ${kind} this thread`);
        reportFailure(message);
        // A refused accept is the moment the server records *why* — a
        // conflict or a dead anchor — so the card can offer the way out.
        // Without this the badge and its button appear only on the next
        // unrelated refresh.
        if (kind === 'accept') reconcileThreadsSoon();
        // Signal failure so callers (composer / diff dialog) don't clear
        // drafts or close on a failed accept/reject. Don't re-throw —
        // `void runWorkflow(...)` callsites would surface the rejection
        // through `unhandledrejection` even though it's already toasted.
        return { ok: false, message };
      }
    },
    [doc.uid, landThread, resolveIdentity, reconcileThreadsSoon, refreshDoc, landAnsweredThreads],
  );

  const onResolveConflict = useCallback(
    async (
      id: string,
      payload: { resolvedText?: string; comment?: string },
    ): Promise<ThreadActionResult> => {
      const identity = resolveIdentity();
      if (!identity) {
        const message = 'Please set your display name first.';
        reportFailure(message);
        return { ok: false, message };
      }
      try {
        const body: Parameters<typeof apiResolveConflict>[2] = {};
        if (payload.resolvedText !== undefined) body.resolved_text = payload.resolvedText;
        if (payload.comment) body.comment = payload.comment;
        const updated = await apiResolveConflict(doc.uid, id, body, identity);
        landThread(updated);
        // The proposal was rebuilt on current main, which re-anchors it
        // and can settle other proposals' mergeability too — refresh the
        // whole set rather than patching this one thread in.
        reconcileThreadsSoon();
        return { ok: true };
      } catch (err) {
        reportError('DocumentLayout.resolveConflict', err, { id });
        const message = apiErrorMessage(err, 'Could not resolve this conflict');
        reportFailure(message);
        return { ok: false, message };
      }
    },
    [doc.uid, landThread, resolveIdentity, reconcileThreadsSoon],
  );

  const onRepairThread = useCallback(
    async (id: string): Promise<ThreadActionResult> => {
      const identity = resolveIdentity();
      if (!identity) {
        const message = 'Please set your display name first.';
        reportFailure(message);
        return { ok: false, message };
      }
      try {
        const repaired = await apiRepairProposalAnchor(doc.uid, id, identity);
        threadSnapshotRequestRef.current += 1;
        setThreads((prev) => {
          const index = prev.findIndex((thread) => thread.id === repaired.id);
          const next =
            index >= 0
              ? prev.map((thread, idx) => (idx === index ? repaired : thread))
              : [...prev, repaired];
          next.sort((a, b) => a.comments[0].created_at - b.comments[0].created_at);
          return next;
        });
        reconcileThreadsSoon();
        return { ok: true };
      } catch (err) {
        reportError('DocumentLayout.repairThread', err, { id });
        const message = apiErrorMessage(err, 'Could not repair the anchor');
        reportFailure(message);
        return { ok: false, message };
      }
    },
    [doc.uid, resolveIdentity, reconcileThreadsSoon],
  );

  const onEdit = useCallback(
    async (id: string, body: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        const updated = await apiUpdate(doc.uid, id, body, identity);
        // The response is the thread. Editing a body changes nothing
        // else, so there is nothing to reconcile against.
        landThread(updated);
      } catch (err) {
        reportError('DocumentLayout.editComment', err, { commentId: id });
      }
    },
    [doc.uid, landThread, resolveIdentity],
  );

  const onSetCommentHidden = useCallback(
    async (id: string, hidden: boolean) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        const updated = await apiSetCommentHidden(doc.uid, id, hidden, identity);
        landThread(updated);
      } catch (err) {
        reportError('DocumentLayout.setCommentHidden', err, { commentId: id, hidden });
        const title = hidden ? 'Could not hide comment' : 'Could not unhide comment';
        showErrorToast(title, apiErrorMessage(err, title));
      }
    },
    [doc.uid, landThread, resolveIdentity],
  );

  const canEdit = doc.role === 'admin' || doc.role === 'editor';

  // Editors can fill missing-asset placeholders directly in view mode
  // without navigating to the editor. Upload, then re-fetch so the
  // server-rewritten HTML points the <img> at the new proxy URL.
  const onMissingAssetUpload = useCallback(
    async (refName: string, file: File) => {
      const identity = resolveIdentity();
      if (!identity) {
        reportFailure('Please set your display name first.');
        return;
      }
      try {
        await uploadAsset(doc.uid, refName, file, identity);
        await refreshDoc();
      } catch (err) {
        reportError('DocumentLayout.uploadAsset', err, { uid: doc.uid, refName });
        reportFailure(apiErrorMessage(err, 'Upload failed'));
      }
    },
    [doc.uid, resolveIdentity, refreshDoc],
  );

  const onCreateProposal = useCallback(
    async (payload: { proposed_text: string; rationale?: string; display_name?: string }) => {
      if (!pendingProposalTarget) return;
      const identity = resolveIdentity(payload.display_name);
      if (!identity) {
        reportFailure('Please set your display name first.');
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
        if (pendingProposalAnswersThreadIds?.length) {
          req.answers_thread_ids = pendingProposalAnswersThreadIds;
        }
        if (payload.rationale) req.rationale = payload.rationale;
        const created = await apiCreateProposal(doc.uid, req, identity);
        landThread(created);
        setPendingDraft(null);
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
        reconcileThreadsSoon();
      } catch (err) {
        reportError('DocumentLayout.createProposal', err, { uid: doc.uid });
        reportFailure(apiErrorMessage(err, 'Could not create that proposal'));
      }
    },
    [
      doc.uid,
      landThread,
      resolveIdentity,
      reconcileThreadsSoon,
      pendingProposalTarget,
      pendingProposalAnswersThreadIds,
      sectionFilterActive,
      blockSectionIds,
      sectionFilter,
      clearSectionFilter,
    ],
  );

  const onCreateProposalForComment = useCallback(
    (thread: Thread) => {
      const blockId = thread.anchor.block_id;
      const range = blockId ? blockRanges.get(blockId) : undefined;
      if (!blockId || !range) {
        reportFailure('This comment is no longer linked to an editable paragraph.');
        return;
      }

      const blockElement = Array.from(
        docRef.current?.querySelectorAll<HTMLElement>('[data-block]') ?? [],
      ).find((element) => element.dataset.block === blockId);
      const renderedText = (blockElement?.textContent ?? '').replace(/\s+/gu, ' ').trim();
      const sourceText = blockRangeSource.slice(range.start, range.end).trim();

      // Only one proposal editor at a time. This reuses the ordinary
      // paragraph proposal composer, adding the answer link at submit.
      setEditingProposal(null);
      setPendingDraft({
        mode: 'proposal',
        answersThreadIds: [thread.id],
        target: {
          block_id: blockId,
          end_block_id: null,
          block_text: renderedText || thread.anchor.quote || sourceText,
          block_count: 1,
        },
      });
    },
    [blockRanges, blockRangeSource],
  );

  const onEditProposal = useCallback((thread: Thread) => {
    // Only one composer at a time — an open create-draft would sit
    // underneath the edit dialog and reopen on close, disoriented.
    setPendingDraft(null);
    setEditingProposal(thread);
  }, []);

  const onUpdateProposal = useCallback(
    async (payload: { proposed_text: string; comment?: string; display_name?: string }) => {
      if (!editingProposal) return;
      const identity = resolveIdentity(payload.display_name);
      if (!identity) {
        reportFailure('Please set your display name first.');
        return;
      }
      try {
        const req: Parameters<typeof apiUpdateProposal>[2] = {
          proposed_text: payload.proposed_text,
        };
        if (payload.comment) req.comment = payload.comment;
        const updated = await apiUpdateProposal(doc.uid, editingProposal.id, req, identity);
        landThread(updated);
        setEditingProposal(null);
        reconcileThreadsSoon();
      } catch (err) {
        reportError('DocumentLayout.updateProposal', err, {
          uid: doc.uid,
          threadId: editingProposal.id,
        });
        reportFailure(apiErrorMessage(err, 'Could not update that proposal'));
      }
    },
    [doc.uid, editingProposal, landThread, resolveIdentity, reconcileThreadsSoon],
  );

  const onDeleteThread = useCallback(
    async (threadId: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        await apiDeleteThread(doc.uid, threadId, identity);
        threadSnapshotRequestRef.current += 1;
        setThreads((prev) => prev.filter((t) => t.id !== threadId));
        reconcileThreadsSoon();
      } catch (err) {
        reportError('DocumentLayout.deleteThread', err, { threadId });
        reportFailure(apiErrorMessage(err, 'Delete failed'));
        reconcileThreadsSoon();
      }
    },
    [doc.uid, resolveIdentity, reconcileThreadsSoon],
  );

  const onDeleteNode = useCallback(
    async (nodeId: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        await apiDelete(doc.uid, nodeId, identity);
        threadSnapshotRequestRef.current += 1;
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
        reconcileThreadsSoon();
      } catch (err) {
        reportError('DocumentLayout.deleteNode', err, { nodeId });
      }
    },
    [doc.uid, resolveIdentity, reconcileThreadsSoon],
  );

  const onReact = useCallback(
    async (nodeId: string, emoji: string) => {
      const identity = resolveIdentity();
      if (!identity) {
        reportFailure('Please set your display name first.');
        return;
      }
      const previous = reactionQueuesRef.current.get(nodeId) ?? Promise.resolve();
      const operation = previous
        .catch(() => undefined)
        .then(async () => {
          try {
            const updated = await apiToggleReaction(doc.uid, nodeId, emoji, identity);
            const updatedComment = updated.comments.find((comment) => comment.id === nodeId);
            threadSnapshotRequestRef.current += 1;
            setThreads((prev) => {
              const existing = prev.find((thread) => thread.id === updated.id);
              if (!existing) {
                const next = [...prev, updated];
                next.sort((a, b) => a.comments[0].created_at - b.comments[0].created_at);
                return next;
              }
              // A reaction changes one comment, not the surrounding thread.
              // Merging that row preserves reactions that completed in parallel
              // on another comment in the same thread.
              if (!updatedComment) {
                return prev.map((thread) => (thread.id === updated.id ? updated : thread));
              }
              return prev.map((thread) =>
                thread.id === updated.id
                  ? {
                      ...thread,
                      comments: thread.comments.map((comment) =>
                        comment.id === nodeId ? updatedComment : comment,
                      ) as [Comment, ...Comment[]],
                    }
                  : thread,
              );
            });
            reconcileThreadsSoon();
          } catch (err) {
            reportError('DocumentLayout.toggleReaction', err, { nodeId });
            reportFailure(apiErrorMessage(err, 'Could not save that reaction'));
          }
        });
      reactionQueuesRef.current.set(nodeId, operation);
      try {
        await operation;
      } finally {
        if (reactionQueuesRef.current.get(nodeId) === operation) {
          reactionQueuesRef.current.delete(nodeId);
        }
      }
    },
    [doc.uid, resolveIdentity, reconcileThreadsSoon],
  );

  const onRestoreHistoryVersion = useCallback(
    async (oid: string) => {
      const identity = resolveIdentity();
      if (!identity) {
        reportFailure('Please set your display name first.');
        throw new Error('display-name-required');
      }
      try {
        await apiRestoreHistoryVersion(doc.uid, oid, identity);
        reconcileThreadsSoon();
        void refreshDoc();
        setHistoryVersion((v) => v + 1);
      } catch (err) {
        reportError('DocumentLayout.restoreHistoryVersion', err, { oid, uid: doc.uid });
        reportFailure(apiErrorMessage(err, 'Restore failed'));
        throw err;
      }
    },
    [doc.uid, resolveIdentity, refreshDoc, reconcileThreadsSoon],
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
        reportFailure(apiErrorMessage(err, 'Could not open as a new document'));
        throw err;
      }
    },
    [doc.format, doc.uid, navigate],
  );

  /**
   * The grid tracks, and the variables the collapse animation runs on.
   * Overlaid panes leave their track at the collapsed rail whatever they
   * are doing — that is what keeps the document (and, in paged mode, the
   * pagination) still while a pane opens over it. The rail itself holds
   * one icon button, so it scales with the chrome.
   */
  const railPx = Math.round(COLLAPSED_WIDTH * (uiScale / 100));
  const tocPx = tocOpen && !overlayPanes ? tocWidth : railPx;
  const commentsPx = commentsOpen && !overlayPanes ? commentsWidth : railPx;
  const tocBody = usePaneBody(tocOpen);
  const commentsBody = usePaneBody(commentsOpen);
  const gridStyle = {
    gridTemplateColumns: `${tocPx}px 1fr ${commentsPx}px`,
    '--pane-collapse-duration': `${PANE_COLLAPSE_MS}ms`,
    // Where a collapsed pane's expand button parks, so it can hold still
    // while the column travels past it.
    '--pane-collapsed-width': `${railPx}px`,
    // Overlaid, the column never travels, so the pane slides over the
    // document under its own transform at these widths instead.
    ...(overlayPanes
      ? {
          '--pane-overlay-toc-width': `${tocWidth}px`,
          '--pane-overlay-comments-width': `${commentsWidth}px`,
        }
      : {}),
  } as React.CSSProperties;

  /**
   * Bumped when the columns have finished moving. Everything downstream
   * measures the panes rather than reading their target widths, and until
   * the transition lands those two disagree.
   */
  const [panesSettled, setPanesSettled] = useState(0);
  const onPanesSettled = useCallback((e: React.TransitionEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget && e.propertyName === 'grid-template-columns') {
      setPanesSettled((n) => n + 1);
    }
  }, []);

  /**
   * Measured rather than derived from the viewport: both side panes are
   * resizable, so only the element's own width says what still fits. The
   * comment column's `@container` query reads `.doc-scroll`'s content box,
   * which is narrower wherever the platform reserves room for a scrollbar,
   * so that is the box to measure. Every way it can change is a window
   * resize or one of the two side-column widths in the deps. 0 means "not
   * measured yet" — the layout effect fills it in before the first paint.
   */
  const [commentsHostWidth, setCommentsHostWidth] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: tocPx / commentsPx / overlayPanes / panesSettled are the intentional re-measure triggers — the body reads widths only they can have changed.
  useLayoutEffect(() => {
    const measure = () => {
      if ((docPaneRef.current?.clientWidth ?? 0) <= 0) return;
      setCommentsHostWidth(docScrollRef.current?.clientWidth ?? 0);
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [tocPx, commentsPx, overlayPanes, panesSettled]);

  /** Offering the switch back to the column would be a dead action where
   *  the stylesheet hides the column outright. */
  const columnModeAvailable =
    commentsHostWidth === 0 || commentsHostWidth > COMMENTS_COLUMN_MIN_WIDTH;

  /**
   * Everything that repaginates the document, as a single identity: new
   * content, a different reading width or text size, a theme swap, either
   * side pane resizing. The hook re-measures and holds the reader's place
   * whenever it changes.
   *
   * A memoised tuple rather than a joined string, so the HTML travels by
   * reference: its length alone would miss any edit that happens to keep
   * the document the same size, and concatenating it would rebuild the
   * whole document into a key on every render.
   *
   * A collapsing pane counts twice: page geometry measured while the
   * column is still in flight describes a width the document is about to
   * leave, so `panesSettled` asks for the answer again at rest.
   */
  const pageLayoutKey = useMemo(
    () => [liveRendered.html, maxWidth, textZoom, uiScale, theme, tocPx, commentsPx, panesSettled],
    [liveRendered.html, maxWidth, textZoom, uiScale, theme, tocPx, commentsPx, panesSettled],
  );
  const pages = usePagedReading(docScrollRef, paged, pageLayoutKey, pagedVertical);

  /**
   * Keep the reader in pages even where the sideways ones stop painting.
   * On WebKit a long enough column run goes blank partway through — the
   * page counter and the TOC keep working, the pages are just empty — so
   * a book-length document turns its pages downwards instead. That gives
   * up the browser's column fragmentation, which is why it is a fallback
   * and not the default.
   */
  useEffect(() => {
    if (!pages.tooWideToPaint) return;
    setTooWideForPages(true);
    showToast({
      title: 'Pages now turn downwards',
      body: 'This document is too long for this browser to paginate sideways. A smaller text size brings the usual pages back.',
    });
  }, [pages.tooWideToPaint]);

  /**
   * Anything that repaginates deserves a fresh verdict — dropping the
   * text size or widening the reading column can bring the pagination
   * back under the limit, and sideways pages are the better ones.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: pageLayoutKey is a pure trigger for re-deciding, not a value read here.
  useEffect(() => {
    setTooWideForPages(false);
  }, [pageLayoutKey]);

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
  const threadCount =
    threadTabVisibleCount?.docUid === doc.uid &&
    threadTabVisibleCount.sourceThreads === sectionVisibleThreads
      ? threadTabVisibleCount.count
      : sectionVisibleThreads.length;
  const onThreadTabVisibleCountChange = useCallback(
    (count: number) => {
      setThreadTabVisibleCount((current) => {
        if (
          current?.docUid === doc.uid &&
          current.sourceThreads === sectionVisibleThreads &&
          current.count === count
        ) {
          return current;
        }
        return { docUid: doc.uid, sourceThreads: sectionVisibleThreads, count };
      });
    },
    [doc.uid, sectionVisibleThreads],
  );

  /**
   * Threads that get a card: the section filter, then the
   * show/hide-resolved switch. Applied once here so the column, the
   * floating cards and their toolbars can never disagree about which
   * cards exist — each used to filter its own copy, and the floating
   * toolbar counted threads the layer never showed.
   */
  const commentSurfaceThreads = useMemo(
    () =>
      inlineCommentsHideResolved
        ? sectionVisibleThreads.filter((t) => !isResolved(t))
        : sectionVisibleThreads,
    [sectionVisibleThreads, inlineCommentsHideResolved],
  );

  /**
   * Highlights share only the resolved half of that filter. A section
   * the filter excludes is held collapsed in the document, so its marks
   * are unreachable either way, and rebuilding them on every funnel
   * toggle would unwrap and re-wrap ranges nobody can see.
   */
  const commentHighlights = useMemo(
    () =>
      buildCommentHighlights(threads, {
        hideResolved: inlineCommentsHideResolved,
        pendingAnchor: canComment ? pendingAnchor : null,
      }),
    [canComment, threads, pendingAnchor, inlineCommentsHideResolved],
  );

  /**
   * Where a new comment gets composed. It is always over the document —
   * never in a side pane — and the margin column can only host it while
   * it is actually on screen. Everything else (floating mode, a column
   * the container query has hidden, a column the reader collapsed)
   * falls to the popover at the selection.
   *
   * Reactive by construction: `columnModeAvailable` re-measures on
   * resize and on either pane width, so narrowing the window hands the
   * draft over mid-edit rather than leaving it in a hidden column.
   */
  const composerInColumn = !floatingComments && inlineCommentsOpen && columnModeAvailable;

  /**
   * Does a popover host mount inside the document row on this pass?
   * Only then does the row need to be a positioning context. Column
   * mode reaches this too now — the composer's popover is the one
   * that mode also puts over the document. Paged mode is excluded on
   * purpose: the row slides sideways with the pages, so both hosts
   * hang off the still viewport instead.
   */
  const rowHostsPopover =
    !paged && (floatingComments || (canComment && !!pendingAnchor && !composerInColumn));

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

  const startCommentDraft = useCallback((anchor: CommentAnchor) => {
    // Deliberately does not open the column: `composerInColumn` routes
    // the draft to whichever surface is already showing, and forcing
    // the column open would both override a reader who collapsed it and
    // shove the text sideways at the moment they asked to write.
    const scrollTop = docScrollRef.current?.scrollTop ?? null;
    setPendingDraft({ mode: 'comment', anchor });

    if (scrollTop === null) return;

    // The pending card entering the column reflows it; hold the reader
    // where they were.
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
      // Same for a resolved thread while resolved ones are hidden: the
      // reader asked for this one by name, from a surface that lists
      // them (Activities, History, the Threads tab).
      if (threads.some((t) => t.id === threadId && isResolved(t))) {
        setInlineCommentsHideResolved(false);
      }
      // Prefer the inline column when it's actually visible; otherwise
      // fall back to the right pane (and open it if it's collapsed).
      // Floating mode always shows the thread as a popover in the doc
      // pane, so the right pane stays untouched.
      //
      // Kept even though a *draft* never falls back here any more:
      // reading an existing thread is a different question. Column mode
      // has no popover for thread cards — only for the composer — so
      // dropping this would leave a highlight click with nowhere to
      // land whenever the column is hidden or collapsed.
      if (!floatingComments && !inlineCommentsVisible()) {
        openComments(true);
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
      floatingComments,
      inlineCommentsVisible,
      openComments,
      scrollToAnchor,
      threads,
      sectionFilterActive,
      sectionVisibleThreads,
      clearSectionFilter,
    ],
  );

  const onRevertHistoryEdit = useCallback(
    async (entry: HistoryEntry) => {
      const identity = resolveIdentity();
      if (!identity) {
        reportFailure('Please set your display name first.');
        throw new Error('display-name-required');
      }
      try {
        const res = await apiRevertHistoryVersion(doc.uid, entry.oid, identity);
        reconcileThreadsSoon();
        void refreshDoc();
        setHistoryVersion((v) => v + 1);
        if (res.reopened_proposal_id) openCommentThread(res.reopened_proposal_id);
      } catch (err) {
        reportError('DocumentLayout.revertHistoryEdit', err, {
          oid: entry.oid,
          uid: doc.uid,
        });
        reportFailure(apiErrorMessage(err, 'Revert failed'));
        throw err;
      }
    },
    [doc.uid, resolveIdentity, openCommentThread, refreshDoc, reconcileThreadsSoon],
  );

  const updateSearchResults = useCallback((results: DocumentSearchResult[]) => {
    setSearchResults(results);
  }, []);

  const focusSearchResult = useCallback(
    (id: string) => {
      openComments(true);
      setRightTab('search');
      setActiveSearchTarget((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }));
    },
    [openComments],
  );

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

  /**
   * How the document reads — layout, width, zoom, theme. A two-column grid
   * of label and control: read down the first column to find a setting,
   * across to change it. Labels are plain text rather than `<label>`
   * because most of these controls are composites with no single field to
   * point at; the theme select is the one that can be, and is.
   */
  const displayControls = (
    <div className="doc-view-grid">
      <Text size="1" color="gray">
        Layout
      </Text>
      <SegmentedControl.Root
        size="1"
        // The effective mode, not the stored one: while the fallback is
        // in force the reader is looking at a scrolling document, and a
        // control insisting otherwise just reads as broken.
        value={paged ? 'paged' : 'scroll'}
        onValueChange={(next) => {
          // Choosing "Pages" again re-measures, so a reader who has
          // since shrunk the text gets them back — and one who hasn't
          // gets the toast saying why, rather than a dead control.
          setTooWideForPages(false);
          setReadingMode(next === 'paged' ? 'paged' : 'scroll');
        }}
        aria-label="Reading layout"
      >
        <SegmentedControl.Item value="scroll">Scroll</SegmentedControl.Item>
        <SegmentedControl.Item value="paged">Pages</SegmentedControl.Item>
      </SegmentedControl.Root>

      <Text size="1" color="gray">
        Reading width
      </Text>
      <DisplayStepper
        ariaLabel="Reading width"
        min={40}
        max={120}
        step={4}
        defaultValue={DEFAULT_MAX_WIDTH}
        value={maxWidth}
        format={(v) => `${v}ch`}
        onCommit={setMaxWidth}
      />

      <Text size="1" color="gray">
        Text size
      </Text>
      <DisplayStepper
        ariaLabel="Text size"
        min={TEXT_ZOOM_MIN}
        max={TEXT_ZOOM_MAX}
        step={5}
        defaultValue={100}
        value={textZoom}
        format={(v) => `${v}%`}
        onCommit={setTextZoom}
      />

      <Text size="1" color="gray">
        Interface size
      </Text>
      <DisplayStepper
        ariaLabel="Interface size"
        min={UI_SCALE_MIN}
        max={UI_SCALE_MAX}
        step={5}
        defaultValue={uiScaleDefault}
        value={uiScale}
        format={(v) => `${v}%`}
        onCommit={(next) => {
          setUiScale(next);
          setUiScaleState(next);
        }}
        onReset={() => setUiScaleState(resetUiScale())}
      />

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
    </div>
  );

  /**
   * Hoisted because paged mode hangs it somewhere else in the tree: its
   * geometry is "host space", offsets from the positioning host, and in
   * paged mode the host must be the still scrollport rather than the
   * row, which slides sideways with the pages.
   */
  const floatingCommentsLayer = floatingComments ? (
    <FloatingCommentsLayer
      uid={doc.uid}
      threads={commentSurfaceThreads}
      docHtml={liveRendered.html}
      docElementRef={docRef}
      scrollContainerRef={docScrollRef}
      canComment={canComment}
      pendingAnchor={canComment ? pendingAnchor : null}
      focusedThread={focusedThread}
      displayName={effectiveDisplayName}
      mentionCandidates={mentionCandidates}
      onReply={onReply}
      onEdit={onEdit}
      onSetHidden={onSetCommentHidden}
      onDeleteNode={onDeleteNode}
      onDeleteThread={onDeleteThread}
      onResolveThread={onResolveThread}
      onRepairThread={onRepairThread}
      onResolveConflict={onResolveConflict}
      onReact={onReact}
      onCreateProposal={onCreateProposalForComment}
      onEditProposal={onEditProposal}
      onScrollToAnchor={scrollToAnchor}
    />
  ) : null;

  /**
   * Hoisted for the same reason as the layer above, and mounted in the
   * same two places: the composer is the one popover column mode also
   * puts over the document, so it has to follow paged mode's host too.
   */
  const pendingCommentPopover =
    canComment && pendingAnchor && !composerInColumn ? (
      <PendingCommentPopover
        anchor={pendingAnchor}
        docHtml={liveRendered.html}
        docElementRef={docRef}
        scrollContainerRef={docScrollRef}
        displayName={effectiveDisplayName}
        mentionCandidates={mentionCandidates}
        onCancel={() => setPendingDraft(null)}
        onCreate={onCreate}
      />
    ) : null;

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

      {pending && <span className="doc-pending" role="progressbar" aria-label="Loading document" />}

      <div
        className={`doc-layout${overlayPanes ? ' doc-layout-overlay' : ''}${pending ? ' doc-layout--pending' : ''}`}
        style={gridStyle}
        onTransitionEnd={onPanesSettled}
        inert={pending}
      >
        {overlayPaneOpen && (
          <button
            type="button"
            className="pane-scrim"
            aria-label="Close panel"
            onClick={closeOverlayPanes}
          />
        )}
        <aside className={`pane pane-toc ${tocOpen ? 'open' : 'closed'}`}>
          <Flex align="center" gap="2" px="2" py="2" className="pane-header">
            <Tooltip content={tocOpen ? 'Collapse' : 'Expand contents'}>
              <IconButton variant="ghost" size="1" onClick={() => openToc(!tocOpen)}>
                <ChevronLeftIcon className="pane-toggle-icon" />
              </IconButton>
            </Tooltip>
            <Text size="1" color="gray" weight="medium" className="pane-header-label">
              Contents
            </Text>
          </Flex>
          {tocBody && (
            /* Held at the open width so the headings don't re-wrap their
               way through the collapse; the pane clips what won't fit. */
            <div className="pane-body" style={{ width: tocWidth }} inert={!tocOpen}>
              <Toc
                nodes={liveRendered.toc}
                activeId={activeHeadingId}
                filterIds={sectionFilter}
                onToggleFilter={toggleSectionFilter}
                onClearFilter={clearSectionFilter}
              />
            </div>
          )}
          {tocOpen && <ResizeHandle side="left" width={tocWidth} onResize={setTocWidth} />}
        </aside>

        <main className="pane pane-doc" ref={docPaneRef}>
          {/* Document-specific toolbar lives inside the doc pane so it sits
              only over the document column, not above the side panes. */}
          <Flex align="center" gap="3" px="3" py="2" className="doc-chrome">
            {/* Always a menu, however much room the toolbar has: these are
                set-and-forget reading preferences, and spreading five of
                them across the bar pushed the per-document actions off the
                end of it on anything but a wide screen. */}
            <Popover.Root>
              <Popover.Trigger>
                <Button variant="soft" size="2" className="doc-view-trigger">
                  <MixerHorizontalIcon />
                  View
                </Button>
              </Popover.Trigger>
              <Popover.Content size="1" align="start" className="doc-view-popover">
                {displayControls}
              </Popover.Content>
            </Popover.Root>
            <span className="spacer" />
            {/* Download is available to any reader — unlike settings /
                access control which are admin-only. Sits next to the
                gear so the whole toolbar cluster reads as a single set
                of per-document actions. */}
            <DownloadMenu
              doc={doc}
              source={liveSource}
              theme={theme}
              reviewExportEnabled={inlineCommentsOpen || floatingComments}
            />
            {children}
            {doc.role === 'admin' && onDocSettingsChanged && (
              <>
                <CopyDocumentDialog doc={doc} />
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
          {floatingComments && (
            <FloatingCommentsToolbar
              threads={commentSurfaceThreads}
              hideResolved={inlineCommentsHideResolved}
              onToggleHideResolved={() => setInlineCommentsHideResolved((v) => !v)}
              onSwitchToColumn={() => setCommentsDisplayMode('column')}
              columnModeAvailable={columnModeAvailable && !paged}
              docElementRef={docRef}
              scrollContainerRef={docScrollRef}
              currentThreadId={focusedThread?.threadId ?? null}
              onOpenThread={openCommentThread}
            />
          )}
          {/* The reading width is published here rather than on the row
              so the edge tap zones — siblings of the scrollport, not
              descendants — can size themselves to the gutter it leaves.
              Everything that read it inside the row still inherits it. */}
          <div className="doc-viewport" style={{ ['--md-max-width' as string]: `${maxWidth}ch` }}>
            {/* `marginalia-theme` is applied here (not just inside the
              article) so the inline comments column inherits the
              document's themed background — otherwise it would sit on
              the surrounding pane-doc background and look like a
              different surface. */}
            <div
              className={`doc-scroll marginalia-theme${
                paged ? ` ${pagedVertical ? PAGED_VERTICAL_CLASS : PAGED_CLASS}` : ''
              }`}
              ref={docScrollRef}
            >
              <div
                className={`doc-row${!floatingComments && inlineCommentsOpen ? ' doc-row-with-inline' : ''}${rowHostsPopover ? ' doc-row-floating' : ''}`}
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
                  {canComment && blockRangesReady && (
                    <SelectionToolbar
                      rootRef={docRef}
                      docFormat={doc.format}
                      blockRanges={blockRanges}
                      onAdd={startCommentDraft}
                      onPropose={(target) => setPendingDraft({ mode: 'proposal', target })}
                    />
                  )}
                  {canComment && blockRangesReady && (
                    <BlockActions
                      rootRef={docRef}
                      onPropose={(target) => setPendingDraft({ mode: 'proposal', target })}
                      onEditChapter={(headingBlockId) =>
                        navigate(`/d/${doc.uid}/edit?chapter=${encodeURIComponent(headingBlockId)}`)
                      }
                    />
                  )}
                </div>
                {floatingComments ? (
                  paged ? null : (
                    floatingCommentsLayer
                  )
                ) : (
                  <InlineCommentsLayer
                    uid={doc.uid}
                    threads={commentSurfaceThreads}
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
                    onSwitchToFloating={() => setCommentsDisplayMode('floating')}
                    pendingAnchor={canComment && composerInColumn ? pendingAnchor : null}
                    focusedThread={focusedThread}
                    displayName={effectiveDisplayName}
                    mentionCandidates={mentionCandidates}
                    onCancelPending={() => setPendingDraft(null)}
                    onCreate={onCreate}
                    onReply={onReply}
                    onEdit={onEdit}
                    onSetHidden={onSetCommentHidden}
                    onDeleteNode={onDeleteNode}
                    onDeleteThread={onDeleteThread}
                    onResolveThread={onResolveThread}
                    onRepairThread={onRepairThread}
                    onResolveConflict={onResolveConflict}
                    onReact={onReact}
                    onCreateProposal={onCreateProposalForComment}
                    onEditProposal={onEditProposal}
                    onScrollToAnchor={scrollToAnchor}
                  />
                )}
                {paged ? null : pendingCommentPopover}
              </div>
            </div>
            {paged && (
              <>
                <button
                  type="button"
                  className="doc-page-zone doc-page-zone-prev"
                  aria-label="Previous page"
                  disabled={pages.page <= 0}
                  onClick={() => pages.tap(-1)}
                />
                <button
                  type="button"
                  className="doc-page-zone doc-page-zone-next"
                  aria-label="Next page"
                  disabled={pages.page >= pages.pageCount - 1}
                  onClick={() => pages.tap(1)}
                />
                {floatingCommentsLayer}
                {pendingCommentPopover}
              </>
            )}
          </div>
          {paged && (
            <Flex className="doc-pager" align="center" gap="2">
              <IconButton
                variant="ghost"
                size="1"
                aria-label="Previous page"
                disabled={pages.page <= 0}
                onClick={() => pages.turn(-1)}
              >
                <ChevronLeftIcon />
              </IconButton>
              <PageJump
                page={pages.page}
                pageCount={pages.pageCount}
                // Instant: a jump is rarely to the next page, and smooth
                // scrolling a hundred pitches is a long blur of columns.
                onGoTo={(index) => pages.goTo(index, 'auto')}
              />
              <IconButton
                variant="ghost"
                size="1"
                aria-label="Next page"
                disabled={pages.page >= pages.pageCount - 1}
                onClick={() => pages.turn(1)}
              >
                <ChevronRightIcon />
              </IconButton>
            </Flex>
          )}
        </main>

        <aside className={`pane pane-right ${commentsOpen ? 'open' : 'closed'}`}>
          {commentsOpen && (
            <ResizeHandle side="right" width={commentsWidth} onResize={setCommentsWidth} />
          )}
          {/* Out of flow, so it can cross-fade with a body that is still
              on its way out. */}
          <Flex align="center" justify="center" py="2" className="pane-expand" inert={commentsOpen}>
            <Tooltip content="Expand comments / history">
              <IconButton variant="ghost" size="1" onClick={() => openComments(true)}>
                <ChevronLeftIcon />
              </IconButton>
            </Tooltip>
          </Flex>
          {commentsBody && (
            <div className="pane-body" style={{ width: commentsWidth }} inert={!commentsOpen}>
              <Tabs.Root
                value={rightTab}
                onValueChange={(v) => setRightTab(v as RightTab)}
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
                    <IconButton variant="ghost" size="1" onClick={() => openComments(false)}>
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
                    canRevert={canEdit}
                    onRevertEdit={onRevertHistoryEdit}
                  />
                </Tabs.Content>
                <Tabs.Content value="comments" className="right-tab-panel">
                  <InlineCommentsList
                    uid={doc.uid}
                    threads={sectionVisibleThreads}
                    loading={threadsLoading}
                    onVisibleCountChange={onThreadTabVisibleCountChange}
                    sectionFilterCount={sectionFilter.size}
                    onClearSectionFilter={clearSectionFilter}
                    blockRanges={blockRanges}
                    canComment={canComment}
                    focusedThread={focusedThread}
                    displayName={effectiveDisplayName}
                    mentionCandidates={mentionCandidates}
                    onReply={onReply}
                    onEdit={onEdit}
                    onSetHidden={onSetCommentHidden}
                    onDeleteNode={onDeleteNode}
                    onDeleteThread={onDeleteThread}
                    onResolveThread={onResolveThread}
                    onRepairThread={onRepairThread}
                    onResolveConflict={onResolveConflict}
                    onReact={onReact}
                    onCreateProposal={onCreateProposalForComment}
                    onEditProposal={onEditProposal}
                    onScrollToAnchor={scrollToAnchor}
                    onNeedResolvedThreads={ensureArchive}
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
                    onRevertEdit={onRevertHistoryEdit}
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
            </div>
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
        docSource={blockRangeSource}
        docFormat={doc.format}
        blockRanges={blockRanges}
        attachedAssets={doc.attached_assets}
        needsName={!displayName}
        onCancel={() => setPendingDraft(null)}
        onSubmit={onCreateProposal}
      />
      <ProposalEditComposer
        thread={editingProposal}
        docUid={doc.uid}
        docFormat={doc.format}
        attachedAssets={doc.attached_assets}
        needsName={!displayName}
        onCancel={() => setEditingProposal(null)}
        onSubmit={onUpdateProposal}
      />
    </div>
  );
}

const ANCHOR_FLASH_MS = 1600;
const flashTimers = new WeakMap<HTMLElement, number>();

/** Restartable anchor flash — re-navigating to the same element (e.g.
 *  two threads sharing one mark) retriggers the animation instead of
 *  silently re-adding the class mid-run. */
function flashAnchor(el: HTMLElement): void {
  const prev = flashTimers.get(el);
  if (prev !== undefined) {
    window.clearTimeout(prev);
    el.classList.remove('anchor-flash');
    // Style flush so re-adding the class restarts the CSS animation.
    void el.offsetWidth;
  }
  el.classList.add('anchor-flash');
  flashTimers.set(
    el,
    window.setTimeout(() => {
      el.classList.remove('anchor-flash');
      flashTimers.delete(el);
    }, ANCHOR_FLASH_MS),
  );
}

const SETTLE_TICK_MS = 150;
const SETTLE_IDLE_MS = 140;
const SETTLE_MAX_MS = 2600;
const SETTLE_TOLERANCE_PX = 2;
const SETTLE_USER_EVENTS = ['wheel', 'touchstart', 'mousedown'] as const;

/**
 * Bring `target` to the top of the container (minus `offset`) — or, in
 * paged mode, to the start of the page holding it — then keep verifying
 * until the position sticks. Late layout shifts — webfont and image
 * loads, mermaid renders — move the target mid-flight, and some
 * environments drop smooth scrolling entirely; each idle check
 * re-measures and corrects instantly until two consecutive checks agree,
 * the user takes over, or a newer navigation supersedes this one.
 *
 * Repagination makes that verification matter more, not less: a late
 * image load doesn't just shift the target down the page, it can move
 * it onto a different page entirely.
 */
function scrollToTargetAndSettle(
  scroll: HTMLElement,
  target: HTMLElement,
  offset: number,
  isCurrent: () => boolean,
): void {
  const vertical = scroll.classList.contains(PAGED_VERTICAL_CLASS);
  const paged = scroll.classList.contains(PAGED_CLASS) || vertical;
  /** Where the reader should end up, on whichever axis is in play. */
  const intended = (): number | null => {
    if (!target.isConnected) return null;
    if (paged) {
      const page = pageIndexOfElement(scroll, target);
      // `offset` centres a card in the scroll flow; a page has no such
      // freedom — the target's page starts where it starts.
      if (page === null) return null;
      // Not `clientHeight`: vertical pages are sized to a whole number
      // of lines and carry a fraction of a pixel, which `measurePages`
      // keeps and the rounded box does not.
      return page * measurePages(scroll).pitch;
    }
    const top =
      target.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top +
      scroll.scrollTop -
      offset;
    return Math.max(0, Math.min(Math.round(top), scroll.scrollHeight - scroll.clientHeight));
  };
  // Vertical pages scroll down the block axis like the unpaged document,
  // so only horizontal paging moves along `scrollLeft`. Getting this
  // wrong doesn't just land in the wrong place — the settle loop reads a
  // position that never moves and corrects until it gives up.
  const alongX = paged && !vertical;
  const position = () => (alongX ? scroll.scrollLeft : scroll.scrollTop);
  const scrollTo = (value: number, behavior: ScrollBehavior) =>
    scroll.scrollTo(alongX ? { left: value, behavior } : { top: value, behavior });

  const first = intended();
  if (first === null) return;
  scrollTo(first, 'smooth');

  let lastScrollAt = performance.now();
  let stableChecks = 0;
  let corrections = 0;
  const onScroll = () => {
    lastScrollAt = performance.now();
  };
  const stop = () => {
    window.clearInterval(timer);
    window.clearTimeout(deadline);
    scroll.removeEventListener('scroll', onScroll);
    for (const ev of SETTLE_USER_EVENTS) scroll.removeEventListener(ev, stop);
  };
  const timer = window.setInterval(() => {
    if (!isCurrent()) return stop();
    if (performance.now() - lastScrollAt < SETTLE_IDLE_MS) return; // still gliding
    const want = intended();
    if (want === null) return stop();
    if (Math.abs(position() - want) <= SETTLE_TOLERANCE_PX) {
      if (++stableChecks >= 2) stop();
      return;
    }
    stableChecks = 0;
    if (++corrections > 4) return stop();
    scrollTo(want, 'auto');
  }, SETTLE_TICK_MS);
  const deadline = window.setTimeout(stop, SETTLE_MAX_MS);
  scroll.addEventListener('scroll', onScroll, { passive: true });
  for (const ev of SETTLE_USER_EVENTS) {
    scroll.addEventListener(ev, stop, { passive: true, once: true });
  }
}

/**
 * A read the browser tore down, because the reader navigated away or the
 * view unmounted while it was in flight. Nothing failed that the reader
 * needs telling about — `isTransientError` likewise treats it as final
 * rather than something to retry.
 */
function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'AbortError';
}

/**
 * Notify for each pending mention these threads can describe, and return
 * the ids they could not. See `partitionPendingMentions` for why the
 * leftovers matter.
 */
function notifyPendingMentions(threads: Thread[], pendingMentionIds: string[]): string[] {
  const { deliverable, undelivered } = partitionPendingMentions(threads, pendingMentionIds);
  for (const node of deliverable) {
    notify('Mentioned in a comment', `${node.author.display_name}: ${node.body.slice(0, 120)}`);
  }
  return undelivered;
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
