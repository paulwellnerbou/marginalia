import { useState } from 'react';
import {
  Button,
  Code,
  Dialog,
  DropdownMenu,
  Flex,
  IconButton,
  Text,
  TextField,
} from '@radix-ui/themes';
import { PersonIcon } from '@radix-ui/react-icons';
import { getClientId, getDisplayName, setDisplayName as persistName } from '../lib/identity.js';

/**
 * User affordance in the app bar. Always shows a person icon — never an
 * initial. When no display name is set, the button switches to the accent
 * solid variant to prompt the user. Clicking opens a small menu whose
 * single visible action opens a rename dialog (no native prompts).
 */
export function UserMenu({ onChange }: { onChange?: (name: string) => void }) {
  const [name, setName] = useState<string | null>(() => getDisplayName());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState('');
  // The clientId is this browser's permanent identity. It's what the server
  // stores on comments (as `author_client_id`) and what gates edit/delete of
  // your own comments. Never changes; surfaced here so users can see they
  // have a stable identity.
  const clientId = getClientId();
  const shortId = clientId.slice(0, 10);

  function save(next: string) {
    const trimmed = next.trim().slice(0, 80);
    if (!trimmed) return;
    persistName(trimmed);
    setName(trimmed);
    setDraft(trimmed);
    onChange?.(trimmed);
    setDialogOpen(false);
  }

  function openDialog() {
    setDraft(name ?? '');
    setDialogOpen(true);
  }

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger>
          {name ? (
            <IconButton
              variant="soft"
              size="2"
              aria-label={`User menu for ${name}`}
            >
              <PersonIcon />
            </IconButton>
          ) : (
            <IconButton
              variant="soft"
              color="indigo"
              size="2"
              className="user-menu-unset"
              aria-label="Set your display name"
            >
              <PersonIcon />
            </IconButton>
          )}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          {name ? (
            <DropdownMenu.Label>Signed in as {name}</DropdownMenu.Label>
          ) : (
            <DropdownMenu.Label>No display name set</DropdownMenu.Label>
          )}
          <Flex px="3" pb="2" direction="column" gap="0">
            <Text size="1" color="gray">Your persistent user ID</Text>
            <Code size="1" variant="ghost" title={clientId}>{shortId}…</Code>
          </Flex>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={openDialog}>
            {name ? 'Change display name…' : 'Set display name…'}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Content size="2" maxWidth="420px">
          <Dialog.Title>Display name</Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="3">
            Shown on your edits and comments. Changing it relabels existing content — your
            persistent user ID (<Code size="1">{shortId}…</Code>) stays the same, so your
            right to edit/delete your own comments is preserved.
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <TextField.Root
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="e.g. Alex Cho"
              maxLength={80}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  save(draft);
                }
              }}
            />
            <Flex gap="2" justify="end">
              <Dialog.Close>
                <Button variant="soft" color="gray">Cancel</Button>
              </Dialog.Close>
              <Button onClick={() => save(draft)} disabled={!draft.trim()}>
                Save
              </Button>
            </Flex>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
