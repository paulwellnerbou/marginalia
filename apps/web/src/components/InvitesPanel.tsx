import { useEffect, useState } from 'react';
import {
  Badge,
  Box,
  Button,
  Callout,
  Code,
  Flex,
  IconButton,
  Select,
  Separator,
  Text,
  TextField,
  Tooltip,
} from '@radix-ui/themes';
import { TrashIcon } from '@radix-ui/react-icons';
import { Copyable } from './Copyable.js';
import {
  createInvite,
  deleteInvite,
  listInvites,
  type Invite,
  type Role,
} from '../lib/api.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { showToast } from '../lib/notifications.js';

function roleColor(role: Role): 'indigo' | 'green' | 'amber' | 'gray' {
  switch (role) {
    case 'admin':
      return 'indigo';
    case 'editor':
      return 'green';
    case 'collaborator':
    case 'commentor':
      return 'amber';
    default:
      return 'gray';
  }
}

export function InvitesPanel({ uid }: { uid: string }) {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('reader');
  const [submitting, setSubmitting] = useState(false);

  async function refresh() {
    try {
      const r = await listInvites(uid);
      setInvites(r.invites);
    } catch (err) {
      reportError('InvitesPanel.list', err, { uid });
      setError('Could not load invites');
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  async function addInvite() {
    setError(null);
    const trimmed = name.trim();
    if (!trimmed) return;
    const identityName = getDisplayName();
    if (!identityName) {
      setError('Please set your display name first.');
      return;
    }
    const identity = { clientId: getClientId(), displayName: identityName };
    setSubmitting(true);
    try {
      await createInvite(uid, { display_name: trimmed, role }, identity);
      setName('');
      setRole('reader');
      await refresh();
    } catch (err) {
      reportError('InvitesPanel.create', err);
      setError(err instanceof Error ? err.message : 'Could not create invite');
    } finally {
      setSubmitting(false);
    }
  }

  async function remove(token: string) {
    const identityName = getDisplayName();
    if (!identityName) return;
    const identity = { clientId: getClientId(), displayName: identityName };
    try {
      await deleteInvite(uid, token, identity);
      await refresh();
    } catch (err) {
      reportError('InvitesPanel.delete', err);
      setError(err instanceof Error ? err.message : 'Could not revoke invite');
    }
  }


  return (
    <Flex direction="column" gap="3">
      <Text size="2" weight="medium">Invites</Text>
      <Text size="1" color="gray">
        Each invite is a shareable URL that auto-identifies the recipient by name and role. The
        author's admin invite is the canonical way back into the document.
      </Text>

      <Flex gap="2" align="end" wrap="wrap" className="invite-create-form">
        <Box style={{ flex: 1, minWidth: 160 }}>
          <Text as="label" size="1" color="gray" mb="1" htmlFor="invite-name">
            Recipient name
          </Text>
          <TextField.Root
            id="invite-name"
            size="2"
            placeholder="e.g. Alice"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
        </Box>
        <Box>
          <Text as="div" size="1" color="gray" mb="1">Role</Text>
          <Select.Root value={role} onValueChange={(v) => setRole(v as Role)} size="2">
            <Select.Trigger variant="soft" />
            <Select.Content position="popper">
              <Select.Item value="reader">Reader (view only)</Select.Item>
              <Select.Item value="commentor">Commentor (view + comment)</Select.Item>
              <Select.Item value="collaborator">
                Collaborator (comment + propose edits)
              </Select.Item>
              <Select.Item value="editor">Editor (can edit directly)</Select.Item>
              <Select.Item value="admin">Admin (full control)</Select.Item>
            </Select.Content>
          </Select.Root>
        </Box>
        <Button size="2" disabled={!name.trim() || submitting} onClick={addInvite}>
          Create invite
        </Button>
      </Flex>

      {error && (
        <Callout.Root color="red" size="1">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      <Separator size="4" />

      {!invites ? (
        <Text size="1" color="gray">Loading…</Text>
      ) : invites.length === 0 ? (
        <Text size="1" color="gray">No invites yet.</Text>
      ) : (
        <Flex direction="column" gap="2">
          {invites.map((inv) => (
            <Flex
              key={inv.token}
              align="center"
              gap="2"
              p="2"
              style={{
                border: '1px solid var(--ui-border)',
                borderRadius: 'var(--radius-2)',
              }}
            >
              <Box style={{ flex: 1, minWidth: 0 }}>
                <Flex align="baseline" gap="2">
                  <Text size="2" weight="medium">{inv.display_name}</Text>
                  <Badge size="1" color={roleColor(inv.role)} variant="soft" className="role-badge">
                    {inv.role}
                  </Badge>
                </Flex>
                <Box mt="2">
                  <Copyable text={window.location.origin + inv.url} multiline ariaLabel="Copy invite link" />
                </Box>
              </Box>
              {inv.role !== 'admin' && (
                <Tooltip content="Revoke invite">
                  <IconButton size="1" variant="soft" color="red" onClick={() => remove(inv.token)}>
                    <TrashIcon />
                  </IconButton>
                </Tooltip>
              )}
            </Flex>
          ))}
        </Flex>
      )}
    </Flex>
  );
}
