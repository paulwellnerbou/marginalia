import { Button, Dialog, Flex, Text, TextField } from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import {
  isNamePending,
  NAME_REQUIRED_EVENT,
  notifyNameCancelled,
  notifyNameResolved,
} from '../lib/api.js';
import { getDisplayName, getDisplayNameSetAt, setDisplayName } from '../lib/identity.js';
import { OPEN_NAME_DIALOG_EVENT as OPEN_EVENT } from '../lib/identity-notice.js';
import { pushDisplayName as pushKeyringDisplayName } from '../lib/keyring.js';

/**
 * Asks a visitor on a group link for the name others will see.
 *
 * Opened two ways: by api.ts when a write came back `display-name-required`, which
 * then waits on it and resends the write (cancel rejects that write), or
 * from the notice on arrival, where skipping costs nothing. Mount once per
 * document view.
 */
export function NamePromptDialog({ docUid }: { docUid: string }) {
  const [open, setOpen] = useState(false);
  const [required, setRequired] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    function show(isRequired: boolean) {
      // A placeholder is offered as nothing: the point is to replace it.
      setDraft(getDisplayNameSetAt() === null ? '' : getDisplayName());
      setRequired(isRequired);
      setOpen(true);
    }
    function onRequired(e: Event) {
      if ((e as CustomEvent<{ docUid: string }>).detail?.docUid === docUid) show(true);
    }
    function onOpen(e: Event) {
      if ((e as CustomEvent<{ docUid: string }>).detail?.docUid === docUid) show(false);
    }
    window.addEventListener(NAME_REQUIRED_EVENT, onRequired);
    window.addEventListener(OPEN_EVENT, onOpen);
    // NAME_REQUIRED is dispatched synchronously; pick up a gate that armed
    // before this mounted.
    if (isNamePending(docUid)) show(true);
    return () => {
      window.removeEventListener(NAME_REQUIRED_EVENT, onRequired);
      window.removeEventListener(OPEN_EVENT, onOpen);
      notifyNameCancelled(docUid);
    };
  }, [docUid]);

  const name = draft.trim().slice(0, 80);
  const isPlaceholder = getDisplayNameSetAt() === null && name === getDisplayName();
  const canSave = name.length > 0 && !isPlaceholder;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setDisplayName(name);
    // Typed by the person, like a rename in the user menu, so it is theirs
    // on every device.
    pushKeyringDisplayName(name);
    setOpen(false);
    notifyNameResolved(docUid);
  }

  function handleOpenChange(next: boolean) {
    if (!next && open) notifyNameCancelled(docUid);
    setOpen(next);
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content maxWidth="420px">
        <form onSubmit={handleSubmit}>
          <Dialog.Title>How do you want to be identified?</Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="4">
            {required
              ? 'Others see this name with your comments and suggestions. Give one to continue.'
              : 'Others see this name with your comments and suggestions.'}
          </Dialog.Description>
          <Flex direction="column" gap="2">
            <TextField.Root
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Your name"
              aria-label="Your name"
              autoFocus
              autoComplete="name"
              maxLength={80}
            />
            {isPlaceholder && (
              <Text size="1" color="gray">
                That is the name made up for you. Enter your own.
              </Text>
            )}
          </Flex>
          <Flex gap="2" justify="end" mt="4">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray">
                {required ? 'Cancel' : 'Not now'}
              </Button>
            </Dialog.Close>
            <Button type="submit" disabled={!canSave}>
              {required ? 'Continue' : 'Save'}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
