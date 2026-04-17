import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { render, type RenderResult } from '@markdowner/renderer';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { ensureIdentity } from '../lib/identity.js';
import { getDocument, updateDocument, ApiError, type Document } from '../lib/api.js';
import { RenderedDoc } from '../components/RenderedDoc.js';

export function EditPage() {
  const { uid } = useParams<{ uid: string }>();
  const navigate = useNavigate();
  const [doc, setDoc] = useState<Document | null>(null);
  const [source, setSource] = useState('');
  const [rendered, setRendered] = useState<RenderResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const editorEl = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!uid) return;
    getDocument(uid).then(
      (d) => {
        setDoc(d);
        setSource(d.source);
      },
      (err) => {
        if (err instanceof ApiError) setError(`${err.status}: ${err.code}`);
        else setError('Failed to load');
      },
    );
  }, [uid]);

  useEffect(() => {
    if (!editorEl.current || doc === null || viewRef.current) return;
    const state = EditorState.create({
      doc: doc.source,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) setSource(u.state.doc.toString());
        }),
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, monospace' },
        }),
      ],
    });
    viewRef.current = new EditorView({ state, parent: editorEl.current });
    return () => {
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [doc]);

  // Debounced client-side preview render.
  useEffect(() => {
    if (!source) {
      setRendered(null);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const r = await render(source);
        setRendered(r);
      } catch {
        // swallow — preview is best-effort while typing
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [source]);

  async function handleSave() {
    if (!uid) return;
    const identity = ensureIdentity();
    if (!identity) {
      setError('A display name is required to save.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateDocument(uid, source, identity);
      navigate(`/d/${uid}`);
    } catch (err) {
      if (err instanceof ApiError) setError(`${err.status}: ${err.code}`);
      else setError('Save failed');
    } finally {
      setSaving(false);
    }
  }

  const canSave = useMemo(() => {
    if (!doc) return false;
    if (doc.role === 'admin') return true;
    return doc.role === 'editor';
  }, [doc]);

  if (error && !doc) {
    return (
      <div className="page error-page">
        <p>{error}</p>
        <Link to="/">← Home</Link>
      </div>
    );
  }
  if (!doc) return <div className="page loading">Loading…</div>;

  return (
    <div className="edit-layout">
      <header className="edit-header">
        <Link to={`/d/${doc.uid}`} className="chip">
          ← Back to view
        </Link>
        <span className="spacer" />
        {error && <span className="error">{error}</span>}
        <button className="primary" disabled={!canSave || saving} onClick={handleSave}>
          {saving ? 'Saving…' : canSave ? 'Save' : 'Read-only'}
        </button>
      </header>
      <div className="edit-body">
        <div className="edit-source" ref={editorEl} />
        <div className="edit-preview">
          {rendered ? <RenderedDoc rendered={rendered} /> : <div className="subtle">Preview…</div>}
        </div>
      </div>
    </div>
  );
}
