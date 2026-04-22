import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActionIcon as IconButton,
  Alert,
  Badge,
  Box,
  Button,
  Divider as Separator,
  Flex,
  SegmentedControl,
  Select,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { CheckIcon, Cross2Icon, UpdateIcon } from '../icons.js';
import { Copyable } from './Copyable.js';
import { ConfirmButton } from './ConfirmButton.js';
import {
  createInvite,
  deleteInvite,
  listInvites,
  rotateAdminInvite,
  type Invite,
  type Role,
} from '../lib/api.js';
import { getClientId, getDisplayName, useDisplayName } from '../lib/identity.js';
import { saveInviteToken } from '../lib/invite.js';
import { reportError } from '../lib/log.js';
import { appInviteKindColor, appRoleColor } from '../styles/theme.js';

/**
 * Two-step inline confirm for the admin-rotate action. Kept local because
 * ConfirmButton is purpose-built around a TrashIcon / "revoke" shape; this
 * one shows an UpdateIcon and auto-reverts after 4s if the admin clicks
 * somewhere else without confirming.
 */
function RotateAdminButton({
  onConfirm,
  disabled,
}: {
  onConfirm: () => void | Promise<void>;
  /** Disables arming AND confirming — used to lock the control while a
   *  previous rotation is still in flight (see the caller's `rotating`
   *  state) so double-clicks can't overlap requests. */
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!armed) return;
    timer.current = window.setTimeout(() => setArmed(false), 4000);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [armed]);
  // If the parent locks us mid-arm, collapse back to the idle state so
  // the stale "confirm" pair doesn't linger.
  useEffect(() => {
    if (disabled && armed) setArmed(false);
  }, [disabled, armed]);

  if (!armed) {
    return (
      <Flex gap="2" align="center" className="confirm-pair">
        <IconButton
          size="xs"
          variant="light"
          color="gray"
          aria-hidden="true"
          tabIndex={-1}
          className="confirm-pair-placeholder"
        >
          <Cross2Icon />
        </IconButton>
        <Tooltip label="Rotate admin link (invalidates the current URL)">
          <IconButton
            size="xs"
            variant="light"
            color="amber"
            aria-label="Rotate admin link"
            disabled={disabled ?? false}
            onClick={() => setArmed(true)}
          >
            <UpdateIcon />
          </IconButton>
        </Tooltip>
      </Flex>
    );
  }
  return (
    <Flex gap="2" align="center" className="confirm-pair">
      <Tooltip label="Cancel">
        <IconButton
          size="xs"
          variant="light"
          color="gray"
          aria-label="Cancel rotate"
          onClick={() => setArmed(false)}
        >
          <Cross2Icon />
        </IconButton>
      </Tooltip>
      <Tooltip label="Confirm rotate — the old admin URL stops working immediately">
        <IconButton
          size="xs"
            variant="light"
            color="amber"
            aria-label="Confirm rotate admin link"
            disabled={disabled ?? false}
            onClick={() => {
              setArmed(false);
              void onConfirm();
          }}
        >
          <CheckIcon />
        </IconButton>
      </Tooltip>
    </Flex>
  );
}

function roleLabel(role: Role): string {
  switch (role) {
    case 'admin':
      return 'Admin';
    case 'editor':
      return 'Editor';
    case 'collaborator':
      return 'Collaborator';
    case 'reader':
      return 'Reader';
  }
}

export function InvitesPanel({ uid }: { uid: string }) {
  const displayName = useDisplayName();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<'named' | 'generic'>('named');
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('reader');
  const [submitting, setSubmitting] = useState(false);
  const [rotating, setRotating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await listInvites(uid);
      setInvites(r.invites);
    } catch (err) {
      reportError('InvitesPanel.list', err, { uid });
      setError('Could not load invites');
    }
  }, [uid]);

  useEffect(() => {
    void refresh();
  }, [displayName, refresh]);

  async function addInvite() {
    setError(null);
    const identityName = getDisplayName();
    if (!identityName) {
      setError('Please set your display name first.');
      return;
    }
    const identity = { clientId: getClientId(), displayName: identityName };

    if (kind === 'named' && !name.trim()) {
      setError('Named invites need a recipient name.');
      return;
    }
    const payload: Parameters<typeof createInvite>[1] =
      kind === 'named'
        ? { kind: 'named', display_name: name.trim(), role }
        : { kind: 'generic', role };

    setSubmitting(true);
    try {
      await createInvite(uid, payload, identity);
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
    setError(null);
    const identityName = getDisplayName();
    if (!identityName) {
      setError('Please set your display name first.');
      return;
    }
    const identity = { clientId: getClientId(), displayName: identityName };
    try {
      await deleteInvite(uid, token, identity);
      await refresh();
    } catch (err) {
      reportError('InvitesPanel.delete', err);
      setError(err instanceof Error ? err.message : 'Could not revoke invite');
    }
  }

  async function rotateAdmin() {
    if (rotating) return; // guard against concurrent rotations
    setError(null);
    const identityName = getDisplayName();
    if (!identityName) {
      setError('Please set your display name first.');
      return;
    }
    const identity = { clientId: getClientId(), displayName: identityName };
    setRotating(true);
    try {
      const { admin_invite } = await rotateAdminInvite(uid, identity);
      // Critical: persist the NEW admin token before any further API call.
      // Otherwise `refresh()` (or any subsequent admin-only request from
      // this tab) keeps sending the just-revoked token and the tab locks
      // itself out of admin until the admin manually re-opens the new URL.
      saveInviteToken(uid, admin_invite.token);
      await refresh();
    } catch (err) {
      reportError('InvitesPanel.rotateAdmin', err);
      setError(err instanceof Error ? err.message : 'Could not rotate admin link');
    } finally {
      setRotating(false);
    }
  }

  return (
    <Flex direction="column" gap="3">
      <Text size="sm" fw={500}>
        Access links
      </Text>
      <Text size="xs" c="dimmed">
        Each link is a shareable URL. A <b>named</b> link sets the recipient's display name and is only meant to be used by a specific person
        (useful for personal invites); a <b>generic</b> link lets the visitor bring their own
        name (useful for "anyone with this URL can comment").
      </Text>

      <Flex gap="2" align="end" wrap="wrap" className="invite-create-form">
        <Box>
          <Text component="div" size="xs" c="dimmed" mb="1">
            Kind
          </Text>
          <SegmentedControl
            size="sm"
            value={kind}
            onChange={(v) => setKind(v as 'named' | 'generic')}
            aria-label="Invite kind"
            data={[
              { value: 'named', label: 'Named' },
              { value: 'generic', label: 'Generic' },
            ]}
          />
        </Box>
        <Box style={{ flex: 1, minWidth: 160 }}>
          <Text component="label" size="xs" c="dimmed" mb="1" htmlFor="invite-name">
            Recipient name {kind === 'generic' && <i>(not used for generic)</i>}
          </Text>
          <TextInput
            id="invite-name"
            size="sm"
            placeholder={kind === 'named' ? 'e.g. Alice' : '—'}
            value={kind === 'named' ? name : ''}
            onChange={(e: any) => setName(e.target.value)}
            maxLength={80}
            disabled={kind === 'generic'}
          />
        </Box>
        <Box>
          <Text component="div" size="xs" c="dimmed" mb="1">
            Role
          </Text>
          <Select
            value={role}
            onChange={(value) => {
              if (value) setRole(value as Role);
            }}
            size="sm"
            aria-label={`Role: ${roleLabel(role)}`}
            data={[
              { value: 'reader', label: 'Reader (view only)' },
              { value: 'collaborator', label: 'Collaborator (comment + propose edits)' },
              { value: 'editor', label: 'Editor (can edit directly)' },
            ]}
          />
        </Box>
        <Button
          size="sm"
          disabled={submitting || (kind === 'named' && !name.trim())}
          onClick={addInvite}
        >
          Create link
        </Button>
      </Flex>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      <Separator />

      {!invites ? (
        <Text size="xs" c="dimmed">
          Loading…
        </Text>
      ) : invites.length === 0 ? (
        <Text size="xs" c="dimmed">
          No invites yet.
        </Text>
      ) : (
        <Flex direction="column" gap="2">
          {invites.map((inv) => (
            <Flex
              key={inv.token}
              direction="column"
              gap="2"
              p="2"
              className="invite-card"
            >
              <Flex align="start" justify="between" gap="2" className="invite-header">
                <Flex align="baseline" gap="2" wrap="wrap" className="invite-header-meta">
                  <Text size="sm" fw={500}>
                    {inv.display_name ?? <span style={{ fontStyle: 'italic' }}>Any visitor</span>}
                  </Text>
                  <Badge size="xs" color={appRoleColor(inv.role)} variant="light" className="role-badge">
                    {inv.role}
                  </Badge>
                  <Badge size="xs" color={appInviteKindColor(inv.kind)} variant="outline">
                    {inv.kind}
                  </Badge>
                </Flex>
                <Box className="invite-header-action">
                  {inv.kind === 'admin' ? (
                    // Admin link: rotation, not deletion. Two-step confirm (inline
                    // below) so a stray click doesn't orphan the admin's active
                    // URL before they've had a chance to copy the new one.
                    <RotateAdminButton onConfirm={rotateAdmin} disabled={rotating} />
                  ) : (
                    <ConfirmButton label="Revoke invite" onConfirm={() => remove(inv.token)} />
                  )}
                </Box>
              </Flex>
              <Copyable text={window.location.origin + inv.url} multiline ariaLabel="Copy invite link" />
            </Flex>
          ))}
        </Flex>
      )}
    </Flex>
  );
}
