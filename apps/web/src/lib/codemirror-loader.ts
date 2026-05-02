import type { Extension } from '@codemirror/state';
import type { DocumentFormat } from './api.js';

export type EditorBaseDeps = {
  EditorState: typeof import('@codemirror/state').EditorState;
  Compartment: typeof import('@codemirror/state').Compartment;
  Transaction: typeof import('@codemirror/state').Transaction;
  EditorView: typeof import('codemirror').EditorView;
  basicSetup: typeof import('codemirror').basicSetup;
  lineWrapping: Extension;
};

export type MarkdownFn = typeof import('@codemirror/lang-markdown').markdown;

export type EditorDeps = EditorBaseDeps & { markdown?: MarkdownFn };

let baseDepsPromise: Promise<EditorBaseDeps> | null = null;
let markdownDepPromise: Promise<MarkdownFn> | null = null;

// Both caches drop themselves on rejection so a transient chunk-load
// error doesn't pin every later attempt to load the editor on the
// failed promise for the rest of the session.

export function loadEditorBase(): Promise<EditorBaseDeps> {
  if (!baseDepsPromise) {
    const p = Promise.all([import('@codemirror/state'), import('codemirror')]).then(
      ([state, view]) => ({
        EditorState: state.EditorState,
        Compartment: state.Compartment,
        Transaction: state.Transaction,
        EditorView: view.EditorView,
        basicSetup: view.basicSetup,
        lineWrapping: view.EditorView.lineWrapping,
      }),
    );
    baseDepsPromise = p;
    p.catch(() => {
      if (baseDepsPromise === p) baseDepsPromise = null;
    });
  }
  return baseDepsPromise;
}

export function loadMarkdownExt(): Promise<MarkdownFn> {
  if (!markdownDepPromise) {
    const p = import('@codemirror/lang-markdown').then((m) => m.markdown);
    markdownDepPromise = p;
    p.catch(() => {
      if (markdownDepPromise === p) markdownDepPromise = null;
    });
  }
  return markdownDepPromise;
}

// Compose what callers need based on document format. Markdown
// documents pull in the grammar chunk; AsciiDoc gets a plain editor
// (no asciidoc grammar bundled).
export async function loadEditorDeps(format: DocumentFormat): Promise<EditorDeps> {
  if (format === 'markdown') {
    const [base, markdown] = await Promise.all([loadEditorBase(), loadMarkdownExt()]);
    return { ...base, markdown };
  }
  return loadEditorBase();
}
