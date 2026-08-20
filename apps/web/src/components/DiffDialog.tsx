import { Button, Dialog, Flex, Text } from '@radix-ui/themes';
import { DialogLoading } from './DialogLoading.js';
import { DiffView } from './DiffView.js';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title?: string;
  before: string;
  after: string;
  /** Number of unchanged lines to show around each changed hunk. `null` shows the full diff. */
  contextLines?: number | null;
  /** Document line the excerpt starts at; see DiffView. */
  startLine?: number;
  /** Rendered in the dialog footer. E.g. Accept/Reject buttons. */
  actions?: React.ReactNode;
  /** Optional reply composer for diffs that originate from a comment thread. */
  replyComposer?: React.ReactNode;
  /** True while the caller is (re)fetching `before`/`after`. */
  loading?: boolean;
  /** Fetch failure to show in place of the diff. */
  error?: string | null;
  /**
   * Why the last footer action failed. Shown beside the buttons rather
   * than in place of the diff — the dialog stays open on a failed
   * accept, so the reason has to be readable next to what was clicked.
   */
  actionError?: string | null;
}

export function DiffDialog({
  open,
  onOpenChange,
  title,
  before,
  after,
  contextLines = null,
  startLine = 1,
  actions,
  replyComposer,
  loading = false,
  error = null,
  actionError = null,
}: Props) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        size="3"
        maxWidth="900px"
        className="dialog-content--fixed-footer diff-dialog"
      >
        <div className="dialog-scroll-body diff-dialog-body">
          <Dialog.Title>{title ?? 'Proposed change'}</Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="3">
            Original on the left of each line (−), proposed on the right (+). Unchanged lines are
            shown for context.
          </Dialog.Description>

          {error ? (
            <Text color="red" size="2" as="p">
              {error}
            </Text>
          ) : loading ? (
            <DialogLoading>Loading diff…</DialogLoading>
          ) : (
            <DiffView
              before={before}
              after={after}
              contextLines={contextLines}
              startLine={startLine}
              active={open}
            />
          )}

          {replyComposer && (
            <section className="diff-dialog-reply" aria-label="Reply to thread">
              {replyComposer}
            </section>
          )}
        </div>

        <Flex className="dialog-footer" gap="2" justify="end" mt="4" align="center" wrap="wrap">
          {/* Announced by the accompanying error toast, not here — two
              assertive regions would read the same failure out twice. */}
          {actionError && (
            <Text color="red" size="1" style={{ marginRight: 'auto' }}>
              {actionError}
            </Text>
          )}
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
