import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, Flex, Text, TextArea, TextField } from '@radix-ui/themes';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { DocumentFormat } from '../lib/api.js';
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
  initialValue,
  onChange,
  autoFocus,
}: {
  initialValue: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let view: import('codemirror').EditorView | null = null;
    let disposed = false;

    void loadEditorDeps().then(({ EditorState, EditorView, basicSetup, markdown }) => {
      if (disposed || !container) return;
      const state = EditorState.create({
        doc: initialValue,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
          EditorView.theme({
            '&': { fontSize: '0.875rem' },
            '.cm-scroller': {
              fontFamily:
                'var(--md-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
            },
          }),
        ],
      });
      view = new EditorView({ state, parent: container });
      if (autoFocus) view.focus();
    });

    return () => {
      disposed = true;
      view?.destroy();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={containerRef} className="proposal-source-editor" />;
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
          <Text as="label" size="2">
            Edited {formatLabel}
          </Text>
          <MarkdownEditorField
            key={`${target.block_id}-${target.end_block_id ?? ''}`}
            initialValue={originalSource}
            onChange={setValue}
            autoFocus={!needsName}
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
