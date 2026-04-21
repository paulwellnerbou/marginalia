import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  MagnifyingGlassIcon,
} from '@radix-ui/react-icons';
import type {
  CommentAnchor,
  Document,
  Comment,
  DocumentSettingsResponse,
  EditProposal,
  TocNode,
} from '../lib/api.js';
import {
  createComment as apiCreate,
  deleteComment as apiDelete,
  listComments,
  resolveComment as apiResolve,
  updateComment as apiUpdate,
  listEditProposals,
  createEditProposal as apiCreateProposal,
  deleteEditProposal as apiDeleteProposal,
  updateEditProposal as apiUpdateProposal,
  acceptEditProposal as apiAcceptProposal,
  rejectEditProposal as apiRejectProposal,
  getDocument,
  uploadAsset,
  ApiError,
} from '../lib/api.js';
import { getClientId, setDisplayName, useDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { subscribeToDocumentEvents } from '../lib/events.js';
import { ensureNotificationPermission, notify } from '../lib/notifications.js';
import type { Comment as CommentT } from '../lib/api.js';
import {
  applyTheme,
  BUILT_IN_THEMES,
  getUserThemeOverride,
  setUserThemeOverride,
} from '../lib/themes.js';
import { locateAllBlocks, locateAllBlocksAsciidoc } from '@marginalia/renderer';
import { RenderedDoc } from './RenderedDoc.js';
import { Toc } from './Toc.js';
import { SelectionToolbar, type ProposalTarget } from './SelectionToolbar.js';
import { BlockActions } from './BlockActions.js';
import { CommentsPane } from './CommentsPane.js';
import { EditProposalComposer } from './EditProposalComposer.js';
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

export function DocumentLayout({ doc, onDocSettingsChanged, children }: Props) {
  const canComment = doc.role !== 'reader';
  const [tocOpen, setTocOpen] = useState(true);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [rightTab, setRightTab] = useState<'comments' | 'history' | 'search'>('comments');
  const [historyVersion, setHistoryVersion] = useState(0);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [docSearchOpen, setDocSearchOpen] = useState(false);
  const [docSearchQuery, setDocSearchQuery] = useState('');
  const deferredDocSearchQuery = useDeferredValue(docSearchQuery);
  const [searchResults, setSearchResults] = useState<DocumentSearchResult[]>([]);
  const [activeSearchTarget, setActiveSearchTarget] = useState<{ id: string; nonce: number } | null>(
    null,
  );

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

  const [comments, setComments] = useState<Comment[]>([]);
  const [proposals, setProposals] = useState<EditProposal[]>([]);
  const [mentionSeedNames, setMentionSeedNames] = useState<string[]>([]);
  const [pendingAnchor, setPendingAnchor] = useState<CommentAnchor | null>(null);
  const [pendingProposalTarget, setPendingProposalTarget] = useState<ProposalTarget | null>(null);
  const [focusedThread, setFocusedThread] = useState<ThreadFocusTarget | null>(null);
  /** Mirror of `doc.source` and `doc.rendered`, mutated when a proposal is
   *  accepted (auto-merged) so the displayed doc stays fresh without a reload. */
  const [liveSource, setLiveSource] = useState<string>(doc.source);
  const [liveRendered, setLiveRendered] = useState(doc.rendered);
  const [error, setError] = useState<string | null>(null);

  /*
   * Per-block source ranges for the live document. Shared by the
   * EditProposalComposer (extracts the clicked block's source into
   * the textarea) and the CommentsPane (same map, passed down to its
   * EditProposalItems). Recomputed only when the source or format
   * changes, so editors don't pay the parse cost on unrelated re-renders.
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
    setSearchResults([]);
    setActiveSearchTarget(null);
    setActiveHeadingId(null);
  }, [doc.uid]);

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
    if (!canComment) setPendingAnchor(null);
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
    listComments(doc.uid).then(
      (r) => {
        if (cancelled) return;
        setComments(r.comments);
        setMentionSeedNames(r.mention_candidates);
        notifyPendingMentions(r.comments, r.pending_mentions);
      },
      (err) => reportError('DocumentLayout.listComments', err, { uid: doc.uid }),
    );
    listEditProposals(doc.uid).then(
      (r) => {
        if (!cancelled) setProposals(r.edit_proposals);
      },
      (err) => reportError('DocumentLayout.listEditProposals', err, { uid: doc.uid }),
    );
    return () => {
      cancelled = true;
    };
  }, [doc.uid]);

  useEffect(() => {
    void ensureNotificationPermission();
    const sub = subscribeToDocumentEvents(doc.uid, (event) => {
      switch (event.type) {
        case 'comment.created': {
          const c = event.comment as unknown as CommentT;
          setComments((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c]));
          break;
        }
        case 'comment.updated': {
          const c = event.comment as unknown as CommentT;
          setComments((prev) => prev.map((x) => (x.id === c.id ? c : x)));
          break;
        }
        case 'mention.created': {
          const c = event.comment as unknown as CommentT;
          setComments((prev) => (prev.some((x) => x.id === c.id) ? prev : [...prev, c]));
          notifyMention(c);
          break;
        }
        case 'comment.deleted': {
          setComments((prev) =>
            prev.filter((x) => x.id !== event.comment_id && x.parent_id !== event.comment_id),
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
        case 'edit_proposal.created': {
          const p = event.edit_proposal as unknown as EditProposal;
          setProposals((prev) => (prev.some((x) => x.id === p.id) ? prev : [...prev, p]));
          notify('New edit proposal', `${p.author.display_name} proposed a change.`);
          break;
        }
        case 'edit_proposal.updated': {
          const p = event.edit_proposal as unknown as EditProposal;
          setProposals((prev) => prev.map((x) => (x.id === p.id ? p : x)));
          break;
        }
        case 'edit_proposal.deleted': {
          setProposals((prev) => prev.filter((x) => x.id !== event.edit_proposal_id));
          break;
        }
      }
    });
    return () => sub.close();
  }, [doc.uid]);

  const mentionCandidates = useMemo(() => {
    const names = new Map<string, string>();
    for (const name of mentionSeedNames) addMentionName(names, name);
    for (const comment of comments) addMentionName(names, comment.author.display_name);
    if (doc.display_name) addMentionName(names, doc.display_name);
    return Array.from(names.values()).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' }),
    );
  }, [comments, doc.display_name, mentionSeedNames]);

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
    const target = root.querySelector<HTMLElement>(
      `[data-block="${blockId.replace(/"/g, '\\"')}"]`,
    );
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.classList.add('anchor-flash');
    window.setTimeout(() => target.classList.remove('anchor-flash'), 1600);
  }, []);

  const onCreate = useCallback(
    async (payload: {
      anchor?: CommentAnchor;
      parent_id?: string;
      parent_proposal_id?: string;
      body: string;
      display_name?: string;
    }) => {
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
        const { display_name, ...rest } = payload;
        void display_name;
        const res = await apiCreate(doc.uid, rest, identity);
        setComments((prev) => [...prev, res.comment]);
        setPendingAnchor(null);
        setError(null);
      } catch (err) {
        reportError('DocumentLayout.createComment', err, { uid: doc.uid });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Failed to post');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canComment, doc.uid, displayName, effectiveDisplayName],
  );

  const onResolve = useCallback(
    async (id: string, resolved: boolean) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        const res = await apiResolve(doc.uid, id, resolved, identity);
        setComments((prev) => prev.map((c) => (c.id === id ? res.comment : c)));
      } catch (err) {
        reportError('DocumentLayout.resolveComment', err, { id, resolved });
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
        const res = await apiUpdate(doc.uid, id, body, identity);
        setComments((prev) => prev.map((c) => (c.id === id ? res.comment : c)));
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
        const res = await apiCreateProposal(doc.uid, req, identity);
        setProposals((prev) => [...prev, res.edit_proposal]);
        setPendingProposalTarget(null);
        setError(null);
      } catch (err) {
        reportError('DocumentLayout.createProposal', err, { uid: doc.uid });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Failed to propose');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, pendingProposalTarget],
  );

  const onAcceptProposal = useCallback(
    async (id: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        const res = await apiAcceptProposal(doc.uid, id, identity);
        setProposals((prev) => prev.map((p) => (p.id === id ? res.edit_proposal : p)));
        await refreshDoc();
        setHistoryVersion((v) => v + 1);
      } catch (err) {
        reportError('DocumentLayout.acceptProposal', err, { id });
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Accept failed');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, refreshDoc],
  );

  const onRejectProposal = useCallback(
    async (id: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        const res = await apiRejectProposal(doc.uid, id, identity);
        setProposals((prev) => prev.map((p) => (p.id === id ? res.edit_proposal : p)));
      } catch (err) {
        reportError('DocumentLayout.rejectProposal', err, { id });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName],
  );

  const onEditProposalRationale = useCallback(
    async (id: string, rationale: string | null) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        const res = await apiUpdateProposal(doc.uid, id, { rationale }, identity);
        setProposals((prev) => prev.map((p) => (p.id === id ? res.edit_proposal : p)));
      } catch (err) {
        reportError('DocumentLayout.editProposalRationale', err, { id });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName],
  );

  const onDeleteProposal = useCallback(
    async (id: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        await apiDeleteProposal(doc.uid, id, identity);
        setProposals((prev) => prev.filter((p) => p.id !== id));
      } catch (err) {
        reportError('DocumentLayout.deleteProposal', err, { id });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName],
  );

  const onDelete = useCallback(
    async (id: string) => {
      const identity = resolveIdentity();
      if (!identity) return;
      try {
        await apiDelete(doc.uid, id, identity);
        setComments((prev) => prev.filter((c) => c.id !== id && c.parent_id !== id));
      } catch (err) {
        reportError('DocumentLayout.deleteComment', err, { commentId: id });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.uid, displayName, effectiveDisplayName],
  );

  const tocPx = tocOpen ? tocWidth : COLLAPSED_WIDTH;
  const commentsPx = commentsOpen ? commentsWidth : COLLAPSED_WIDTH;
  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `${tocPx}px 1fr ${commentsPx}px`,
  };

  const title = documentTitle(doc);
  const threadCount = useMemo(
    () => comments.filter((c) => c.parent_id === null).length,
    [comments],
  );
  const commentHighlights = useMemo(() => {
    const fromComments: Array<{
      threadId?: string;
      blockId: string;
      quote: string;
      startOffset: number;
      endOffset: number;
    }> = comments
      .filter(
        (comment) =>
          comment.parent_id === null &&
          comment.status === 'active' &&
          comment.anchor !== null &&
          comment.anchor.quote &&
          comment.anchor.end_offset > comment.anchor.start_offset,
      )
      .map((comment) => ({
        threadId: comment.id,
        blockId: comment.anchor!.block_id,
        quote: comment.anchor!.quote,
        startOffset: comment.anchor!.start_offset,
        endOffset: comment.anchor!.end_offset,
      }));

    if (
      canComment &&
      pendingAnchor &&
      pendingAnchor.quote &&
      pendingAnchor.end_offset > pendingAnchor.start_offset
    ) {
      fromComments.push({
        blockId: pendingAnchor.block_id,
        quote: pendingAnchor.quote,
        startOffset: pendingAnchor.start_offset,
        endOffset: pendingAnchor.end_offset,
      });
    }

    return fromComments;
  }, [canComment, comments, pendingAnchor]);

  const openCommentThread = useCallback((threadId: string) => {
    setCommentsOpen(true);
    setRightTab('comments');
    setFocusedThread((prev) => ({ threadId, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

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
        format={doc.format}
        trailing={
          <>
            {children}
          </>
        }
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
              <Text size="1" color="gray" style={{ minWidth: '4ch', whiteSpace: 'nowrap', flexShrink: 0 }}>
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
              <Text size="1" color="gray" style={{ minWidth: '4ch', whiteSpace: 'nowrap', flexShrink: 0 }}>
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
            {doc.role === 'admin' && onDocSettingsChanged && (
              <>
                <DocumentSettingsDialog doc={doc} onChange={onDocSettingsChanged} />
                <AccessControlDialog doc={doc} onChange={onDocSettingsChanged} />
              </>
            )}
            <Tooltip content={docSearchOpen ? 'Close document search' : 'Search document'}>
              <IconButton
                variant="soft"
                color="indigo"
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
              activeSearchResultId={activeSearchTarget?.id ?? null}
              activeSearchVersion={activeSearchTarget?.nonce ?? 0}
              onSearchResultsChange={updateSearchResults}
              onHighlightClick={openCommentThread}
              onMissingAssetUpload={canEdit ? onMissingAssetUpload : undefined}
            />
            {canComment && (
              <SelectionToolbar
                rootRef={docRef}
                onAdd={setPendingAnchor}
                onPropose={setPendingProposalTarget}
              />
            )}
            {canComment && (
              <BlockActions rootRef={docRef} onPropose={setPendingProposalTarget} />
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
                  comments={comments}
                  proposals={proposals}
                  docSource={liveSource}
                  blockRanges={blockRanges}
                  mentionCandidates={mentionCandidates}
                  canComment={canComment}
                  pendingAnchor={canComment ? pendingAnchor : null}
                  focusedThread={focusedThread}
                  onCancelPending={() => setPendingAnchor(null)}
                  pendingProposalTarget={pendingProposalTarget}
                  onCancelPendingProposal={() => setPendingProposalTarget(null)}
                  canEdit={doc.role === 'admin' || doc.role === 'editor'}
                  isDocAdmin={doc.role === 'admin'}
                  viewerClientId={getClientId()}
                  displayName={effectiveDisplayName}
                  onCreate={onCreate}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onResolve={onResolve}
                  onCreateProposal={onCreateProposal}
                  onAcceptProposal={onAcceptProposal}
                  onRejectProposal={onRejectProposal}
                  onDeleteProposal={onDeleteProposal}
                  onEditProposalRationale={onEditProposalRationale}
                  onScrollToAnchor={scrollToAnchor}
                />
              </Tabs.Content>
              <Tabs.Content value="history" className="right-tab-panel">
                <HistoryList uid={doc.uid} version={historyVersion} />
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
      <EditProposalComposer
        target={pendingProposalTarget}
        docSource={liveSource}
        docFormat={doc.format}
        blockRanges={blockRanges}
        needsName={!displayName}
        onCancel={() => setPendingProposalTarget(null)}
        onSubmit={onCreateProposal}
      />
    </div>
  );
}

function notifyPendingMentions(comments: CommentT[], pendingMentionIds: string[]): void {
  if (pendingMentionIds.length === 0) return;
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  for (const id of pendingMentionIds) {
    const comment = byId.get(id);
    if (comment) notifyMention(comment);
  }
}

function notifyMention(comment: CommentT): void {
  notify('Mentioned in a comment', `${comment.author.display_name}: ${comment.body.slice(0, 120)}`);
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
