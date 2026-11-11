import { Button, Dialog, Flex, TextField } from '@radix-ui/themes';
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
  // The made-up name this browser is showing, offered to keep as is.
  const [placeholder, setPlaceholder] = useState<string | null>(null);

  useEffect(() => {
    function show(isRequired: boolean) {
      // The field starts empty over a placeholder, which is offered as a
      // button instead: a real name is what is asked for, keeping the
      // made-up one a deliberate second choice.
      const undated = getDisplayNameSetAt() === null;
      setPlaceholder(undated ? getDisplayName() : null);
      setDraft(undated ? '' : getDisplayName());
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

  function choose(chosen: string) {
    // Dated even when unchanged: keeping the placeholder is a choice too,
    // and only a dated name lifts it on the server.
    setDisplayName(chosen, { setAt: Date.now() });
    // Chosen by the person, like a rename in the user menu, so it is theirs
    // on every device.
    pushKeyringDisplayName(chosen);
    setOpen(false);
    notifyNameResolved(docUid);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (name) choose(name);
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
          </Flex>
          <Flex gap="2" justify="between" align="center" wrap="wrap" mt="4">
            {placeholder ? (
              <Button type="button" variant="ghost" onClick={() => choose(placeholder)}>
                Keep “{placeholder}”
              </Button>
            ) : (
              <span />
            )}
            <Flex gap="2">
              <Dialog.Close>
                <Button type="button" variant="soft" color="gray">
                  {required ? 'Cancel' : 'Not now'}
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={!name}>
                {required ? 'Continue' : 'Save'}
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
