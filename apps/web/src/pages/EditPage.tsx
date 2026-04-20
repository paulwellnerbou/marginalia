import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { saveInviteToken } from '../lib/invite.js';
import { Button, Container, Text, TextField } from '@radix-ui/themes';
import { ChevronLeftIcon } from '@radix-ui/react-icons';
import type { RenderResult } from '@marginalia/renderer';
import type { EditorView } from 'codemirror';
import { getClientId, getDisplayName, setDisplayName } from '../lib/identity.js';
import {
  getDocument,
  updateDocument,
  ApiError,
  type Document,
  type AttachedAsset,
  uploadAsset,
  deleteAttachedAsset,
} from '../lib/api.js';
import { documentTitle } from '../lib/doc-title.js';
import { reportError } from '../lib/log.js';
import { RenderedDoc } from '../components/RenderedDoc.js';
import { AssetsPanel } from '../components/AssetsPanel.js';
import { AppBar } from '../components/AppBar.js';
import { PasswordPromptDialog } from '../components/PasswordPromptDialog.js';

type EditorDeps = {
  EditorState: typeof import('@codemirror/state').EditorState;
  EditorView: typeof import('codemirror').EditorView;
  basicSetup: typeof import('codemirror').basicSetup;
  markdown: typeof import('@codemirror/lang-markdown').markdown;
};

let editorDepsPromise: Promise<EditorDeps> | null = null;
let rendererPromise: Promise<typeof import('@marginalia/renderer')> | null = null;

/**
 * Scan the source for local asset references — `![alt](filename)` in
 * markdown, `image::filename[]` / `image:…[]` / `include::…[]` in
 * asciidoc. The returned set feeds the AssetsPanel's orphan check: an
 * attached asset whose ref_name isn't in this set is flagged as
 * unreferenced (safe to delete).
 *
 * Not used by the preview rewrite — that path takes the authoritative
 * attached-asset set from the server's `attached_assets` payload.
 */
function collectReferencedRefs(source: string, format: 'markdown' | 'asciidoc'): Set<string> {
  const out = new Set<string>();
  // Markdown: ![alt](src), ignore reference-style. Keep it narrow —
  // we'd rather miss an edge case than offer a false "match" on
  // external URLs or linkified text.
  const mdRe = /!\[[^\]]*\]\(([^)\s"']+)/g;
  // AsciiDoc: image::src[]  /  image:src[] (inline) / include::src[]
  const adocRe = /(?:^|\s)(?:image::|image:|include::)([^\s\[]+)/g;
  const re = format === 'asciidoc' ? adocRe : mdRe;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const raw = m[1];
    if (!raw) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('/') || raw.startsWith('#')) continue;
    out.add(raw);
  }
  return out;
}

function loadEditorDeps(): Promise<EditorDeps> {
  if (!editorDepsPromise) {
    editorDepsPromise = Promise.all([
      import('@codemirror/state'),
      import('codemirror'),
      import('@codemirror/lang-markdown'),
    ]).then(([state, view, markdown]) => ({
      EditorState: state.EditorState,
      EditorView: view.EditorView,
      basicSetup: view.basicSetup,
      markdown: markdown.markdown,
    }));
  }
  return editorDepsPromise;
}

function loadRenderer(): Promise<typeof import('@marginalia/renderer')> {
  if (!rendererPromise) rendererPromise = import('@marginalia/renderer');
  return rendererPromise;
}

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
  const [attached, setAttached] = useState<AttachedAsset[]>([]);

  const editorEl = useRef<HTMLDivElement>(null);
  const previewEl = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const previewRequestRef = useRef(0);

  const canEdit = useMemo(() => {
    if (!doc) return false;
    return doc.role === 'admin' || doc.role === 'editor';
  }, [doc]);

  const attachedRefs = useMemo(
    () => new Set(attached.map((a) => a.ref_name)),
    [attached],
  );

  const referencedRefs = useMemo(
    () => collectReferencedRefs(source, doc?.format ?? 'markdown'),
    [source, doc?.format],
  );

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
        setAttached(d.attached_assets ?? []);
      },
      (err) => {
        reportError('EditPage.load', err, { uid });
        if (err instanceof ApiError) setError(`${err.status}: ${err.code}`);
        else setError('Failed to load');
      },
    );
  }, [uid]);

  // Mirror ViewPage: sync localStorage AND the header TextField state to
  // the server's authoritative name. Without the setName, the TextField
  // keeps showing whatever getDisplayName() returned at mount and Save
  // would silently revert the invite-seeded identity.
  useEffect(() => {
    if (!doc?.display_name) return;
    if (getDisplayName() !== doc.display_name) {
      setDisplayName(doc.display_name);
    }
    setName(doc.display_name);
  }, [doc]);

  useEffect(() => {
    if (!editorEl.current || doc === null || viewRef.current) return;
    let disposed = false;
    void loadEditorDeps().then(
      ({ EditorState, EditorView, basicSetup, markdown }) => {
        if (disposed || !editorEl.current || viewRef.current) return;
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
      },
      (err) => {
        reportError('EditPage.editor', err, { uid });
        if (!disposed) setError('Failed to load editor');
      },
    );
    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [doc, uid]);

  useEffect(() => {
    previewRequestRef.current += 1;
    const requestId = previewRequestRef.current;
    if (!source || !uid) {
      setRendered(null);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const { render, rewriteAssetReferences } = await loadRenderer();
        const r = await render(source);
        // Apply the same server-side asset rewrite to the preview HTML so
        // dropzones / missing-asset placeholders match what the viewer
        // will see after save. Without this, the editor's preview would
        // show broken `<img>` icons for every attached image.
        r.html = await rewriteAssetReferences(r.html, {
          docUid: uid,
          attached: attachedRefs,
        });
        if (previewRequestRef.current !== requestId) return;
        setRendered(r);
      } catch (err) {
        reportError('EditPage.preview', err);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [source, uid, attachedRefs]);

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

  const uploadAndAttach = useCallback(
    async (refName: string, file: File) => {
      if (!uid) return;
      const resolvedName = (name || getDisplayName() || '').trim();
      if (!resolvedName) {
        setError('Enter a display name before uploading.');
        return;
      }
      try {
        const { asset } = await uploadAsset(
          uid,
          refName,
          file,
          { clientId: getClientId(), displayName: resolvedName },
        );
        // Upsert: replace any existing row for the same refName.
        setAttached((prev) => {
          const next = prev.filter((a) => a.ref_name !== refName);
          next.push(asset);
          return next;
        });
      } catch (err) {
        reportError('EditPage.uploadAsset', err, { uid, refName });
        if (err instanceof ApiError) setError(`Upload failed: ${err.status} ${err.code}`);
        else setError('Upload failed');
      }
    },
    [uid, name],
  );

  const handleDeleteAsset = useCallback(
    async (refName: string) => {
      if (!uid) return;
      const resolvedName = (name || getDisplayName() || '').trim();
      if (!resolvedName) {
        setError('Enter a display name before deleting assets.');
        return;
      }
      try {
        await deleteAttachedAsset(uid, refName, {
          clientId: getClientId(),
          displayName: resolvedName,
        });
        setAttached((prev) => prev.filter((a) => a.ref_name !== refName));
      } catch (err) {
        reportError('EditPage.deleteAsset', err, { uid, refName });
        if (err instanceof ApiError) setError(`Delete failed: ${err.status} ${err.code}`);
      }
    },
    [uid, name],
  );

  // Editor-pane paste: if the clipboard has an image, upload it under a
  // generated ref name and insert the markdown reference at the cursor.
  // Deliberately scoped to the editor DOM, not the window, so pasting
  // into the display-name field etc. is unaffected.
  useEffect(() => {
    const root = editorEl.current;
    if (!root || !canEdit || !uid) return;
    const handler = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind !== 'file') continue;
        const file = item.getAsFile();
        if (!file || !file.type.startsWith('image/')) continue;
        e.preventDefault();
        const ext = file.type.split('/')[1]?.split(/[;+]/)[0] || 'png';
        const refName = `pasted-${Date.now()}.${ext}`;
        const insertion = doc?.format === 'asciidoc'
          ? `\nimage::${refName}[]\n`
          : `\n![](${refName})\n`;
        const view = viewRef.current;
        if (view) {
          const { from, to } = view.state.selection.main;
          view.dispatch({
            changes: { from, to, insert: insertion },
            selection: { anchor: from + insertion.length },
          });
        }
        void uploadAndAttach(refName, file);
        break;
      }
    };
    root.addEventListener('paste', handler as EventListener);
    return () => root.removeEventListener('paste', handler as EventListener);
  }, [canEdit, uid, uploadAndAttach, doc?.format]);

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

  // Kept as a named alias for the existing disabled-gate below; canEdit
  // already computes the same thing above.
  const canSave = canEdit;

  if (error && !doc) {
    return (
      <>
        <AppBar />
        {uid && <PasswordPromptDialog docUid={uid} />}
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
        {uid && <PasswordPromptDialog docUid={uid} />}
        <Container size="2" py="8">
          <Text color="gray">Loading…</Text>
        </Container>
      </>
    );
  }

  return (
    <div className="edit-page">
      <PasswordPromptDialog docUid={doc.uid} />
      <AppBar
        docTitle={`Editing: ${documentTitle(doc)}`}
        role={doc.role}
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
      <div className={`edit-body${canEdit ? ' edit-body--with-assets' : ''}`}>
        <div className="edit-source" ref={editorEl} />
        <div className="edit-preview" ref={previewEl}>
          {rendered ? (
            <RenderedDoc
              rendered={rendered}
              onMissingAssetUpload={canEdit ? uploadAndAttach : undefined}
            />
          ) : (
            <Text color="gray" size="2" as="p" mx="4" mt="4">Preview…</Text>
          )}
        </div>
        {canEdit && (
          <AssetsPanel
            docUid={doc.uid}
            assets={attached}
            referencedRefs={referencedRefs}
            canEdit={canEdit}
            onReplace={uploadAndAttach}
            onDelete={handleDeleteAsset}
            onAdd={(file, refName) => uploadAndAttach(refName, file)}
          />
        )}
      </div>
    </div>
  );
}
