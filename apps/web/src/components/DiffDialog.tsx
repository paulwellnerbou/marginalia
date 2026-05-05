import { Button, Dialog, Flex } from '@radix-ui/themes';
import { DiffView } from './DiffView.js';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title?: string;
  before: string;
  after: string;
  /** Number of unchanged lines to show around each changed hunk. `null` shows the full diff. */
  contextLines?: number | null;
  /** Rendered in the dialog footer. E.g. Accept/Reject buttons. */
  actions?: React.ReactNode;
}

export function DiffDialog({
  open,
  onOpenChange,
  title,
  before,
  after,
  contextLines = null,
  actions,
}: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="3" maxWidth="900px">
        <Dialog.Title>{title ?? 'Proposed change'}</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          Original on the left of each line (−), proposed on the right (+). Unchanged lines are
          shown for context.
        </Dialog.Description>

        <DiffView before={before} after={after} contextLines={contextLines} active={open} />

        <Flex gap="2" justify="end" mt="4" align="center">
          {actions}
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Close
            </Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
