import { CheckIcon, Cross2Icon, UpdateIcon } from '@radix-ui/react-icons';
import {
  Badge,
  Box,
  Button,
  Callout,
  Flex,
  IconButton,
  SegmentedControl,
  Select,
  Separator,
  Text,
  TextField,
  Tooltip,
} from '@radix-ui/themes';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  createInvite,
  deleteInvite,
  type Invite,
  listInvites,
  type Role,
  rotateAdminInvite,
} from '../lib/api.js';
import { getClientId, getDisplayName, useDisplayName } from '../lib/identity.js';
import { saveInviteToken } from '../lib/invite.js';
import { pushDoc as keyringPushDoc } from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import { appInviteKindColor, appRoleColor } from '../styles/theme.js';
import { ConfirmButton } from './ConfirmButton.js';
import { Copyable } from './Copyable.js';

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
          size="1"
          variant="soft"
          color="gray"
          aria-hidden="true"
          tabIndex={-1}
          className="confirm-pair-placeholder"
        >
          <Cross2Icon />
        </IconButton>
        <Tooltip content="Rotate admin link (invalidates the current URL)">
          <IconButton
            size="1"
            variant="soft"
            color="amber"
            aria-label="Rotate admin link"
            disabled={disabled}
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
      <Tooltip content="Cancel">
        <IconButton
          size="1"
          variant="soft"
          color="gray"
          aria-label="Cancel rotate"
          onClick={() => setArmed(false)}
        >
          <Cross2Icon />
        </IconButton>
      </Tooltip>
      <Tooltip content="Confirm rotate — the old admin URL stops working immediately">
        <IconButton
          size="1"
          variant="soft"
          color="amber"
          aria-label="Confirm rotate admin link"
          disabled={disabled}
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
  const refreshRequestRef = useRef(0);
  const [stateUid, setStateUid] = useState(uid);
  if (stateUid !== uid) {
    setStateUid(uid);
    setInvites(null);
    setError(null);
    setName('');
    setRole('reader');
    setSubmitting(false);
    setRotating(false);
  }

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequestRef.current;
    try {
      const r = await listInvites(uid);
      if (requestId !== refreshRequestRef.current) return;
      setInvites(r.invites);
    } catch (err) {
      if (requestId !== refreshRequestRef.current) return;
      reportError('InvitesPanel.list', err, { uid });
      setError('Could not load invites');
    }
  }, [uid]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: displayName is the explicit refetch trigger so the invite list re-pulls after the user sets/changes their identity.
  useLayoutEffect(() => {
    void refresh();
    return () => {
      // Discard a response for the previous uid/identity trigger.
      refreshRequestRef.current += 1;
    };
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
      const { invite } = await createInvite(uid, payload, identity);
      refreshRequestRef.current += 1;
      setInvites((current) =>
        current
          ? [...current.filter((existing) => existing.token !== invite.token), invite].sort(
              (a, b) => a.created_at - b.created_at,
            )
          : current,
      );
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
      refreshRequestRef.current += 1;
      setInvites((current) => current?.filter((invite) => invite.token !== token) ?? current);
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
      // Every other paired device is now holding a revoked token. Push
      // the replacement before anything else can fail — a rotation that
      // syncs only to this browser locks the rest out of their own
      // document, which is a worse outcome than the leak being rotated.
      keyringPushDoc(uid, admin_invite.token);
      refreshRequestRef.current += 1;
      setInvites((current) =>
        current
          ? current.map((invite) =>
              invite.kind === 'admin' ? { ...invite, ...admin_invite } : invite,
            )
          : current,
      );
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
      <Text size="2" weight="medium">
        Access links
      </Text>
      <Text size="1" color="gray">
        Each link is a shareable URL. A <b>named</b> link sets the recipient's display name and is
        only meant to be used by a specific person (useful for personal invites); a <b>generic</b>{' '}
        link lets the visitor bring their own name (useful for "anyone with this URL can comment").
      </Text>

      <Flex gap="2" align="end" wrap="wrap" className="invite-create-form">
        <Box>
          <Text as="div" size="1" color="gray" mb="1">
            Kind
          </Text>
          <SegmentedControl.Root
            size="2"
            value={kind}
            onValueChange={(v) => setKind(v as 'named' | 'generic')}
            aria-label="Invite kind"
          >
            <SegmentedControl.Item value="named" title="Forces a display name on the recipient">
              Named
            </SegmentedControl.Item>
            <SegmentedControl.Item value="generic" title="Visitor keeps their own name">
              Generic
            </SegmentedControl.Item>
          </SegmentedControl.Root>
        </Box>
        <Box style={{ flex: 1, minWidth: 160 }}>
          <Text as="label" size="1" color="gray" mb="1" htmlFor="invite-name">
            Recipient name {kind === 'generic' && <i>(not used for generic)</i>}
          </Text>
          <TextField.Root
            id="invite-name"
            size="2"
            placeholder={kind === 'named' ? 'e.g. Alice' : '—'}
            value={kind === 'named' ? name : ''}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            disabled={kind === 'generic'}
          />
        </Box>
        <Box>
          <Text as="div" size="1" color="gray" mb="1">
            Role
          </Text>
          <Select.Root value={role} onValueChange={(v) => setRole(v as Role)} size="2">
            <Select.Trigger variant="soft" aria-label={`Role: ${roleLabel(role)}`}>
              <Text as="span">{roleLabel(role)}</Text>
            </Select.Trigger>
            <Select.Content position="popper">
              <Select.Item value="reader">Reader (view only)</Select.Item>
              <Select.Item value="collaborator">Collaborator (comment + propose edits)</Select.Item>
              <Select.Item value="editor">Editor (can edit directly)</Select.Item>
              {/* 'admin' is intentionally absent — admin invites are minted
                  at document creation and rotated via the per-row action
                  below, never granted to third parties through this form. */}
            </Select.Content>
          </Select.Root>
        </Box>
        <Button
          size="2"
          disabled={submitting || (kind === 'named' && !name.trim())}
          onClick={addInvite}
        >
          Create link
        </Button>
      </Flex>

      {error && (
        <Callout.Root color="red" size="1">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      <Separator size="4" />

      {!invites ? (
        <Text size="1" color="gray">
          Loading…
        </Text>
      ) : invites.length === 0 ? (
        <Text size="1" color="gray">
          No invites yet.
        </Text>
      ) : (
        <Flex direction="column" gap="2">
          {invites.map((inv) => (
            <Flex key={inv.token} direction="column" gap="2" p="2" className="invite-card">
              <Flex align="start" justify="between" gap="2" className="invite-header">
                <Flex align="baseline" gap="2" wrap="wrap" className="invite-header-meta">
                  <Text size="2" weight="medium">
                    {inv.display_name ?? <span style={{ fontStyle: 'italic' }}>Any visitor</span>}
                  </Text>
                  <Badge
                    size="1"
                    color={appRoleColor(inv.role)}
                    variant="soft"
                    className="role-badge"
                  >
                    {inv.role}
                  </Badge>
                  <Badge size="1" color={appInviteKindColor(inv.kind)} variant="surface">
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
              <Copyable
                text={window.location.origin + inv.url}
                multiline
                ariaLabel="Copy invite link"
              />
            </Flex>
          ))}
        </Flex>
      )}
    </Flex>
  );
}
