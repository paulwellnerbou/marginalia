import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Text, TextArea, Dialog, Flex } from '@radix-ui/themes';
import { Cross2Icon } from '@radix-ui/react-icons';

interface EditToolbarProps {
  docUid: string;
  canSave: boolean;
  canPropose: boolean;
  hasChanges: boolean;
  saving: boolean;
  displayName: string;
  error: string | null;
  onSave: (comment: string) => void;
  onProposeEdit: (rationale: string) => void;
}

export function EditToolbar({
  docUid,
  canSave,
  canPropose,
  hasChanges,
  saving,
  displayName,
  error,
  onSave,
  onProposeEdit,
}: EditToolbarProps) {
  const [open, setOpen] = useState(false);
  const [comment, setComment] = useState('');

  const disabled = !hasChanges || saving || !displayName.trim() || (!canSave && !canPropose);

  function handleSave() {
    onSave(comment);
    setComment('');
    setOpen(false);
  }

  function handlePropose() {
    onProposeEdit(comment);
    setComment('');
    setOpen(false);
  }

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

          <Dialog.Root open={open} onOpenChange={setOpen}>
            <Dialog.Trigger>
              <Button size="2" variant={canSave ? 'solid' : 'soft'} disabled={disabled}>
                {saving ? 'Saving…' : canSave ? 'Save…' : canPropose ? 'Propose edit…' : 'Read-only'}
              </Button>
            </Dialog.Trigger>
            <Dialog.Content maxWidth="460px">
              <Dialog.Title>
                {canSave && canPropose
                  ? 'Save or propose change'
                  : canSave
                    ? 'Save change'
                    : 'Propose change'}
              </Dialog.Title>
              <Dialog.Description size="2" mb="3" color="gray">
                {canSave && canPropose
                  ? 'Add an optional commit message, then save directly or propose the edit for review.'
                  : canSave
                    ? 'Add an optional commit message describing this change.'
                    : 'Add a rationale describing why this change should be made.'}
              </Dialog.Description>
              <TextArea
                placeholder={canSave ? 'e.g. Fix typo in introduction (optional)' : 'Why this change?'}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={3}
                autoFocus
              />
              <Flex gap="3" mt="4" justify="end" wrap="wrap">
                <Dialog.Close>
                  <Button variant="soft" color="gray">
                    Cancel
                  </Button>
                </Dialog.Close>
                {canPropose && (
                  <Button
                    variant={canSave ? 'soft' : 'solid'}
                    onClick={handlePropose}
                    disabled={saving}
                  >
                    Propose edit
                  </Button>
                )}
                {canSave && (
                  <Button onClick={handleSave} disabled={saving}>
                    Save
                  </Button>
                )}
              </Flex>
            </Dialog.Content>
          </Dialog.Root>
        </Flex>
      </div>
    </div>
  );
}
