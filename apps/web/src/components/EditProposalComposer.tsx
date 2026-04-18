import { useMemo, useState } from 'react';
import { Button, Flex, Text, TextArea, TextField } from '@radix-ui/themes';
import type { BlockSourceRange } from '@marginalia/renderer';
import type { ProposalTarget } from './SelectionToolbar.js';

interface Props {
  target: ProposalTarget;
  /** Full markdown source — used to extract the block's current source text. */
  docSource: string;
  blockRanges: Map<string, BlockSourceRange>;
  needsName: boolean;
  onCancel: () => void;
  onSubmit: (payload: {
    proposed_text: string;
    rationale?: string;
    display_name?: string;
  }) => Promise<void> | void;
}

export function EditProposalComposer({
  target, docSource, blockRanges, needsName, onCancel, onSubmit,
}: Props) {
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

  return (
    <div className="edit-proposal-composer">
      <Text size="1" color="gray" weight="medium">Propose edit</Text>
      <div className="quote">“{target.block_text.slice(0, 140)}{target.block_text.length > 140 ? '…' : ''}”</div>

      <Flex direction="column" gap="2" mt="2" className="composer">
        {needsName && (
          <TextField.Root
            size="1"
            placeholder="Your display name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
        )}
        <Text size="1" color="gray" as="label" htmlFor="proposal-text">
          Edited markdown
        </Text>
        <TextArea
          id="proposal-text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={6}
          size="1"
          autoFocus
        />
        <Text size="1" color="gray" as="label" htmlFor="proposal-rationale">
          Reason (optional)
        </Text>
        <TextArea
          id="proposal-rationale"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why should this change be made?"
          rows={2}
          size="1"
        />
        <Flex gap="2" align="center" justify="end">
          <Button variant="ghost" size="1" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button size="1" onClick={send} disabled={!ready || submitting}>
            {submitting ? 'Submitting…' : 'Submit proposal'}
          </Button>
        </Flex>
      </Flex>
    </div>
  );
}
