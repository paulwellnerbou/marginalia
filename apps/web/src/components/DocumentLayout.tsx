import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Box, Flex, IconButton, Select, Slider, Tabs, Text, Tooltip } from '@radix-ui/themes';
import { ChevronLeftIcon, ChevronRightIcon } from '@radix-ui/react-icons';
import type {
  CommentAnchor,
  Document,
  Comment,
  DocumentSettingsResponse,
  EditProposal,
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
  acceptEditProposal as apiAcceptProposal,
  rejectEditProposal as apiRejectProposal,
  getDocument,
  ApiError,
} from '../lib/api.js';
import { getClientId, getDisplayName, setDisplayName } from '../lib/identity.js';
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
import { RenderedDoc } from './RenderedDoc.js';
import { Toc } from './Toc.js';
import { SelectionToolbar, type ProposalTarget } from './SelectionToolbar.js';
import { BlockActions } from './BlockActions.js';
import { CommentsPane } from './CommentsPane.js';
import { ResizeHandle } from './ResizeHandle.js';
import { AppBar } from './AppBar.js';
import { AdminSettingsDialog } from './AdminSettingsDialog.js';
import { HistoryList } from './HistoryList.js';
import { documentTitle } from '../lib/doc-title.js';

const MAX_WIDTH_KEY = 'marginalia.maxWidth';
const TOC_WIDTH_KEY = 'marginalia.tocWidth';
const COMMENTS_WIDTH_KEY = 'marginalia.commentsWidth';
const COLLAPSED_WIDTH = 36;

interface Props {
  doc: Document;
  /** Called by admin settings when the server-side settings change. */
  onDocSettingsChanged?: (s: DocumentSettingsResponse) => void;
  children?: ReactNode;
}

export function DocumentLayout({ doc, onDocSettingsChanged, children }: Props) {
  const [tocOpen, setTocOpen] = useState(true);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [rightTab, setRightTab] = useState<'comments' | 'history'>('comments');
  const [historyVersion, setHistoryVersion] = useState(0);

  const [maxWidth, setMaxWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(MAX_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : 72;
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
  const [pendingAnchor, setPendingAnchor] = useState<CommentAnchor | null>(null);
  const [pendingProposalTarget, setPendingProposalTarget] = useState<ProposalTarget | null>(null);
  /** Mirror of `doc.source` and `doc.rendered`, mutated when a proposal is
   *  accepted (auto-merged) so the displayed doc stays fresh without a reload. */
  const [liveSource, setLiveSource] = useState<string>(doc.source);
  const [liveRendered, setLiveRendered] = useState(doc.rendered);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLiveSource(doc.source);
    setLiveRendered(doc.rendered);
  }, [doc.uid, doc.source, doc.rendered]);
  const [displayName, setDisplayNameState] = useState<string | null>(() => getDisplayName());
  const [theme, setTheme] = useState<string>(
    () => getUserThemeOverride(doc.uid) ?? doc.default_theme,
  );

  const docRef = useRef<HTMLElement>(null);

  useEffect(() => {
    localStorage.setItem(MAX_WIDTH_KEY, String(maxWidth));
  }, [maxWidth]);
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
    let cancelled = false;
    listComments(doc.uid).then(
      (r) => {
        if (!cancelled) setComments(r.comments);
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
          notify('New comment', `${c.author.display_name}: ${c.body.slice(0, 120)}`);
          break;
        }
        case 'comment.updated': {
          const c = event.comment as unknown as CommentT;
          setComments((prev) => prev.map((x) => (x.id === c.id ? c : x)));
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

  function resolveIdentity(providedName?: string) {
    const name = providedName?.trim() || displayName;
    if (!name) return null;
    if (name !== displayName) {
      setDisplayName(name);
      setDisplayNameState(name);
    }
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
    async (
      payload: { anchor?: CommentAnchor; parent_id?: string; body: string; display_name?: string },
    ) => {
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
    [doc.uid, displayName],
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
    [doc.uid, displayName],
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
    [doc.uid, displayName],
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
    [doc.uid, displayName],
  );

  const tocPx = tocOpen ? tocWidth : COLLAPSED_WIDTH;
  const commentsPx = commentsOpen ? commentsWidth : COLLAPSED_WIDTH;
  const gridStyle: React.CSSProperties = {
    gridTemplateColumns: `${tocPx}px 1fr ${commentsPx}px`,
  };

  const title = documentTitle(doc);

  return (
    <div className="doc-page">
      <AppBar
        docTitle={title}
        trailing={
          <>
            {doc.role === 'admin' && onDocSettingsChanged && (
              <AdminSettingsDialog doc={doc} onChange={onDocSettingsChanged} />
            )}
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
              <Text size="1" color="gray" weight="medium">Contents</Text>
            )}
          </Flex>
          {tocOpen && <Toc nodes={doc.rendered.toc} />}
          {tocOpen && <ResizeHandle side="left" width={tocWidth} onResize={setTocWidth} />}
        </aside>

        <main className="pane pane-doc">
          {/* Document-specific toolbar lives inside the doc pane so it sits
              only over the document column, not above the side panes. */}
          <Flex align="center" gap="3" px="3" py="2" className="doc-chrome">
            <span className="spacer" />
            <Flex align="center" gap="2" className="width-slider">
              <Text size="1" color="gray">Reading width</Text>
              <Slider
                size="1"
                style={{ width: 160 }}
                min={40}
                max={120}
                step={1}
                value={[maxWidth]}
                onValueChange={(v) => setMaxWidth(v[0] ?? maxWidth)}
              />
              <Text size="1" color="gray" style={{ minWidth: '4ch' }}>{maxWidth}ch</Text>
            </Flex>
            <span className="spacer" />
            {error && <Text size="1" color="red">{error}</Text>}
            <Flex align="center" gap="2">
              <Text size="1" color="gray" as="label" htmlFor="doc-theme-select">
                Theme
              </Text>
              <Select.Root
                value={theme}
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
          </Flex>
          <div className="doc-body">
            <RenderedDoc rendered={liveRendered} elRef={docRef} maxWidthCh={maxWidth} />
            <SelectionToolbar
              rootRef={docRef}
              onAdd={setPendingAnchor}
              onPropose={setPendingProposalTarget}
            />
            <BlockActions rootRef={docRef} onPropose={setPendingProposalTarget} />
          </div>
        </main>

        <aside className={`pane pane-right ${commentsOpen ? 'open' : 'closed'}`}>
          {commentsOpen && (
            <ResizeHandle side="right" width={commentsWidth} onResize={setCommentsWidth} />
          )}
          {commentsOpen ? (
            <Tabs.Root
              value={rightTab}
              onValueChange={(v) => setRightTab(v as 'comments' | 'history')}
              className="right-tabs"
            >
              <Flex align="center" px="2" pt="2" className="pane-header">
                <Tabs.List size="1">
                  <Tabs.Trigger value="comments">Comments</Tabs.Trigger>
                  <Tabs.Trigger value="history">History</Tabs.Trigger>
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
                  pendingAnchor={pendingAnchor}
                  onCancelPending={() => setPendingAnchor(null)}
                  pendingProposalTarget={pendingProposalTarget}
                  onCancelPendingProposal={() => setPendingProposalTarget(null)}
                  canEdit={doc.role === 'admin' || doc.role === 'editor'}
                  isDocAdmin={doc.role === 'admin'}
                  displayName={displayName}
                  onCreate={onCreate}
                  onEdit={onEdit}
                  onDelete={onDelete}
                  onResolve={onResolve}
                  onCreateProposal={onCreateProposal}
                  onAcceptProposal={onAcceptProposal}
                  onRejectProposal={onRejectProposal}
                  onDeleteProposal={onDeleteProposal}
                  onScrollToAnchor={scrollToAnchor}
                />
              </Tabs.Content>
              <Tabs.Content value="history" className="right-tab-panel">
                <HistoryList uid={doc.uid} version={historyVersion} />
              </Tabs.Content>
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
    </div>
  );
}
