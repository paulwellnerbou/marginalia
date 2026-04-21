import { useMemo, useState } from 'react';
import { Button, Dialog, Flex, Text, TextArea, TextField } from '@radix-ui/themes';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { DocumentFormat } from '../lib/api.js';
import type { ProposalTarget } from './SelectionToolbar.js';

interface Props {
  /** When non-null, the modal is open and targets this block. */
  target: ProposalTarget | null;
  /** Full document source — used to extract the block's current source text. */
  docSource: string;
  /** Source flavour, so the composer's labels match (Markdown vs AsciiDoc). */
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

/**
 * Dialog-based composer for a new edit proposal. Sizing matches the rest of
 * the app (Radix size="2", same token set the CommentsPane composer uses)
 * so the form doesn't feel like a second-class UI.
 */
export function EditProposalComposer({
  target, docSource, docFormat, blockRanges, needsName, onCancel, onSubmit,
}: Props) {
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
          <ComposerBody
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

function ComposerBody({
  target, docSource, docFormat, blockRanges, needsName, onCancel, onSubmit,
}: {
  target: ProposalTarget;
  docSource: string;
  docFormat: DocumentFormat;
  blockRanges: Map<string, BlockSourceRange>;
  needsName: boolean;
  onCancel: () => void;
  onSubmit: Props['onSubmit'];
}) {
  const originalSource = useMemo(() => {
    const range = blockRanges.get(target.block_id);
    return range ? docSource.slice(range.start, range.end) : '';
  }, [docSource, blockRanges, target.block_id]);

  const [value, setValue] = useState(originalSource);
  const [rationale, setRationale] = useState('');
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const changed = value !== originalSource && value.trim().length > 0;
  const ready = changed && (!needsName || name.trim().length > 0);

  async function send() {
    if (!ready) return;
    setSubmitting(true);
    try {
      const payload: Parameters<Props['onSubmit']>[0] = { proposed_text: value };
      if (rationale.trim()) payload.rationale = rationale.trim();
      if (needsName) payload.display_name = name.trim();
      await onSubmit(payload);
    } finally {
      setSubmitting(false);
    }
  }

  const formatLabel = docFormat === 'asciidoc' ? 'AsciiDoc' : 'Markdown';

  return (
    <>
      <Dialog.Title>Propose edit</Dialog.Title>
      <Dialog.Description size="2" color="gray" mb="3">
        Edit the {formatLabel} source of this block. Editors will review the diff
        before accepting.
      </Dialog.Description>

      <Flex direction="column" gap="3" className="edit-proposal-composer composer">
        <div className="composer-quote">
          “{target.block_text.slice(0, 240)}
          {target.block_text.length > 240 ? '…' : ''}”
        </div>

        {needsName && (
          <Flex direction="column" gap="1">
            <Text as="label" size="2" htmlFor="proposal-name">Your display name</Text>
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
          <Text as="label" size="2" htmlFor="proposal-text">Edited {formatLabel}</Text>
          <TextArea
            id="proposal-text"
            className="composer-body-field proposal-source-field"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={8}
            size="1"
            autoFocus={!needsName}
          />
        </Flex>

        <Flex direction="column" gap="1">
          <Text as="label" size="2" htmlFor="proposal-rationale">Reason (optional)</Text>
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
