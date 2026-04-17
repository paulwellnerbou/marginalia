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
import { CopyIcon, TrashIcon } from '@radix-ui/react-icons';
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
      setError('Set your display name first (user menu, top-right).');
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

  async function copyLink(invite: Invite) {
    const url = window.location.origin + invite.url;
    try {
      await navigator.clipboard.writeText(url);
      showToast(
        { title: `Invite link for ${invite.display_name} copied`, body: url },
        4000,
      );
    } catch (err) {
      reportError('InvitesPanel.copy', err);
    }
  }

  return (
    <Flex direction="column" gap="3">
      <Text size="2" weight="medium">Invites</Text>
      <Text size="1" color="gray">
        Each invite is a shareable URL that auto-identifies the recipient by name and role. The
        author's admin invite is the canonical way back into the document.
      </Text>

      <Flex gap="2" align="end" wrap="wrap">
        <Box style={{ flex: 1, minWidth: 160 }}>
          <Text as="div" size="1" color="gray" mb="1">Recipient name</Text>
          <TextField.Root
            size="1"
            placeholder="e.g. Alice"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
        </Box>
        <Box>
          <Text as="div" size="1" color="gray" mb="1">Role</Text>
          <Select.Root value={role} onValueChange={(v) => setRole(v as Role)}>
            <Select.Trigger variant="soft" />
            <Select.Content position="popper">
              <Select.Item value="reader">Reader (view only)</Select.Item>
              <Select.Item value="editor">Editor (can edit)</Select.Item>
              <Select.Item value="admin">Admin (full control)</Select.Item>
            </Select.Content>
          </Select.Root>
        </Box>
        <Button size="1" disabled={!name.trim() || submitting} onClick={addInvite}>
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
                  <Badge
                    size="1"
                    color={inv.role === 'admin' ? 'indigo' : inv.role === 'editor' ? 'green' : 'gray'}
                    variant="soft"
                    className="role-badge"
                  >
                    {inv.role}
                  </Badge>
                </Flex>
                <Code size="1" style={{ wordBreak: 'break-all' }}>
                  {window.location.origin + inv.url}
                </Code>
              </Box>
              <Tooltip content="Copy link">
                <IconButton size="1" variant="soft" onClick={() => copyLink(inv)}>
                  <CopyIcon />
                </IconButton>
              </Tooltip>
              <Tooltip content="Revoke invite">
                <IconButton size="1" variant="soft" color="red" onClick={() => remove(inv.token)}>
                  <TrashIcon />
                </IconButton>
              </Tooltip>
            </Flex>
          ))}
        </Flex>
      )}
    </Flex>
  );
}
