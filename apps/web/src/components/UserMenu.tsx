import { useState } from 'react';
import {
  ActionIcon as IconButton,
  Badge,
  Button,
  Box,
  Code,
  Flex,
  Menu,
  Modal,
  Text,
  TextInput,
} from '@mantine/core';
import { PersonIcon } from '../icons.js';
import type { Role } from '../lib/api.js';
import { getClientId, setDisplayName as persistName, useDisplayName } from '../lib/identity.js';
import { appRoleColor } from '../styles/theme.js';
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
      <Menu position="bottom-end">
        <Menu.Target>
          {showName ? (
            <Button
              variant="light"
              size="sm"
              aria-label={`User menu for ${name}`}
              className="user-menu-trigger user-menu-trigger--with-name"
            >
              <PersonIcon />
              <span className="user-menu-trigger-label">{name}</span>
            </Button>
          ) : (
            <IconButton
              variant="light"
              size="sm"
              aria-label={`User menu for ${name}`}
              className="user-menu-trigger"
            >
              <PersonIcon />
            </IconButton>
          )}
        </Menu.Target>
        <Menu.Dropdown className="user-menu-dropdown" style={{ minWidth: 320 }}>
          <Flex px="3" pt="3" pb="2" direction="column" gap="1" className="user-menu-section">
            <Text size="xs" c="dimmed" className="user-menu-kicker">Identified as</Text>
            <Box className="user-menu-main-row">
              <Box className="user-menu-main-copy">
                <Text size="lg" fw={700} style={{ color: 'var(--gray-12)' }} truncate className="user-menu-name">
                  {name}
                </Text>
              </Box>
              <Button size="xs" variant="light" onClick={openDialog} className="user-menu-action">
                Change
              </Button>
            </Box>
          </Flex>
          {role && (
            <Flex px="3" pb="2" direction="column" gap="1" className="user-menu-section">
              <Text size="xs" c="dimmed" className="user-menu-kicker">Role</Text>
              <Badge
                size="xs"
                color={appRoleColor(role)}
                variant="light"
                className="role-badge"
                style={{ width: 'fit-content' }}
              >
                {role}
              </Badge>
            </Flex>
          )}
          <Flex px="3" pb="2" direction="column" gap="1" className="user-menu-section">
            <Text size="xs" c="dimmed" className="user-menu-kicker">User ID</Text>
            <Box className="user-menu-copyable">
              <Copyable text={clientId} ariaLabel="Copy user ID" size="1" />
            </Box>
          </Flex>
        </Menu.Dropdown>
      </Menu>

      <Modal
        opened={dialogOpen}
        onClose={() => setDialogOpen(false)}
        size="520px"
        title={<Text fw={600} size="lg">Display name</Text>}
      >
          <Text size="sm" c="dimmed" mb="3">
            Shown on your edits and comments. Your persistent user ID (
            <Code fz="xs">{shortId}…</Code>) stays the same, so your right to edit or delete
            your own comments is preserved.
          </Text>
          <Flex direction="column" gap="3">
            <TextInput
              value={draft}
              onChange={(e: any) => setDraft(e.target.value)}
              placeholder="e.g. Alex Cho"
              maxLength={80}
              autoFocus
              onKeyDown={(e: any) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  save(draft);
                }
              }}
            />
            <Flex gap="2" justify="end">
              <Button variant="light" color="gray" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={() => save(draft)} disabled={!draft.trim()}>
                Save
              </Button>
            </Flex>
          </Flex>
      </Modal>
    </>
  );
}
