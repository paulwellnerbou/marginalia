import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useNavigate } from 'react-router-dom';
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
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  Cross2Icon,
  LetterCaseToggleIcon,
  MagnifyingGlassIcon,
  TokensIcon,
} from '@radix-ui/react-icons';
import type {
  CommentAnchor,
  Document,
  DocumentSettingsResponse,
  Thread,
  TocNode,
} from '../lib/api.js';
import {
  createComment as apiCreate,
  deleteComment as apiDelete,
  deleteThread as apiDeleteThread,
  listThreads,
  resolveThread as apiResolve,
  updateComment as apiUpdate,
  createEditProposal as apiCreateProposal,
  updateEditProposal as apiUpdateProposal,
  acceptEditProposal as apiAcceptProposal,
  rejectEditProposal as apiRejectProposal,
  getDocument,
  getHistoryDiff,
  restoreHistoryVersion as apiRestoreHistoryVersion,
  revertHistoryVersion as apiRevertHistoryVersion,
  uploadAsset,
  ApiError,
  isProposal,
  type HistoryEntry,
  type ThreadCommentNode,
} from '../lib/api.js';
import { getClientId, setDisplayName, useDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { subscribeToDocumentEvents } from '../lib/events.js';
import { ensureNotificationPermission, notify } from '../lib/notifications.js';
import {
  applyTheme,
  BUILT_IN_THEMES,
  getUserThemeOverride,
  setUserThemeOverride,
} from '../lib/themes.js';
import { savePendingNewDocumentDraft } from '../lib/new-document-draft.js';
import { locateAllBlocks, locateAllBlocksAsciidoc } from '@marginalia/renderer';
import { RenderedDoc, type DocumentSearchOptions } from './RenderedDoc.js';
import { Toc } from './Toc.js';
import { SelectionToolbar, type ProposalTarget } from './SelectionToolbar.js';
import { BlockActions } from './BlockActions.js';
import { CommentsPane } from './CommentsPane.js';
import { ProposalComposer } from './ThreadComposer.js';
import { ResizeHandle } from './ResizeHandle.js';
import { AppBar } from './AppBar.js';
import { DocumentSettingsDialog } from './DocumentSettingsDialog.js';
import { DownloadMenu } from './DownloadMenu.js';
import { AccessControlDialog } from './AccessControlDialog.js';
import {
  DocumentSearchResultsPane,
  type DocumentSearchResult,
} from './DocumentSearchResultsPane.js';
import { HistoryList } from './HistoryList.js';
import { documentTitle } from '../lib/doc-title.js';
import { APP_ACCENT_COLOR } from '../styles/theme.js';

const MAX_WIDTH_KEY = 'marginalia.maxWidth';
const TEXT_ZOOM_KEY = 'marginalia.textZoom';
const TOC_WIDTH_KEY = 'marginalia.tocWidth';
const COMMENTS_WIDTH_KEY = 'marginalia.commentsWidth';
const COLLAPSED_WIDTH = 36;

interface Props {
  doc: Document;
  /** Called by admin settings when the server-side settings change. */
  onDocSettingsChanged?: (s: DocumentSettingsResponse) => void;
  children?: ReactNode;
}

interface ThreadFocusTarget {
  threadId: string;
  nonce: number;
}

type PendingDraft =
  | { mode: 'comment'; anchor: CommentAnchor }
  | { mode: 'proposal'; target: ProposalTarget };

export function DocumentLayout({ doc, onDocSettingsChanged, children }: Props) {
  const navigate = useNavigate();
  const canComment = doc.role !== 'reader';
  const [tocOpen, setTocOpen] = useState(true);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [rightTab, setRightTab] = useState<'comments' | 'history' | 'search'>('comments');
  const [historyVersion, setHistoryVersion] = useState(0);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
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
  const [mentionSeedNames, setMentionSeedNames] = useState<string[]>([]);
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const pendingAnchor = pendingDraft?.mode === 'comment' ? pendingDraft.anchor : null;
  const pendingProposalTarget = pendingDraft?.mode === 'proposal' ? pendingDraft.target : null;
  const [focusedThread, setFocusedThread] = useState<ThreadFocusTarget | null>(null);
  /** Mirror of `doc.source` and `doc.rendered`, mutated when a proposal is
   *  accepted (auto-merged) so the displayed doc stays fresh without a reload. */
  const [liveSource, setLiveSource] = useState<string>(doc.source);
  const [liveRendered, setLiveRendered] = useState(doc.rendered);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    setLiveSource(doc.source);
    setLiveRendered(doc.rendered);
  }, [doc.uid, doc.source, doc.rendered]);

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

  // Reactive across UserMenu, composer, invite-load seeding, other tabs.
  const displayName = useDisplayName();
  const effectiveDisplayName = displayName;
  const [theme, setTheme] = useState<string>(
    () => getUserThemeOverride(doc.uid) ?? doc.default_theme,
  );

  const docRef = useRef<HTMLElement>(null);
  const docBodyRef = useRef<HTMLDivElement>(null);
  const docSearchInputRef = useRef<HTMLInputElement>(null);

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
    void applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    setTheme(getUserThemeOverride(doc.uid) ?? doc.default_theme);
  }, [doc.uid, doc.default_theme]);

  useEffect(() => {
    if (!canComment) setPendingDraft(null);
  }, [canComment]);

  const headingIds = useMemo(() => flattenTocIds(liveRendered.toc), [liveRendered.toc]);
  const headingIdsKey = useMemo(() => headingIds.join('\u0000'), [headingIds]);

  useEffect(() => {
    const container = docBodyRef.current;
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
      let current = headings[0]!.id;

      for (const heading of headings) {
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
    return () => {
      container.removeEventListener('scroll', scheduleUpdate);
      window.removeEventListener('resize', scheduleUpdate);
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
        setMentionSeedNames(r.mention_candidates);
        notifyPendingMentions(r.threads, r.pending_mentions);
      },
      (err) => reportError('DocumentLayout.listThreads', err, { uid: doc.uid }),
    );
    return () => {
      cancelled = true;
    };
  }, [doc.uid]);

  useEffect(() => {
    let cancelled = false;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    function scheduleRefresh() {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void refreshThreads(); }, 300);
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
          void listThreads(doc.uid).then((res) => {
            if (cancelled) return;
            setThreads(res.threads);
            setMentionSeedNames(res.mention_candidates);
            notifyPendingMentions(res.threads, res.pending_mentions);
          }).catch((err) => reportError('DocumentLayout.mention.created', err, { uid: doc.uid }));
          break;
        }
        case 'edit_proposal.created': {
          void refreshThreads();
          const raw = event.edit_proposal as Record<string, unknown>;
          const comment = raw.comment as Record<string, unknown> | undefined;
          const author = comment?.author as { display_name?: string } | undefined;
          notify(
            'New edit proposal',
            `${author?.display_name ?? 'Someone'} proposed a change.`,
          );
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
    return () => { cancelled = true; if (refreshTimer) clearTimeout(refreshTimer); sub.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.uid]);

  const mentionCandidates = useMemo(() => {
    const names = new Map<string, string>();
    for (const name of mentionSeedNames) addMentionName(names, name);
    for (const thread of threads) {
      addMentionName(names, thread.root.author.display_name);
      for (const reply of thread.replies) addMentionName(names, reply.author.display_name);
    }
    if (doc.display_name) addMentionName(names, doc.display_name);
    return Array.from(names.values()).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
  }, [threads, doc.display_name, mentionSeedNames]);

  function resolveIdentity(providedName?: string) {
    const name = providedName?.trim() || effectiveDisplayName;
    if (!name) return null;
    // setDisplayName fires an in-app event → useDisplayName re-runs, so all
    // mirror components (AppBar UserMenu, etc.) stay in sync. The server
    // now treats subsequent-visit header names as authoritative, so
    // renames always flow through here cleanly.
    if (name !== displayName) setDisplayName(name);
    return { clientId: getClientId(), displayName: name };
  }

  const scrollToAnchor = useCallback((blockId: string) => {
    const root = docRef.current;
    if (!root) return;
    const escaped = CSS.escape(blockId);
    const target = root.querySelector<HTMLElement>(
      `[data-block="${escaped}"], [data-subblock="${escaped}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('anchor-flash');
    window.setTimeout(() => target.classList.remove('anchor-flash'), 1600);
  }, []);

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
        await refreshThreads();
      } catch (err) {
        reportError('DocumentLayout.createComment', err, { uid: doc.uid });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Failed to post');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canComment, doc.uid, displayName, effectiveDisplayName],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, effectiveDisplayName],
  );

  const onResolveThread = useCallback(
    async (
      id: string,
      kind: 'resolve' | 'reopen' | 'accept' | 'reject',
      body?: string,
      name?: string,
    ) => {
      const identity = resolveIdentity(name);
      if (!identity) return;
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
      } catch (err) {
        reportError('DocumentLayout.resolveThread', err, { id, kind });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : `${kind} failed`);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, effectiveDisplayName],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, effectiveDisplayName],
  );

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
      setMentionSeedNames(res.mention_candidates);
    } catch (err) {
      reportError('DocumentLayout.refreshThreads', err, { uid: doc.uid });
    }
  }, [doc.uid]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, effectiveDisplayName, refreshDoc],
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
        if (payload.rationale) req.rationale = payload.rationale;
        await apiCreateProposal(doc.uid, req, identity);
        setPendingDraft(null);
        setError(null);
        await refreshThreads();
      } catch (err) {
        reportError('DocumentLayout.createProposal', err, { uid: doc.uid });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Failed to propose');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, pendingProposalTarget],
  );

  const onEditProposalRationale = useCallback(
    async (id: string, rationale: string | null) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        await apiUpdateProposal(doc.uid, id, { rationale }, identity);
        await refreshThreads();
      } catch (err) {
        reportError('DocumentLayout.editProposalRationale', err, { id });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName],
  );

  const onDeleteThread = useCallback(
    async (threadId: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        await apiDeleteThread(doc.uid, threadId, identity);
        setThreads((prev) => prev.filter((t) => t.id !== threadId && t.root.id !== threadId));
      } catch (err) {
        reportError('DocumentLayout.deleteThread', err, { threadId });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Delete failed');
        await refreshThreads();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, effectiveDisplayName],
  );

  const onDeleteNode = useCallback(
    async (nodeId: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        await apiDelete(doc.uid, nodeId, identity);
        setThreads((prev) =>
          prev.map((t) =>
            t.replies.some((r) => r.id === nodeId)
              ? { ...t, replies: t.replies.filter((r) => r.id !== nodeId) }
              : t,
          ),
        );
      } catch (err) {
        reportError('DocumentLayout.deleteNode', err, { nodeId });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, effectiveDisplayName],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, effectiveDisplayName, refreshDoc, refreshThreads],
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
  const threadCount = useMemo(() => threads.length, [threads]);

  const commentHighlights = useMemo(() => {
    const highlights: Array<{
      scope: 'range' | 'block';
      threadId?: string;
      blockId: string;
      quote: string;
      startOffset: number;
      endOffset: number;
    }> = [];

    for (const thread of threads) {
      if (thread.link_status !== 'linked') continue;
      if (!thread.anchor.block_id || !thread.anchor.quote) continue;

      if (!isProposal(thread)) {
        const start = thread.anchor.start_offset ?? 0;
        const end = thread.anchor.end_offset ?? 0;
        if (end > start) {
          highlights.push({
            scope: 'range',
            threadId: thread.id,
            blockId: thread.anchor.block_id,
            quote: thread.anchor.quote,
            startOffset: start,
            endOffset: end,
          });
        }
      } else if (thread.state === 'open') {
        highlights.push({
          scope: 'block',
          threadId: thread.id,
          blockId: thread.anchor.block_id,
          quote: thread.anchor.quote,
          startOffset: 0,
          endOffset: thread.anchor.quote.length,
        });
      }
    }

    if (
      canComment &&
      pendingAnchor &&
      pendingAnchor.quote &&
      pendingAnchor.end_offset > pendingAnchor.start_offset
    ) {
      highlights.push({
        scope: 'range',
        blockId: pendingAnchor.block_id,
        quote: pendingAnchor.quote,
        startOffset: pendingAnchor.start_offset,
        endOffset: pendingAnchor.end_offset,
      });
    }

    return highlights;
  }, [canComment, threads, pendingAnchor]);

  const openCommentThread = useCallback((threadId: string) => {
    setCommentsOpen(true);
    setRightTab('comments');
    setFocusedThread((prev) => ({ threadId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, effectiveDisplayName, openCommentThread, refreshDoc, refreshThreads],
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
          {tocOpen && <Toc nodes={liveRendered.toc} activeId={activeHeadingId} />}
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
            <DownloadMenu doc={doc} source={liveSource} theme={theme} />
            {children}
            {doc.role === 'admin' && onDocSettingsChanged && (
              <>
                <DocumentSettingsDialog doc={doc} onChange={onDocSettingsChanged} />
                <AccessControlDialog doc={doc} onChange={onDocSettingsChanged} />
              </>
            )}
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
            <div className="doc-search-popover">
              <Flex align="center" gap="2" className="doc-search-toolbar">
                <TextField.Root
                  ref={docSearchInputRef}
                  size="1"
                  type="search"
                  value={docSearchQuery}
                  onChange={(event) => setDocSearchQuery(event.target.value)}
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
                    variant={docSearchCaseSensitive ? 'soft' : 'ghost'}
                    color={docSearchCaseSensitive ? APP_ACCENT_COLOR : 'gray'}
                    className={`doc-search-option ${docSearchCaseSensitive ? 'active' : ''}`}
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
                    variant={docSearchWholeWords ? 'soft' : 'ghost'}
                    color={docSearchWholeWords ? APP_ACCENT_COLOR : 'gray'}
                    className={`doc-search-option ${docSearchWholeWords ? 'active' : ''}`}
                    aria-label={
                      docSearchWholeWords ? 'Disable whole-word search' : 'Enable whole-word search'
                    }
                    aria-pressed={docSearchWholeWords}
                    onClick={() => {
                      setDocSearchWholeWords((prev) => !prev);
                      docSearchInputRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    <TokensIcon />
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
          <div className="doc-body" ref={docBodyRef}>
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
              onHighlightClick={openCommentThread}
              onMissingAssetUpload={canEdit ? onMissingAssetUpload : undefined}
            />
            {canComment && (
              <SelectionToolbar
                rootRef={docRef}
                onAdd={(anchor) => setPendingDraft({ mode: 'comment', anchor })}
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
        </main>

        <aside className={`pane pane-right ${commentsOpen ? 'open' : 'closed'}`}>
          {commentsOpen && (
            <ResizeHandle side="right" width={commentsWidth} onResize={setCommentsWidth} />
          )}
          {commentsOpen ? (
            <Tabs.Root
              value={rightTab}
              onValueChange={(v) => setRightTab(v as 'comments' | 'history' | 'search')}
              className="right-tabs"
            >
              <Flex align="center" px="2" pt="2" className="pane-header">
                <Tabs.List size="1">
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
              <Tabs.Content value="comments" className="right-tab-panel">
                <CommentsPane
                  uid={doc.uid}
                  threads={threads}
                  docSource={liveSource}
                  blockRanges={blockRanges}
                  mentionCandidates={mentionCandidates}
                  canComment={canComment}
                  pendingAnchor={canComment ? pendingAnchor : null}
                  focusedThread={focusedThread}
                  onCancelPending={() => setPendingDraft(null)}
                  displayName={effectiveDisplayName}
                  onCreate={onCreate}
                  onReply={onReply}
                  onEdit={onEdit}
                  onDeleteNode={onDeleteNode}
                  onDeleteThread={onDeleteThread}
                  onResolveThread={onResolveThread}
                  onEditProposalRationale={onEditProposalRationale}
                  onScrollToAnchor={scrollToAnchor}
                />
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
        docSource={liveSource}
        docFormat={doc.format}
        blockRanges={blockRanges}
        needsName={!displayName}
        onCancel={() => setPendingDraft(null)}
        onSubmit={onCreateProposal}
      />
    </div>
  );
}

function notifyPendingMentions(threads: Thread[], pendingMentionIds: string[]): void {
  if (pendingMentionIds.length === 0) return;
  const byId = new Map<string, ThreadCommentNode>();
  for (const t of threads) {
    byId.set(t.root.id, t.root);
    for (const r of t.replies) byId.set(r.id, r);
  }
  for (const id of pendingMentionIds) {
    const node = byId.get(id);
    if (node) {
      notify(
        'Mentioned in a comment',
        `${node.author.display_name}: ${node.body.slice(0, 120)}`,
      );
    }
  }
}

function addMentionName(map: Map<string, string>, name: string | null | undefined): void {
  const trimmed = name?.trim();
  if (!trimmed) return;
  const key = trimmed.toLowerCase();
  if (!map.has(key)) map.set(key, trimmed);
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
