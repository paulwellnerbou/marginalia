import { Button, Dialog, Flex, Text } from '@radix-ui/themes';
import { diffLines } from '../lib/line-diff.js';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title?: string;
  before: string;
  after: string;
  /** Rendered in the dialog footer. E.g. Accept/Reject buttons. */
  actions?: React.ReactNode;
}

export function DiffDialog({ open, onOpenChange, title, before, after, actions }: Props) {
  const lines = diffLines(before, after);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="3" maxWidth="900px">
        <Dialog.Title>{title ?? 'Proposed change'}</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          Original on the left of each line (−), proposed on the right (+). Unchanged lines are
          shown for context.
        </Dialog.Description>

        <div className="diff-view" role="region" aria-label="Diff">
          {lines.length === 0 ? (
            <Text size="1" color="gray">(empty)</Text>
          ) : (
            lines.map((l, idx) => (
              <div key={idx} className={`diff-line diff-${l.op}`}>
                <span className="diff-marker">
                  {l.op === 'add' ? '+' : l.op === 'remove' ? '−' : ' '}
                </span>
                <span className="diff-text">{l.text || '\u00a0'}</span>
              </div>
            ))
          )}
        </div>

        <Flex gap="2" justify="end" mt="4" align="center">
          {actions}
          <Dialog.Close>
            <Button variant="soft" color="gray">Close</Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
