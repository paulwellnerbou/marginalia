import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Text, TextField, Dialog, Flex } from '@radix-ui/themes';
import { Cross2Icon } from '@radix-ui/react-icons';

interface EditToolbarProps {
  docUid: string;
  canSave: boolean;
  hasChanges: boolean;
  saving: boolean;
  displayName: string;
  error: string | null;
  onSave: () => void;
  onSaveAndClose: () => void;
  onSaveWithComment: (comment: string) => void;
}

export function EditToolbar({
  docUid,
  canSave,
  hasChanges,
  saving,
  displayName,
  error,
  onSave,
  onSaveAndClose,
  onSaveWithComment,
}: EditToolbarProps) {
  const [commentDialogOpen, setCommentDialogOpen] = useState(false);
  const [comment, setComment] = useState('');

  function handleSaveWithComment() {
    onSaveWithComment(comment);
    setComment('');
    setCommentDialogOpen(false);
  }

  const saveDisabled = !canSave || !hasChanges || saving || !displayName.trim();

  return (
    <div className="edit-toolbar">

      <div className="edit-toolbar__right">
        {error && (
          <Text size="1" color="red">
            {error}
          </Text>
        )}

        <Flex gap="1">
          <Button variant="soft" color="gray" size="2" asChild>
            <Link to={`/d/${docUid}`} aria-label="Close editor">
              <Cross2Icon /> Close Editor
            </Link>
          </Button>

          <Button
            size="2"
            variant="soft"
            disabled={saveDisabled}
            onClick={onSave}
          >
            {saving ? 'Saving…' : 'Save'}
          </Button>

          <Dialog.Root open={commentDialogOpen} onOpenChange={setCommentDialogOpen}>
            <Dialog.Trigger>
              <Button size="2" variant="soft" disabled={saveDisabled}>
                Save with comment
              </Button>
            </Dialog.Trigger>
            <Dialog.Content maxWidth="420px">
              <Dialog.Title>Save with comment</Dialog.Title>
              <Dialog.Description size="2" mb="4" color="gray">
                Add a commit message describing this change.
              </Dialog.Description>
              <TextField.Root
                placeholder="e.g. Fix typo in introduction"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && comment.trim() && !saveDisabled) {
                    e.preventDefault();
                    handleSaveWithComment();
                  }
                }}
                autoFocus
              />
              <Flex gap="3" mt="4" justify="end">
                <Dialog.Close>
                  <Button variant="soft" color="gray">
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button onClick={handleSaveWithComment} disabled={!comment.trim()}>
                  Save
                </Button>
              </Flex>
            </Dialog.Content>
          </Dialog.Root>

          <Button
            size="2"
            disabled={saveDisabled}
            onClick={onSaveAndClose}
            variant={canSave ? 'solid' : 'soft'}
          >
            {saving ? 'Saving…' : canSave ? 'Save and close Editor' : 'Read-only'}
          </Button>
        </Flex>
      </div>
    </div>
  );
}
