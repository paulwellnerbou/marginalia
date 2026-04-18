import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { saveInviteToken } from '../lib/invite.js';
import { Button, Container, Text, TextField } from '@radix-ui/themes';
import { ChevronLeftIcon } from '@radix-ui/react-icons';
import { render, type RenderResult } from '@marginalia/renderer';
import { EditorView, basicSetup } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { getClientId, getDisplayName, setDisplayName } from '../lib/identity.js';
import { getDocument, updateDocument, ApiError, type Document } from '../lib/api.js';
import { documentTitle } from '../lib/doc-title.js';
import { reportError } from '../lib/log.js';
import { RenderedDoc } from '../components/RenderedDoc.js';
import { AppBar } from '../components/AppBar.js';

export function EditPage() {
  const { uid, token } = useParams<{ uid: string; token?: string }>();

  useEffect(() => {
    if (uid && token) saveInviteToken(uid, token);
  }, [uid, token]);

  const navigate = useNavigate();
  const [doc, setDoc] = useState<Document | null>(null);
  const [source, setSource] = useState('');
  const [rendered, setRendered] = useState<RenderResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState<string>(() => getDisplayName() ?? '');

  const editorEl = useRef<HTMLDivElement>(null);
  const previewEl = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!doc) return;
    const previous = document.title;
    document.title = `Editing: ${documentTitle(doc)} · Marginalia`;
    return () => {
      document.title = previous;
    };
  }, [doc]);

  useEffect(() => {
    if (!uid) return;
    getDocument(uid).then(
      (d) => {
        setDoc(d);
        setSource(d.source);
      },
      (err) => {
        reportError('EditPage.load', err, { uid });
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

  useEffect(() => {
    if (!source) {
      setRendered(null);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const r = await render(source);
        setRendered(r);
      } catch (err) {
        reportError('EditPage.preview', err);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [source]);

  // Sync scrolling between source and preview
  useEffect(() => {
    const scroller = editorEl.current?.querySelector('.cm-scroller');
    const preview = previewEl.current;
    if (!scroller || !preview) return;

    let isSyncingLeft = false;
    let isSyncingRight = false;
    let timerLeft = 0;
    let timerRight = 0;

    const onLeftScroll = () => {
      if (isSyncingRight) return;
      isSyncingLeft = true;
      clearTimeout(timerLeft);
      timerLeft = window.setTimeout(() => { isSyncingLeft = false; }, 50);

      const maxScrollSrc = scroller.scrollHeight - scroller.clientHeight;
      const maxScrollPreview = preview.scrollHeight - preview.clientHeight;
      if (maxScrollSrc <= 0) return;
      preview.scrollTop = (scroller.scrollTop / maxScrollSrc) * maxScrollPreview;
    };

    const onRightScroll = () => {
      if (isSyncingLeft) return;
      isSyncingRight = true;
      clearTimeout(timerRight);
      timerRight = window.setTimeout(() => { isSyncingRight = false; }, 50);

      const maxScrollSrc = scroller.scrollHeight - scroller.clientHeight;
      const maxScrollPreview = preview.scrollHeight - preview.clientHeight;
      if (maxScrollPreview <= 0) return;
      scroller.scrollTop = (preview.scrollTop / maxScrollPreview) * maxScrollSrc;
    };

    scroller.addEventListener('scroll', onLeftScroll, { passive: true });
    preview.addEventListener('scroll', onRightScroll, { passive: true });

    return () => {
      scroller.removeEventListener('scroll', onLeftScroll);
      preview.removeEventListener('scroll', onRightScroll);
      clearTimeout(timerLeft);
      clearTimeout(timerRight);
    };
  }, [doc, rendered]);

  async function handleSave() {
    if (!uid) return;
    const resolved = name.trim();
    if (!resolved) {
      setError('Enter a display name to save.');
      return;
    }
    setDisplayName(resolved);
    const identity = { clientId: getClientId(), displayName: resolved };
    setSaving(true);
    setError(null);
    try {
      await updateDocument(uid, source, identity);
      navigate(`/d/${uid}`);
    } catch (err) {
      reportError('EditPage.save', err, { uid });
      if (err instanceof ApiError) setError(`${err.status}: ${err.code}`);
      else setError(err instanceof Error ? `Save failed: ${err.message}` : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const canSave = useMemo(() => {
    if (!doc) return false;
    return doc.role === 'admin' || doc.role === 'editor';
  }, [doc]);

  if (error && !doc) {
    return (
      <>
        <AppBar />
        <Container size="2" py="8">
          <Text color="red">{error}</Text>{' '}
          <Link to="/">← Home</Link>
        </Container>
      </>
    );
  }
  if (!doc) {
    return (
      <>
        <AppBar />
        <Container size="2" py="8">
          <Text color="gray">Loading…</Text>
        </Container>
      </>
    );
  }

  return (
    <div className="edit-page">
      <AppBar
        docTitle={`Editing: ${documentTitle(doc)}`}
        role={doc.role}
        forcedDisplayName={doc.display_name}
        trailing={
          <>
            <Button variant="soft" color="gray" size="2" asChild>
              <Link to={`/d/${doc.uid}`} aria-label="Back to view">
                <ChevronLeftIcon /> Back
              </Link>
            </Button>
            {canSave && (
              <TextField.Root
                size="1"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your display name"
                maxLength={80}
                style={{ width: 180 }}
              />
            )}
            {error && <Text size="1" color="red">{error}</Text>}
            <Button
              size="2"
              disabled={!canSave || saving || !name.trim()}
              onClick={handleSave}
              variant={canSave ? 'solid' : 'soft'}
            >
              {saving ? 'Saving…' : canSave ? 'Save' : 'Read-only'}
            </Button>
          </>
        }
      />
      <div className="edit-body">
        <div className="edit-source" ref={editorEl} />
        <div className="edit-preview" ref={previewEl}>
          {rendered ? (
            <RenderedDoc rendered={rendered} />
          ) : (
            <Text color="gray" size="2" as="p" mx="4" mt="4">Preview…</Text>
          )}
        </div>
      </div>
    </div>
  );
}
