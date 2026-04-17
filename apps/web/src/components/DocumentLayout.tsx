import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CommentAnchor, Document, Comment } from '../lib/api.js';
import {
  createComment as apiCreate,
  deleteComment as apiDelete,
  listComments,
  updateComment as apiUpdate,
  ApiError,
} from '../lib/api.js';
import { ensureIdentity } from '../lib/identity.js';
import { RenderedDoc } from './RenderedDoc.js';
import { Toc } from './Toc.js';
import { SelectionToolbar } from './SelectionToolbar.js';
import { CommentsPane } from './CommentsPane.js';

const MAX_WIDTH_KEY = 'markdowner.maxWidth';

interface Props {
  doc: Document;
  children?: ReactNode;
}

export function DocumentLayout({ doc, children }: Props) {
  const [tocOpen, setTocOpen] = useState(true);
  const [commentsOpen, setCommentsOpen] = useState(true);
  const [maxWidth, setMaxWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(MAX_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? saved : 72;
  });

  const [comments, setComments] = useState<Comment[]>([]);
  const [pendingAnchor, setPendingAnchor] = useState<CommentAnchor | null>(null);
  const [error, setError] = useState<string | null>(null);

  const docRef = useRef<HTMLElement>(null);

  useEffect(() => {
    localStorage.setItem(MAX_WIDTH_KEY, String(maxWidth));
  }, [maxWidth]);

  useEffect(() => {
    let cancelled = false;
    listComments(doc.uid).then(
      (r) => {
        if (!cancelled) setComments(r.comments);
      },
      () => {
        /* ignore — comments are optional to the page's usefulness */
      },
    );
    return () => {
      cancelled = true;
    };
  }, [doc.uid]);

  const onCreate = useCallback(
    async (payload: { anchor?: CommentAnchor; parent_id?: string; body: string }) => {
      const identity = ensureIdentity();
      if (!identity) {
        setError('A display name is required to comment.');
        return;
      }
      try {
        const res = await apiCreate(doc.uid, payload, identity);
        setComments((prev) => [...prev, res.comment]);
        setPendingAnchor(null);
      } catch (err) {
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Failed to post');
      }
    },
    [doc.uid],
  );

  const onEdit = useCallback(
    async (id: string, body: string) => {
      const identity = ensureIdentity();
      if (!identity) return;
      try {
        const res = await apiUpdate(doc.uid, id, body, identity);
        setComments((prev) => prev.map((c) => (c.id === id ? res.comment : c)));
      } catch (err) {
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Edit failed');
      }
    },
    [doc.uid],
  );

  const onDelete = useCallback(
    async (id: string) => {
      const identity = ensureIdentity();
      if (!identity) return;
      if (!window.confirm('Delete this comment?')) return;
      try {
        await apiDelete(doc.uid, id, identity);
        setComments((prev) => prev.filter((c) => c.id !== id && c.parent_id !== id));
      } catch (err) {
        setError(err instanceof ApiError ? `${err.status}: ${err.code}` : 'Delete failed');
      }
    },
    [doc.uid],
  );

  return (
    <div className="doc-layout">
      <aside className={`pane pane-toc ${tocOpen ? 'open' : 'closed'}`}>
        <div className="pane-header">
          <button className="chip" onClick={() => setTocOpen((v) => !v)} title="Toggle TOC">
            {tocOpen ? '‹' : '›'}
          </button>
          {tocOpen && <span className="pane-title">Contents</span>}
        </div>
        {tocOpen && <Toc nodes={doc.rendered.toc} />}
      </aside>

      <main className="pane pane-doc">
        <header className="doc-chrome">
          <Link to="/" className="chip">
            ←
          </Link>
          <label className="width-slider" title="Column width">
            <span className="subtle">{maxWidth}ch</span>
            <input
              type="range"
              min={40}
              max={120}
              step={1}
              value={maxWidth}
              onChange={(e) => setMaxWidth(Number(e.target.value))}
            />
          </label>
          <span className="spacer" />
          {error && <span className="error">{error}</span>}
          {doc.password_protected && <span className="chip">🔒</span>}
          <span className="chip role">{doc.role}</span>
          {children}
        </header>
        <div className="doc-body" style={{ ['--md-max-width' as string]: `${maxWidth}ch` }}>
          <RenderedDoc rendered={doc.rendered} elRef={docRef} />
          <SelectionToolbar rootRef={docRef} onAdd={setPendingAnchor} />
        </div>
      </main>

      <aside className={`pane pane-comments ${commentsOpen ? 'open' : 'closed'}`}>
        <div className="pane-header">
          {commentsOpen && <span className="pane-title">Comments</span>}
          <button
            className="chip"
            onClick={() => setCommentsOpen((v) => !v)}
            title="Toggle comments"
          >
            {commentsOpen ? '›' : '‹'}
          </button>
        </div>
        {commentsOpen && (
          <CommentsPane
            comments={comments}
            pendingAnchor={pendingAnchor}
            onCancelPending={() => setPendingAnchor(null)}
            isDocAdmin={doc.role === 'admin'}
            onCreate={onCreate}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        )}
      </aside>
    </div>
  );
}
