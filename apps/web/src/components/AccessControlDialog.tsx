import {
  ExclamationTriangleIcon,
  EyeClosedIcon,
  LockClosedIcon,
  Share2Icon,
} from '@radix-ui/react-icons';
import {
  AlertDialog,
  Button,
  Callout,
  Checkbox,
  Dialog,
  Flex,
  IconButton,
  Separator,
  Text,
} from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import type { Document } from '../lib/api.js';
import {
  type DocumentSettingsResponse,
  recoverCurrentPassword,
  updateDocumentSettings,
} from '../lib/api.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { InvitesPanel } from './InvitesPanel.js';
import { PasswordDisclosureCard } from './PasswordDisclosureCard.js';

/**
 * "Access Control" — everything that decides who can read, edit, and
 * comment. Separated from DocumentSettingsDialog because admins reach for
 * permissions and naming/theme at very different times.
 *
 * Surface: password protection (enable/disable/rotate), fresh-password
 * disclosure, and the per-recipient invite link manager.
 */
export function AccessControlDialog({
  doc,
  onChange,
}: {
  doc: Document;
  onChange: (s: DocumentSettingsResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [passwordProtected, setPasswordProtected] = useState(doc.password_protected);
  const [inviteOnly, setInviteOnly] = useState(doc.invite_only);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disclosedPassword, setDisclosedPassword] = useState<{
    label: string;
    value: string;
  } | null>(null);

  function messageForError(err: unknown, fallback: string): string {
    if (err instanceof Error && err.message === 'password-unavailable') {
      return 'This document was password-protected before recovery was added. Rotate the password once to enable future recovery.';
    }
    if (err instanceof Error && err.message === 'forbidden') {
      return 'Only the current admin link can reveal the password.';
    }
    return err instanceof Error ? err.message : fallback;
  }

  useEffect(() => {
    setPasswordProtected(doc.password_protected);
  }, [doc.password_protected]);

  useEffect(() => {
    setInviteOnly(doc.invite_only);
  }, [doc.invite_only]);

  async function setInviteOnlyAccess(next: boolean) {
    if (next === doc.invite_only) {
      setInviteOnly(next);
      return;
    }

    const name = getDisplayName();
    if (!name) {
      setError('Please set your display name first.');
      setInviteOnly(doc.invite_only);
      return;
    }

    const identity = { clientId: getClientId(), displayName: name };
    const previous = inviteOnly;
    setInviteOnly(next);
    setSaving(true);
    setError(null);
    try {
      const result = await updateDocumentSettings(doc.uid, { invite_only: next }, identity);
      onChange(result);
      setInviteOnly(result.invite_only);
    } catch (err) {
      setInviteOnly(previous);
      reportError('AccessControl.setInviteOnlyAccess', err);
      setError(messageForError(err, 'Update failed'));
    } finally {
      setSaving(false);
    }
  }

  async function setPasswordProtection(next: boolean) {
    if (next === doc.password_protected) {
      setPasswordProtected(next);
      return;
    }

    const name = getDisplayName();
    if (!name) {
      setError('Please set your display name first.');
      setPasswordProtected(doc.password_protected);
      return;
    }

    const identity = { clientId: getClientId(), displayName: name };
    const previous = passwordProtected;
    setPasswordProtected(next);
    setSaving(true);
    setError(null);
    try {
      const patch: Parameters<typeof updateDocumentSettings>[1] = {
        password: next ? 'rotate' : null,
      };
      const result = await updateDocumentSettings(doc.uid, patch, identity);
      onChange(result);
      setPasswordProtected(result.password_protected);
      if (result.password) {
        setDisclosedPassword({ label: 'New password', value: result.password });
      } else {
        setDisclosedPassword(null);
      }
    } catch (err) {
      setPasswordProtected(previous);
      reportError('AccessControl.setPasswordProtection', err);
      setError(messageForError(err, 'Update failed'));
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    setError(null);
    const name = getDisplayName();
    if (!name) {
      setError('Please set your display name first.');
      return;
    }
    const identity = { clientId: getClientId(), displayName: name };
    setSaving(true);
    try {
      const result = await updateDocumentSettings(doc.uid, { password: 'rotate' }, identity);
      onChange(result);
      if (result.password) {
        setDisclosedPassword({ label: 'New password', value: result.password });
      }
    } catch (err) {
      reportError('AccessControl.rotate', err);
      setError(messageForError(err, 'Rotate failed'));
    } finally {
      setSaving(false);
    }
  }

  async function revealCurrentPassword() {
    setError(null);
    setSaving(true);
    try {
      const result = await recoverCurrentPassword(doc.uid);
      setDisclosedPassword({ label: 'Current password', value: result.password });
    } catch (err) {
      reportError('AccessControl.revealCurrentPassword', err);
      setError(messageForError(err, 'Could not reveal the current password for this document'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        // Drop the one-shot password disclosure on close so reopening
        // doesn't surprise the user with a stale value.
        if (!v) {
          setDisclosedPassword(null);
          setError(null);
          setPasswordProtected(doc.password_protected);
          setInviteOnly(doc.invite_only);
        }
      }}
    >
      <Dialog.Trigger>
        <IconButton variant="soft" size="2" aria-label="Access control" title="Access control">
          <Share2Icon />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Content size="3" maxWidth="780px" className="dialog-content--fixed-footer">
        <div className="dialog-scroll-body">
          <Dialog.Title>Access control</Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="4">
            Who can read, edit, and comment. Document name, theme, and export live in Document
            settings.
          </Dialog.Description>

          <Flex direction="column" gap="4">
            {/* No anyone-can-edit toggle: non-reader rights come only from
              invite links below. */}
            <Flex direction="column" gap="2">
              <Text as="label" size="2">
                <Flex align="center" gap="2">
                  <Checkbox
                    checked={inviteOnly}
                    disabled={saving}
                    onCheckedChange={(c) => void setInviteOnlyAccess(c === true)}
                  />
                  <EyeClosedIcon />
                  Restrict this document to access links
                </Flex>
              </Text>
              <Flex pl="6">
                <Text size="1" color="gray">
                  {/* The password below is a gate of its own, so what the URL
                    alone is worth depends on both settings. */}
                  {inviteOnly
                    ? 'Only the access links below open this document. Anyone else holding the URL is turned away.'
                    : passwordProtected
                      ? 'Anyone with the document URL can read it, once they enter the password. Access links additionally grant comment or edit rights.'
                      : 'Anyone with the document URL can read it. Access links additionally grant comment or edit rights.'}
                </Text>
              </Flex>
            </Flex>

            <Flex direction="column" gap="2">
              <Text as="label" size="2">
                <Flex align="center" gap="2">
                  <Checkbox
                    checked={passwordProtected}
                    disabled={saving}
                    onCheckedChange={(c) => void setPasswordProtection(c === true)}
                  />
                  <LockClosedIcon />
                  Password-protect this document
                </Flex>
              </Text>
              {passwordProtected && doc.password_protected && (
                <Flex align="center" gap="2" pl="6">
                  <Text size="1" color="gray">
                    Password is set. Rotate invalidates existing sessions; the admin link can reveal
                    the current password later without rotating it.
                  </Text>
                  <Button size="1" variant="soft" disabled={saving} onClick={revealCurrentPassword}>
                    Reveal current password
                  </Button>
                  {/* Destructive + unrecoverable: always confirm. */}
                  <AlertDialog.Root>
                    <AlertDialog.Trigger>
                      <Button size="1" variant="soft" color="amber" disabled={saving}>
                        Rotate password
                      </Button>
                    </AlertDialog.Trigger>
                    <AlertDialog.Content maxWidth="480px" className="dialog-content--fixed-footer">
                      <div className="dialog-scroll-body">
                        <AlertDialog.Title>
                          <Flex align="center" gap="2">
                            <ExclamationTriangleIcon /> Rotate the document password?
                          </Flex>
                        </AlertDialog.Title>
                        <AlertDialog.Description size="2" mb="3">
                          Rotating generates a brand-new password and invalidates every existing
                          session on this document.
                        </AlertDialog.Description>
                        <Flex direction="column" gap="2">
                          <Text size="2" as="p">
                            <b>Everyone</b> who has the current password — including users who
                            already had this document open — will be prompted to re-enter it before
                            they can read or write anything.
                          </Text>
                          <Text size="2" as="p">
                            The admin link can reveal the current password later, but everyone else
                            still needs the <b>new password</b> shared out of band before they can
                            get back in.
                          </Text>
                        </Flex>
                      </div>
                      <Flex className="dialog-footer" gap="2" justify="end" mt="4">
                        <AlertDialog.Cancel>
                          <Button variant="soft" color="gray">
                            Cancel
                          </Button>
                        </AlertDialog.Cancel>
                        <AlertDialog.Action>
                          <Button color="amber" onClick={rotate}>
                            Rotate password
                          </Button>
                        </AlertDialog.Action>
                      </Flex>
                    </AlertDialog.Content>
                  </AlertDialog.Root>
                </Flex>
              )}
            </Flex>

            {disclosedPassword && (
              <PasswordDisclosureCard
                docUid={doc.uid}
                password={disclosedPassword.value}
                label={disclosedPassword.label}
                docName={doc.name}
              />
            )}

            <Separator size="4" />

            <InvitesPanel uid={doc.uid} />

            {error && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}
          </Flex>
        </div>
        <Flex className="dialog-footer" gap="2" justify="end" mt="4">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Close
            </Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
