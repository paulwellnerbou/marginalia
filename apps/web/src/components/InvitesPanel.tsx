import { CheckIcon, Cross2Icon, UpdateIcon } from '@radix-ui/react-icons';
import {
  Box,
  Button,
  Callout,
  Checkbox,
  Code,
  Flex,
  IconButton,
  SegmentedControl,
  Switch,
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
  setGroupLinkEnabled,
  updateInvite,
} from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { replaceFolderToken } from '../lib/folder.js';
import { linkWithFullView } from '../lib/full-view.js';
import { getClientId, getDisplayName, useDisplayName } from '../lib/identity.js';
import { loadInviteToken, saveInviteToken } from '../lib/invite.js';
import { pushDoc as keyringPushDoc } from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import { updateOpenTabToken } from '../lib/open-tabs.js';
import { updateRecentDocToken } from '../lib/recent-docs.js';
import { type GrantableRole, roleLabel, roleSummary } from '../lib/roles.js';
import {
  AccessCreateForm,
  AccessField,
  AccessList,
  AccessRow,
  RoleBadge,
  RoleSelect,
} from './AccessList.js';
import { ConfirmButton } from './ConfirmButton.js';
import { Copyable } from './Copyable.js';
import { Disclosure } from './Disclosure.js';

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

/**
 * `sharedWith`: the other documents of this one's folder, which open with
 * the same links — a rotated admin token has to reach them too.
 */
export function InvitesPanel({
  uid,
  sharedWith = [],
}: {
  uid: string;
  sharedWith?: readonly string[];
}) {
  const displayName = useDisplayName();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // No generic kind to create: a group link covers "anyone with the link"
  // and keeps each visitor apart. Existing generic links still list below.
  const [kind, setKind] = useState<'named' | 'group'>('named');
  const [name, setName] = useState('');
  const [role, setRole] = useState<GrantableRole>('reader');
  const [submitting, setSubmitting] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [shareFullView, setShareFullView] = useState(false);
  const [explainOpen, setExplainOpen] = useState(false);
  // A set rather than one token: role changes on different rows overlap, and
  // a single slot would let the second one re-enable the first row's select
  // and then clear the flag out from under it while it is still in flight.
  const [savingRoles, setSavingRoles] = useState<ReadonlySet<string>>(() => new Set());
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
    setSavingRoles(new Set());
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
        : { kind: 'group', role };

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

  async function changeRole(token: string, next: Role) {
    setError(null);
    const identityName = getDisplayName();
    if (!identityName) {
      setError('Please set your display name first.');
      return;
    }
    const identity = { clientId: getClientId(), displayName: identityName };
    // Optimistic: the select is a direct manipulation, so it should settle
    // under the pointer rather than snapping back for a round-trip.
    // Only this row's role is remembered for the rollback — creating and
    // revoking stay live while the request is in flight, so restoring a
    // whole snapshot of the list would undo whichever of those landed
    // in the meantime.
    const previousRole = invites?.find((i) => i.token === token)?.role;
    setInvites(
      (current) => current?.map((i) => (i.token === token ? { ...i, role: next } : i)) ?? current,
    );
    setSavingRoles((current) => new Set(current).add(token));
    try {
      const { invite } = await updateInvite(uid, token, next, identity);
      refreshRequestRef.current += 1;
      setInvites((current) => current?.map((i) => (i.token === token ? invite : i)) ?? current);
      await refresh();
    } catch (err) {
      reportError('InvitesPanel.updateRole', err);
      if (previousRole) {
        setInvites(
          (current) =>
            current?.map((i) => (i.token === token ? { ...i, role: previousRole } : i)) ?? current,
        );
      }
      setError(apiErrorMessage(err, 'Could not change the role'));
    } finally {
      // Clears this row only, so a slower sibling request keeps its own.
      setSavingRoles((current) => {
        const next = new Set(current);
        next.delete(token);
        return next;
      });
    }
  }

  async function toggleGroupLink(token: string, enabled: boolean) {
    setError(null);
    const identityName = getDisplayName();
    if (!identityName) {
      setError('Please set your display name first.');
      return;
    }
    const identity = { clientId: getClientId(), displayName: identityName };
    setInvites(
      (current) => current?.map((i) => (i.token === token ? { ...i, enabled } : i)) ?? current,
    );
    try {
      const { invite } = await setGroupLinkEnabled(uid, token, enabled, identity);
      refreshRequestRef.current += 1;
      setInvites((current) => current?.map((i) => (i.token === token ? invite : i)) ?? current);
      await refresh();
    } catch (err) {
      reportError('InvitesPanel.toggleGroupLink', err);
      setInvites(
        (current) =>
          current?.map((i) => (i.token === token ? { ...i, enabled: !enabled } : i)) ?? current,
      );
      setError(apiErrorMessage(err, 'Could not change the group link'));
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
      // A group link takes the personal links it handed out with it.
      setInvites(
        (current) =>
          current?.filter((invite) => invite.token !== token && invite.source_token !== token) ??
          current,
      );
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
    const oldToken = loadInviteToken(uid);
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
      const rotated = [uid, ...replaceFolderToken(sharedWith, oldToken, admin_invite.token)];
      for (const each of rotated) {
        keyringPushDoc(each, admin_invite.token);
        updateRecentDocToken(each, admin_invite.token);
        updateOpenTabToken(each, admin_invite.token);
      }
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
      <Box>
        <Text size="2" weight="medium" as="p" mb="1">
          Access links
        </Text>
        <Text size="1" color="gray" as="p">
          Share the document with a link. Each link carries a role; changing it keeps the URL and,
          like revoking, applies at once — even for anyone who has the document open.
        </Text>
        <Disclosure
          summary="How links work"
          open={explainOpen}
          onOpenChange={setExplainOpen}
          className="access-explainer"
        >
          <Box className="access-link-anatomy">
            <Text as="p" size="1" color="gray" mb="2">
              A <b>named</b> link sets the recipient's display name and is meant for one person. A{' '}
              <b>group</b> link is one link for several people: whoever opens it gets a personal
              link of their own, listed under it, which you can re-role or revoke on its own.
              Visitors are asked for their name before they write anything others see.
            </Text>
            <Flex align="center" wrap="wrap" className="access-link-anatomy__url">
              <Code size="1">https://…/d/</Code>
              <Code size="1" className="access-link-anatomy__document">
                Document ID
              </Code>
              <Code size="1">/</Code>
              <Code size="1" className="access-link-anatomy__token">
                Access token
              </Code>
            </Flex>
            <Text as="p" size="1" color="gray" mt="2">
              The <b>Document ID</b> finds the document. The <b>access token</b> is the secret key
              that lets the link holder in with the link's role.
            </Text>
            <Text as="p" size="1" color="gray" mt="2">
              <b>Open links in full view</b> adds <Code size="1">?view=full</Code> to the links and
              QR codes: the recipient sees only the document, its contents and the comments, and can
              leave full view from the contents pane.
            </Text>
          </Box>
        </Disclosure>
      </Box>

      <AccessCreateForm title="New link" onSubmit={() => void addInvite()} hint={roleSummary(role)}>
        <AccessField label="Kind">
          <SegmentedControl.Root
            size="2"
            value={kind}
            onValueChange={(v) => setKind(v as 'named' | 'group')}
            aria-label="Invite kind"
          >
            <SegmentedControl.Item value="named" title="Forces a display name on the recipient">
              Named
            </SegmentedControl.Item>
            <SegmentedControl.Item
              value="group"
              title="One link for several people; each gets a personal link"
            >
              Group
            </SegmentedControl.Item>
          </SegmentedControl.Root>
        </AccessField>
        <AccessField
          label={
            kind === 'named' ? 'Recipient name' : 'Recipient name (each person gives their own)'
          }
          htmlFor="invite-name"
          grow
        >
          <TextField.Root
            id="invite-name"
            size="2"
            placeholder={kind === 'named' ? 'e.g. Alice' : '—'}
            value={kind === 'named' ? name : ''}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            disabled={kind !== 'named'}
          />
        </AccessField>
        <AccessField label="Role" htmlFor="invite-role">
          <RoleSelect id="invite-role" look="field" value={role} onChange={setRole} />
        </AccessField>
        <Button type="submit" disabled={submitting || (kind === 'named' && !name.trim())}>
          Create link
        </Button>
      </AccessCreateForm>

      {error && (
        <Callout.Root color="red" size="1">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      <AccessList
        title="Links"
        loading={invites === null}
        empty="No links yet."
        aside={
          <Text as="label" size="1">
            <Flex align="center" gap="2">
              <Checkbox
                size="1"
                checked={shareFullView}
                onCheckedChange={(c) => setShareFullView(c === true)}
              />
              Open links in full view
            </Flex>
          </Text>
        }
      >
        {topLevelInvites(invites ?? []).map((inv) =>
          inv.kind === 'group' ? (
            <GroupLinkRow
              key={inv.token}
              invite={inv}
              people={(invites ?? []).filter((i) => i.source_token === inv.token)}
              shareFullView={shareFullView}
              savingRoles={savingRoles}
              onToggle={(enabled) => void toggleGroupLink(inv.token, enabled)}
              onChangeRole={(token, next) => void changeRole(token, next)}
              onRemove={remove}
            />
          ) : (
            <AccessRow
              key={inv.token}
              name={inv.display_name ?? <i>Any visitor</i>}
              role={
                inv.kind === 'admin' || inv.role === 'admin' ? (
                  // Fixed: the document's own admin link is rotated, never re-roled.
                  <RoleBadge role={inv.role} />
                ) : (
                  <RoleSelect
                    look="badge"
                    value={inv.role}
                    onChange={(next) => void changeRole(inv.token, next)}
                    disabled={savingRoles.has(inv.token)}
                    ariaLabel={`Role for ${inv.display_name ?? 'any visitor'}: ${roleLabel(inv.role)}`}
                  />
                )
              }
              meta={inviteMeta(inv)}
              action={
                inv.kind === 'admin' ? (
                  // Rotation, not deletion, with a two-step confirm so a stray
                  // click doesn't orphan the admin's active URL.
                  <RotateAdminButton onConfirm={rotateAdmin} disabled={rotating} />
                ) : (
                  <ConfirmButton label="Revoke link" onConfirm={() => remove(inv.token)} />
                )
              }
            >
              <Copyable
                text={linkWithFullView(window.location.origin + inv.url, shareFullView)}
                multiline
                ariaLabel="Copy invite link"
                size="1"
                qrCode
                className="copyable-access-link"
              />
            </AccessRow>
          ),
        )}
      </AccessList>
    </Flex>
  );
}

/**
 * Mirrors the server's `AGENT_INVITE_NOTE`. A copied document carries the
 * note onto links no agent key owns, so it marks an agent, not a key.
 */
const AGENT_INVITE_NOTE = 'AI agent via keyring';

function inviteMeta(inv: Invite): string {
  if (inv.note === AGENT_INVITE_NOTE) {
    return `AI agent · opens as ${inv.display_name ?? 'the agent'}`;
  }
  switch (inv.kind) {
    case 'admin':
      return 'Admin link · can be replaced, not revoked';
    case 'named':
      return `Personal link · opens as ${inv.display_name ?? 'its recipient'}`;
    case 'generic':
      return 'Open link · visitors use their own name';
    case 'group':
      return 'Group link · hands each visitor a personal link';
  }
}

/**
 * Personal links sit under the group link that minted it. One whose group
 * link is somehow gone still lists, on its own, so it can be revoked.
 */
function topLevelInvites(invites: readonly Invite[]): Invite[] {
  const tokens = new Set(invites.map((i) => i.token));
  return invites.filter((i) => !i.source_token || !tokens.has(i.source_token));
}

function GroupLinkRow({
  invite,
  people,
  shareFullView,
  savingRoles,
  onToggle,
  onChangeRole,
  onRemove,
}: {
  invite: Invite;
  people: Invite[];
  shareFullView: boolean;
  savingRoles: ReadonlySet<string>;
  onToggle: (enabled: boolean) => void;
  onChangeRole: (token: string, next: Role) => void;
  onRemove: (token: string) => Promise<void>;
}) {
  const enabled = invite.enabled !== false;
  const [unnamedOpen, setUnnamedOpen] = useState(false);
  const named = people.filter((p) => !p.name_provisional);
  const unnamed = people.filter((p) => p.name_provisional);
  const count = people.length === 1 ? '1 person' : `${people.length} people`;
  const meta = enabled
    ? `Group link · ${count} · new people join as ${roleLabel(invite.role)}`
    : `Group link, turned off · ${count} keep their access`;
  return (
    <AccessRow
      name="Group link"
      role={
        <RoleSelect
          look="badge"
          value={invite.role as GrantableRole}
          onChange={(next) => onChangeRole(invite.token, next)}
          disabled={savingRoles.has(invite.token)}
          ariaLabel={`Role for people who join from now on: ${roleLabel(invite.role)}`}
        />
      }
      meta={meta}
      action={
        <ConfirmButton
          label={
            people.length > 0
              ? `Revoke all: the group link and the ${count === '1 person' ? 'personal link' : `${people.length} personal links`} it handed out`
              : 'Revoke group link'
          }
          confirmLabel={
            people.length > 0
              ? `Confirm: revoke ${people.length + 1} links at once`
              : 'Confirm revoke'
          }
          onConfirm={() => onRemove(invite.token)}
        />
      }
    >
      <Text as="label" size="1">
        <Flex align="center" gap="2">
          <Switch size="1" checked={enabled} onCheckedChange={(next) => onToggle(next)} />
          {enabled
            ? 'Hands out personal links'
            : 'Off: hands out no new links; the people below keep theirs'}
        </Flex>
      </Text>
      {enabled && (
        <Copyable
          text={linkWithFullView(window.location.origin + invite.url, shareFullView)}
          multiline
          ariaLabel="Copy group link"
          size="1"
          qrCode
          className="copyable-access-link"
        />
      )}
      {people.length > 0 && (
        <Box>
          <div className="access-sublist">
            {named.map((p) => (
              <PersonalLinkRow
                key={p.token}
                invite={p}
                saving={savingRoles.has(p.token)}
                onChangeRole={onChangeRole}
                onRemove={onRemove}
              />
            ))}
            {unnamed.length > 0 && (
              <Box className="access-list__row">
                <Disclosure
                  open={unnamedOpen}
                  onOpenChange={setUnnamedOpen}
                  summary={
                    unnamed.length === 1
                      ? '1 without a name yet'
                      : `${unnamed.length} without a name yet`
                  }
                >
                  {unnamed.map((p) => (
                    <PersonalLinkRow
                      key={p.token}
                      invite={p}
                      saving={savingRoles.has(p.token)}
                      onChangeRole={onChangeRole}
                      onRemove={onRemove}
                    />
                  ))}
                </Disclosure>
              </Box>
            )}
          </div>
          <Text as="p" size="1" color="gray" mt="1">
            {enabled
              ? 'Revoking someone ends their link, but while the group link is on they can open it again for a new one. Turn it off first to keep someone out.'
              : 'Revoking someone ends their access for good while the group link stays off.'}
          </Text>
        </Box>
      )}
    </AccessRow>
  );
}

function PersonalLinkRow({
  invite,
  saving,
  onChangeRole,
  onRemove,
}: {
  invite: Invite;
  saving: boolean;
  onChangeRole: (token: string, next: Role) => void;
  onRemove: (token: string) => Promise<void>;
}) {
  const name = invite.display_name ?? 'Unnamed';
  return (
    <AccessRow
      name={invite.name_provisional ? <Text color="gray">{name}</Text> : name}
      role={
        <RoleSelect
          look="badge"
          value={invite.role as GrantableRole}
          onChange={(next) => onChangeRole(invite.token, next)}
          disabled={saving}
          ariaLabel={`Role for ${name}: ${roleLabel(invite.role)}`}
        />
      }
      meta={personalMeta(invite)}
      action={
        <ConfirmButton label={`Revoke ${name}'s link`} onConfirm={() => onRemove(invite.token)} />
      }
    />
  );
}

function personalMeta(inv: Invite): string {
  const parts: string[] = [];
  if (inv.name_provisional) parts.push('No name given yet');
  parts.push(`joined ${shortDate(inv.created_at)}`);
  if (inv.last_used_at) parts.push(`last seen ${shortDate(inv.last_used_at)}`);
  const previous = inv.previous_names ?? [];
  if (previous.length > 0) parts.push(`previously ${previous.slice(0, 3).join(', ')}`);
  const text = parts.join(' · ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function shortDate(ms: number): string {
  const date = new Date(ms);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
