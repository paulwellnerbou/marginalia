import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Flex, Text, TextArea, TextField } from '@radix-ui/themes';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { DocumentFormat } from '../lib/api.js';
import { reportError } from '../lib/log.js';
import { mergeBlockRanges } from './mergeBlockRanges.js';
import type { ProposalTarget } from './SelectionToolbar.js';

type EditorDeps = {
  EditorState: typeof import('@codemirror/state').EditorState;
  EditorView: typeof import('codemirror').EditorView;
  basicSetup: typeof import('codemirror').basicSetup;
  markdown: typeof import('@codemirror/lang-markdown').markdown;
};

let editorDepsPromise: Promise<EditorDeps> | null = null;

function loadEditorDeps(): Promise<EditorDeps> {
  if (!editorDepsPromise) {
    editorDepsPromise = Promise.all([
      import('@codemirror/state'),
      import('codemirror'),
      import('@codemirror/lang-markdown'),
    ]).then(([state, view, md]) => ({
      EditorState: state.EditorState,
      EditorView: view.EditorView,
      basicSetup: view.basicSetup,
      markdown: md.markdown,
    }));
  }
  return editorDepsPromise;
}

function MarkdownEditorField({
  id,
  initialValue,
  onChange,
  autoFocus,
  ariaLabelledBy,
}: {
  id: string;
  initialValue: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  ariaLabelledBy?: string;
}) {
  // Render a plain <textarea> first and swap to CodeMirror once the
  // lazy chunks resolve. This keeps the field focusable from the
  // moment the dialog opens (so Radix's autofocus has a real target
  // to land on, even on a cold chunk load) and turns a chunk-load
  // failure into a graceful fallback instead of a dead dialog.
  const [value, setValue] = useState(initialValue);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'failed'>('loading');
  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const depsRef = useRef<EditorDeps | null>(null);
  const transferFocusRef = useRef(false);
  const transferSelectionRef = useRef<{ from: number; to: number } | null>(null);

  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { onChangeRef.current(value); }, [value]);

  useEffect(() => {
    let disposed = false;
    loadEditorDeps().then(
      (deps) => {
        if (disposed) return;
        depsRef.current = deps;
        // Snapshot focus + selection from the textarea *before* React
        // unmounts it, so we can hand them to CodeMirror seamlessly.
        const ta = textareaRef.current;
        if (ta && document.activeElement === ta) {
          transferFocusRef.current = true;
          transferSelectionRef.current = {
            from: ta.selectionStart ?? value.length,
            to: ta.selectionEnd ?? value.length,
          };
        }
        setPhase('ready');
      },
      (err) => {
        reportError('ProposalComposer.editor', err);
        if (!disposed) setPhase('failed');
      },
    );
    return () => { disposed = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (phase !== 'ready') return;
    const container = containerRef.current;
    const deps = depsRef.current;
    if (!container || !deps) return;
    const { EditorState, EditorView, basicSetup, markdown } = deps;
    const extensions: import('@codemirror/state').Extension[] = [
      basicSetup,
      markdown(),
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.docChanged) setValue(u.state.doc.toString());
      }),
      EditorView.theme({
        '&': { fontSize: '0.875rem' },
        '.cm-scroller': {
          fontFamily:
            'var(--md-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
        },
      }),
    ];
    if (ariaLabelledBy) {
      extensions.push(EditorView.contentAttributes.of({ 'aria-labelledby': ariaLabelledBy }));
    }
    const sel = transferSelectionRef.current;
    const state = EditorState.create({
      doc: value,
      extensions,
      selection: sel ? { anchor: sel.from, head: sel.to } : undefined,
    });
    const view = new EditorView({ state, parent: container });
    if (transferFocusRef.current) view.focus();
    return () => { view.destroy(); };
  }, [phase]); // eslint-disable-line react-hooks/exhaustive-deps

  if (phase === 'ready') {
    return (
      <div ref={containerRef} className="proposal-source-editor" data-proposal-source-id={id} />
    );
  }
  // 'loading' or 'failed' — both render a usable textarea so the user
  // can always edit the proposal source. The visible label uses
  // htmlFor={id}, which keeps the association live in this state.
  return (
    <TextArea
      ref={textareaRef}
      id={id}
      className="composer-body-field proposal-source-field"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      rows={8}
      size="1"
      autoFocus={autoFocus}
    />
  );
}

// Proposal dialog composer — used for new edit proposals.
//
// (Comment composer / mention autocomplete previously also lived in
// this file, used by the legacy CommentsPane → ThreadItem chain. After
// the inline-comments migration replaced that chain with the cards in
// inline-comments/, the only remaining caller is DocumentLayout's
// "Propose edit" dialog. The simpler InlineComposer (no mention
// autocomplete) covers comment / reply input.)

interface ProposalComposerProps {
  target: ProposalTarget | null;
  docSource: string;
  docFormat: DocumentFormat;
  blockRanges: Map<string, BlockSourceRange>;
  needsName: boolean;
  onCancel: () => void;
  onSubmit: (payload: {
    proposed_text: string;
    rationale?: string;
    display_name?: string;
  }) => Promise<void> | void;
}

export function ProposalComposer({
  target,
  docSource,
  docFormat,
  blockRanges,
  needsName,
  onCancel,
  onSubmit,
}: ProposalComposerProps) {
  const open = target !== null;
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel();
      }}
    >
      <Dialog.Content size="3" maxWidth="720px">
        {target && (
          <ProposalComposerBody
            target={target}
            docSource={docSource}
            docFormat={docFormat}
            blockRanges={blockRanges}
            needsName={needsName}
            onCancel={onCancel}
            onSubmit={onSubmit}
          />
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}

function ProposalComposerBody({
  target,
  docSource,
  docFormat,
  blockRanges,
  needsName,
  onCancel,
  onSubmit,
}: {
  target: ProposalTarget;
  docSource: string;
  docFormat: DocumentFormat;
  blockRanges: Map<string, BlockSourceRange>;
  needsName: boolean;
  onCancel: () => void;
  onSubmit: ProposalComposerProps['onSubmit'];
}) {
  const originalSource = useMemo(() => {
    const range = mergeBlockRanges(
      blockRanges,
      target.block_id,
      target.end_block_id ?? null,
    );
    return range ? docSource.slice(range.start, range.end) : '';
  }, [docSource, blockRanges, target.block_id, target.end_block_id]);

  const [value, setValue] = useState(originalSource);
  const [rationale, setRationale] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setValue(originalSource);
    setRationale('');
  }, [target.block_id, target.end_block_id, originalSource]);

  const changed = value !== originalSource;
  const ready = changed && (!needsName || name.trim().length > 0);

  async function send() {
    if (!ready) return;
    setSubmitting(true);
    try {
      const payload: Parameters<ProposalComposerProps['onSubmit']>[0] = { proposed_text: value };
      if (rationale.trim()) payload.rationale = rationale.trim();
      if (needsName) payload.display_name = name.trim();
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  }

  const formatLabel = docFormat === 'asciidoc' ? 'AsciiDoc' : 'Markdown';
  const blockNoun = target.block_count > 1 ? `${target.block_count} blocks` : 'this block';

  return (
    <>
      <Dialog.Title>Propose edit</Dialog.Title>
      <Dialog.Description size="2" color="gray" mb="3">
        Edit the {formatLabel} source of {blockNoun}. Editors will review the diff before accepting.
      </Dialog.Description>

      <Flex direction="column" gap="3" className="edit-proposal-composer composer">
        <div className="composer-quote">
          "{target.block_text.slice(0, 240)}
          {target.block_text.length > 240 ? '…' : ''}"
        </div>

        {needsName && (
          <Flex direction="column" gap="1">
            <Text as="label" size="2" htmlFor="proposal-name">
              Your display name
            </Text>
            <TextField.Root
              id="proposal-name"
              className="composer-name-field"
              size="1"
              placeholder="Your display name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              autoFocus
            />
          </Flex>
        )}

        <Flex direction="column" gap="1">
          <Text
            as="label"
            size="2"
            htmlFor="proposal-text"
            id="proposal-text-label"
            onClick={(e) => {
              // htmlFor focuses the textarea in fallback mode. In
              // CodeMirror mode the field is a div, so re-route the
              // click to the contenteditable so the visible label
              // still acts as a focus affordance.
              const cm = document
                .querySelector('[data-proposal-source-id="proposal-text"] .cm-content');
              if (cm instanceof HTMLElement) {
                e.preventDefault();
                cm.focus();
              }
            }}
          >
            Edited {formatLabel}
          </Text>
          <MarkdownEditorField
            key={`${target.block_id}-${target.end_block_id ?? ''}`}
            id="proposal-text"
            initialValue={originalSource}
            onChange={setValue}
            autoFocus={!needsName}
            ariaLabelledBy="proposal-text-label"
          />
        </Flex>

        <Flex direction="column" gap="1">
          <Text as="label" size="2" htmlFor="proposal-rationale">
            Reason (optional)
          </Text>
          <TextArea
            id="proposal-rationale"
            className="composer-body-field"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Why should this change be made?"
            rows={3}
            size="1"
          />
        </Flex>
      </Flex>

      <Flex gap="2" justify="end" mt="4">
        <Button variant="soft" color="gray" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={send} disabled={!ready || submitting}>
          {submitting ? 'Submitting…' : 'Submit proposal'}
        </Button>
      </Flex>
    </>
  );
}
