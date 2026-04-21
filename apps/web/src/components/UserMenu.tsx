import { useState } from 'react';
import {
  Badge,
  Button,
  Box,
  Code,
  Dialog,
  DropdownMenu,
  Flex,
  IconButton,
  Text,
  TextField,
} from '@radix-ui/themes';
import { PersonIcon } from '@radix-ui/react-icons';
import type { Role } from '../lib/api.js';
import { getClientId, setDisplayName as persistName, useDisplayName } from '../lib/identity.js';
import { Copyable } from './Copyable.js';

/**
 * App-bar user affordance: stable client ID (copyable), role badge when
 * doc-scoped, rename dialog. Renaming writes localStorage → useDisplayName
 * → next request → server fans the rename out to comments/mentions.
 */
export function UserMenu({
  onChange,
  role,
  showName = false,
}: {
  onChange?: (name: string) => void;
  role?: Role | undefined;
  showName?: boolean;
}) {
  // Reactive: stays in sync when any other part of the app (or another tab)
  // writes a new display name.
  const name = useDisplayName();
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
    persistName(trimmed); // fires the DISPLAY_NAME_EVENT → useDisplayName updates
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
          {showName ? (
            <Button
              variant="soft"
              size="2"
              aria-label={`User menu for ${name}`}
              className="user-menu-trigger user-menu-trigger--with-name"
            >
              <PersonIcon />
              <span className="user-menu-trigger-label">{name}</span>
            </Button>
          ) : (
            <IconButton
              variant="soft"
              size="2"
              aria-label={`User menu for ${name}`}
              className="user-menu-trigger"
            >
              <PersonIcon />
            </IconButton>
          )}
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end" style={{ minWidth: 320 }}>
          <Flex px="3" pt="3" pb="2" direction="column" gap="1">
            <Text size="1" color="gray">Identified as</Text>
            <Flex align="center" justify="between" gap="3">
              <Box style={{ minWidth: 0, flex: 1 }}>
                <Text size="4" weight="bold" style={{ color: 'var(--gray-12)' }} truncate>
                  {name}
                </Text>
              </Box>
              <Button size="1" variant="soft" onClick={openDialog}>
                Change
              </Button>
            </Flex>
          </Flex>
          {role && (
            <Flex px="3" pb="2" direction="column" gap="1">
              <Text size="1" color="gray">Role</Text>
              <Badge
                size="1"
                color={roleColor(role)}
                variant="soft"
                className="role-badge"
                style={{ width: 'fit-content' }}
              >
                {role}
              </Badge>
            </Flex>
          )}
          <Flex px="3" pb="2" direction="column" gap="1">
            <Text size="1" color="gray">User ID</Text>
            <Copyable text={clientId} ariaLabel="Copy user ID" size="1" />
          </Flex>
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
        <Dialog.Content size="2" maxWidth="520px">
          <Dialog.Title>Display name</Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="3">
            Shown on your edits and comments. Your persistent user ID (
            <Code size="1">{shortId}…</Code>) stays the same, so your right to edit or delete
            your own comments is preserved.
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

function roleColor(role: Role): 'indigo' | 'green' | 'amber' | 'gray' {
  switch (role) {
    case 'admin':
      return 'indigo';
    case 'editor':
      return 'green';
    case 'collaborator':
      return 'amber';
    default:
      return 'gray';
  }
}
