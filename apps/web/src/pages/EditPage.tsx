import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { saveInviteToken } from '../lib/invite.js';
import { Button, Container, Flex, Select, Slider, Text } from '@radix-ui/themes';
import type { RenderResult } from '@marginalia/renderer';
import type { EditorView } from 'codemirror';
import type { Extension } from '@codemirror/state';
import { getClientId, setDisplayName, useDisplayName } from '../lib/identity.js';
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
import {
  applyTheme,
  BUILT_IN_THEMES,
  getUserThemeOverride,
  setUserThemeOverride,
} from '../lib/themes.js';
import { RenderedDoc } from '../components/RenderedDoc.js';
import { AssetsPanel } from '../components/AssetsPanel.js';
import { AppBar } from '../components/AppBar.js';
import { EditToolbar } from '../components/EditToolbar.js';
import { MarkdownToolbar } from '../components/MarkdownToolbar.js';
import { ResizeHandle } from '../components/ResizeHandle.js';
import { PasswordPromptDialog } from '../components/PasswordPromptDialog.js';

const ASSETS_COLLAPSED_WIDTH = 36;
const LS_ASSETS_OPEN = 'marginalia.editAssetsOpen';
const LS_ASSETS_WIDTH = 'marginalia.editAssetsWidth';
const LS_EDITOR_WIDTH = 'marginalia.editEditorWidth';
const LS_TEXT_ZOOM = 'marginalia.textZoom';
const LS_WORD_WRAP = 'marginalia.editWordWrap';

type EditorDeps = {
  EditorState: typeof import('@codemirror/state').EditorState;
  Compartment: typeof import('@codemirror/state').Compartment;
  EditorView: typeof import('codemirror').EditorView;
  basicSetup: typeof import('codemirror').basicSetup;
  markdown: typeof import('@codemirror/lang-markdown').markdown;
  lineWrapping: Extension;
};

let editorDepsPromise: Promise<EditorDeps> | null = null;
let rendererPromise: Promise<typeof import('@marginalia/renderer')> | null = null;

/**
 * Scan the source for local asset references — `![alt](filename)` in
 * markdown, `image::filename[]` / `image:…[]` / `include::…[]` in
 * asciidoc. The returned set feeds the AssetsPanel's orphan hint: an
 * attached asset whose ref_name isn't in this set is flagged as
 * likely unreferenced by this heuristic scan. Deliberately narrow —
 * raw HTML `<img src>` and other forms aren't detected, so the flag
 * is a "probably safe to remove" hint, not a guarantee.
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
      Compartment: state.Compartment,
      EditorView: view.EditorView,
      basicSetup: view.basicSetup,
      markdown: markdown.markdown,
      lineWrapping: view.EditorView.lineWrapping,
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
  const [savedSource, setSavedSource] = useState('');
  const [rendered, setRendered] = useState<RenderResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<AttachedAsset[]>([]);
  const displayName = useDisplayName();

  const [wordWrap, setWordWrap] = useState<boolean>(() => {
    const saved = localStorage.getItem(LS_WORD_WRAP);
    return saved === null ? true : saved === 'true';
  });
  const wordWrapRef = useRef(wordWrap);
  useEffect(() => { wordWrapRef.current = wordWrap; }, [wordWrap]);

  const [assetsOpen, setAssetsOpen] = useState<boolean>(() => {
    const saved = localStorage.getItem(LS_ASSETS_OPEN);
    return saved === null ? true : saved === 'true';
  });
  const [assetsWidth, setAssetsWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(LS_ASSETS_WIDTH));
    return Number.isFinite(saved) && saved >= 180 ? saved : 260;
  });
  const [editorWidth, setEditorWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem(LS_EDITOR_WIDTH));
    return Number.isFinite(saved) && saved >= 200 ? saved : 500;
  });

  const [textZoom, setTextZoom] = useState<number>(() => {
    const saved = Number(localStorage.getItem(LS_TEXT_ZOOM));
    return Number.isFinite(saved) && saved >= 80 && saved <= 140 ? saved : 100;
  });
  const [theme, setTheme] = useState('default');

  useEffect(() => { localStorage.setItem(LS_ASSETS_OPEN, String(assetsOpen)); }, [assetsOpen]);
  useEffect(() => { localStorage.setItem(LS_ASSETS_WIDTH, String(assetsWidth)); }, [assetsWidth]);
  useEffect(() => { localStorage.setItem(LS_EDITOR_WIDTH, String(editorWidth)); }, [editorWidth]);
  useEffect(() => { localStorage.setItem(LS_TEXT_ZOOM, String(textZoom)); }, [textZoom]);
  useEffect(() => { localStorage.setItem(LS_WORD_WRAP, String(wordWrap)); }, [wordWrap]);
  useEffect(() => { void applyTheme(theme); }, [theme]);

  const editorEl = useRef<HTMLDivElement>(null);
  const previewEl = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editorDepsRef = useRef<EditorDeps | null>(null);
  const wrapCompartmentRef = useRef<import('@codemirror/state').Compartment | null>(null);
  const previewRequestRef = useRef(0);

  const canEdit = useMemo(() => {
    if (!doc) return false;
    return doc.role === 'admin' || doc.role === 'editor';
  }, [doc]);

  const attachedRefs = useMemo(() => new Set(attached.map((a) => a.ref_name)), [attached]);
  const assetVersions = useMemo(
    () => new Map(attached.map((a) => [a.ref_name, a.asset_id])),
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
    if (!doc) return;
    setTheme(getUserThemeOverride(doc.uid) ?? doc.default_theme);
  }, [doc?.uid, doc?.default_theme]);

  useEffect(() => {
    if (!uid) return;
    getDocument(uid).then(
      (d) => {
        setDoc(d);
        setSource(d.source);
        setSavedSource(d.source);
        setAttached(d.attached_assets ?? []);
      },
      (err) => {
        reportError('EditPage.load', err, { uid });
        if (err instanceof ApiError) setError(`${err.status}: ${err.code}`);
        else setError('Failed to load');
      },
    );
  }, [uid]);

  // Mirror ViewPage: sync localStorage to the server's authoritative
  // name so the shared UserMenu label and save identity match the
  // invite-seeded identity.
  useEffect(() => {
    if (!doc?.display_name) return;
    if (displayName !== doc.display_name) {
      setDisplayName(doc.display_name);
    }
  }, [displayName, doc?.display_name]);

  useEffect(() => {
    if (!editorEl.current || doc === null || viewRef.current) return;
    let disposed = false;
    void loadEditorDeps().then(
      (deps) => {
        if (disposed || !editorEl.current || viewRef.current) return;
        editorDepsRef.current = deps;
        const { EditorState, Compartment, EditorView, basicSetup, markdown, lineWrapping } = deps;
        const wrapCompartment = new Compartment();
        wrapCompartmentRef.current = wrapCompartment;
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
            wrapCompartment.of(wordWrapRef.current ? [lineWrapping] : []),
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
      wrapCompartmentRef.current = null;
    };
  }, [doc, uid]);

  // Toggle line wrapping without destroying the editor
  useEffect(() => {
    const view = viewRef.current;
    const compartment = wrapCompartmentRef.current;
    const deps = editorDepsRef.current;
    if (!view || !compartment || !deps) return;
    view.dispatch({
      effects: compartment.reconfigure(wordWrap ? deps.lineWrapping : []),
    });
  }, [wordWrap]);

  useEffect(() => {
    previewRequestRef.current += 1;
    const requestId = previewRequestRef.current;
    if (!source || !uid) {
      setRendered(null);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const { renderDocument, rewriteAssetReferences } = await loadRenderer();
        // Route through renderDocument so asciidoc docs get the
        // asciidoc pipeline — `render()` is markdown-only and would
        // produce broken HTML for `image::foo[]` etc. Defaults to
        // markdown while the doc is still loading.
        const r = await renderDocument(source, doc?.format ?? 'markdown');
        // Apply the same server-side asset rewrite to the preview HTML so
        // dropzones / missing-asset placeholders match what the viewer
        // will see after save. Without this, the editor's preview would
        // show broken `<img>` icons for every attached image.
        r.html = await rewriteAssetReferences(r.html, {
          docUid: uid,
          attached: attachedRefs,
          assetVersions,
        });
        if (previewRequestRef.current !== requestId) return;
        setRendered(r);
      } catch (err) {
        reportError('EditPage.preview', err);
      }
    }, 200);
    return () => clearTimeout(handle);
  }, [source, uid, attachedRefs, assetVersions, doc?.format]);

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
      timerLeft = window.setTimeout(() => {
        isSyncingLeft = false;
      }, 50);

      const maxScrollSrc = scroller.scrollHeight - scroller.clientHeight;
      const maxScrollPreview = preview.scrollHeight - preview.clientHeight;
      if (maxScrollSrc <= 0) return;
      preview.scrollTop = (scroller.scrollTop / maxScrollSrc) * maxScrollPreview;
    };

    const onRightScroll = () => {
      if (isSyncingLeft) return;
      isSyncingRight = true;
      clearTimeout(timerRight);
      timerRight = window.setTimeout(() => {
        isSyncingRight = false;
      }, 50);

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
      const resolvedName = displayName.trim();
      if (!resolvedName) {
        setError('Enter a display name before uploading.');
        return;
      }
      try {
        const { asset } = await uploadAsset(uid, refName, file, {
          clientId: getClientId(),
          displayName: resolvedName,
        });
        // Upsert keyed on the server-returned canonical ref_name. Using
        // the caller-supplied `refName` could leave a duplicate if the
        // server normalized it (e.g. trimmed surrounding whitespace).
        setAttached((prev) => {
          const next = prev.filter((a) => a.ref_name !== asset.ref_name);
          next.push(asset);
          return next;
        });
      } catch (err) {
        reportError('EditPage.uploadAsset', err, { uid, refName });
        if (err instanceof ApiError) setError(`Upload failed: ${err.status} ${err.code}`);
        else setError('Upload failed');
      }
    },
    [uid, displayName],
  );

  const handleDeleteAsset = useCallback(
    async (refName: string) => {
      if (!uid) return;
      const resolvedName = displayName.trim();
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
        else setError('Delete failed');
      }
    },
    [uid, displayName],
  );

  // Editor-pane paste: if the clipboard has an image, upload it under a
  // generated ref name and insert the markdown reference at the cursor.
  // Deliberately scoped to the editor DOM, not the window, so pasting
  // into unrelated UI outside the editor is unaffected.
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
        const insertion =
          doc?.format === 'asciidoc' ? `\nimage::${refName}[]\n` : `\n![](${refName})\n`;
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

  async function handleSave(opts?: { commitMessage?: string; closeAfter?: boolean }) {
    if (!uid) return;
    const resolved = displayName.trim();
    if (!resolved) {
      setError('Enter a display name to save.');
      return;
    }
    setDisplayName(resolved);
    const identity = { clientId: getClientId(), displayName: resolved };
    setSaving(true);
    setError(null);
    try {
      await updateDocument(uid, source, identity, opts?.commitMessage);
      setSavedSource(source);
      if (opts?.closeAfter) navigate(`/d/${uid}`);
    } catch (err) {
      reportError('EditPage.save', err, { uid });
      if (err instanceof ApiError) setError(`${err.status}: ${err.code}`);
      else setError(err instanceof Error ? `Save failed: ${err.message}` : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  const canSave = canEdit;
  const hasChanges = source !== savedSource;

  if (error && !doc) {
    return (
      <>
        <AppBar />
        {uid && <PasswordPromptDialog docUid={uid} />}
        <Container size="2" py="8">
          <Text color="red">{error}</Text> <Link to="/">← Home</Link>
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

  const assetsPx = canEdit ? (assetsOpen ? assetsWidth : ASSETS_COLLAPSED_WIDTH) : 0;
  const gridColumns = canEdit
    ? `${assetsPx}px ${editorWidth}px 1fr`
    : `${editorWidth}px 1fr`;

  return (
    <div className="edit-page">
      <PasswordPromptDialog docUid={doc.uid} />
      <AppBar
        docTitle={`Editing: ${documentTitle(doc)}`}
        role={doc.role}
        docUid={doc.uid}
        passwordProtected={doc.password_protected}
        onLogout={() => window.location.reload()}
        showUserName
      />
      <div className="edit-body" style={{ gridTemplateColumns: gridColumns }}>
        {canEdit && (
          <AssetsPanel
            docUid={doc.uid}
            assets={attached}
            referencedRefs={referencedRefs}
            canEdit={canEdit}
            onReplace={uploadAndAttach}
            onDelete={handleDeleteAsset}
            open={assetsOpen}
            onToggle={() => setAssetsOpen((v) => !v)}
            width={assetsWidth}
            onResize={setAssetsWidth}
          />
        )}
        <div className="edit-source">
          {canEdit && (
            <MarkdownToolbar
              viewRef={viewRef}
              format={doc.format}
              wordWrap={wordWrap}
              onWordWrapToggle={() => setWordWrap((w) => !w)}
            />
          )}
          <div className="edit-source__editor" ref={editorEl} />
          <EditToolbar
            docUid={doc.uid}
            canSave={canSave}
            hasChanges={hasChanges}
            saving={saving}
            displayName={displayName}
            error={error}
            onSave={() => handleSave()}
            onSaveAndClose={() => handleSave({ closeAfter: true })}
            onSaveWithComment={(comment) => handleSave({ commitMessage: comment })}
          />
          <ResizeHandle side="left" width={editorWidth} onResize={setEditorWidth} min={200} max={1800} label="Resize editor panel" />
        </div>
        <div className="edit-preview-pane">
          <div className="edit-preview-chrome">
            <Flex align="center" gap="2">
              <Text size="1" color="gray">Text size</Text>
              <Slider
                size="1"
                style={{ width: 80 }}
                min={80}
                max={140}
                step={1}
                value={[textZoom]}
                onValueChange={(v) => setTextZoom(v[0] ?? textZoom)}
              />
              <Text size="1" color="gray" style={{ minWidth: '3.5ch', flexShrink: 0 }}>
                {textZoom}%
              </Text>
              <Button size="1" variant="ghost" onClick={() => setTextZoom(100)} disabled={textZoom === 100}>
                Reset
              </Button>
            </Flex>
            <Flex align="center" gap="2">
              <Text size="1" color="gray" as="label" htmlFor="edit-theme-select">Theme</Text>
              <Select.Root
                value={theme}
                size="1"
                onValueChange={(next) => {
                  setTheme(next);
                  setUserThemeOverride(doc.uid, next === doc.default_theme ? null : next);
                }}
              >
                <Select.Trigger id="edit-theme-select" variant="soft" />
                <Select.Content position="popper" style={{ maxHeight: 360 }}>
                  {BUILT_IN_THEMES.map((t) => (
                    <Select.Item key={t.id} value={t.id}>{t.label}</Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            </Flex>
          </div>
          <div className="edit-preview" ref={previewEl}>
            {rendered ? (
              <RenderedDoc
                rendered={rendered}
                textZoom={textZoom / 100}
                onMissingAssetUpload={canEdit ? uploadAndAttach : undefined}
              />
            ) : (
              <Text color="gray" size="2" as="p" mx="4" mt="4">
                Preview…
              </Text>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
