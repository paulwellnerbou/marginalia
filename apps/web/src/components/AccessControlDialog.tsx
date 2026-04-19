import { ExclamationTriangleIcon, LockClosedIcon, Share2Icon } from '@radix-ui/react-icons';
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
import { type DocumentSettingsResponse, updateDocumentSettings } from '../lib/api.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { Copyable } from './Copyable.js';
import { InvitesPanel } from './InvitesPanel.js';

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshPassword, setFreshPassword] = useState<string | null>(null);

  useEffect(() => {
    setPasswordProtected(doc.password_protected);
  }, [doc.password_protected]);

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
      if (result.password) setFreshPassword(result.password);
      else setFreshPassword(null);
    } catch (err) {
      setPasswordProtected(previous);
      reportError('AccessControl.setPasswordProtection', err);
      setError(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    const name = getDisplayName();
    if (!name) return;
    const identity = { clientId: getClientId(), displayName: name };
    setSaving(true);
    setError(null);
    try {
      const result = await updateDocumentSettings(doc.uid, { password: 'rotate' }, identity);
      onChange(result);
      if (result.password) setFreshPassword(result.password);
    } catch (err) {
      reportError('AccessControl.rotate', err);
      setError(err instanceof Error ? err.message : 'Rotate failed');
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
          setFreshPassword(null);
          setError(null);
          setPasswordProtected(doc.password_protected);
        }
      }}
    >
      <Dialog.Trigger>
        <IconButton variant="soft" size="2" aria-label="Access control" title="Access control">
          <Share2Icon />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Content size="3" maxWidth="780px">
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
                  Password is set. Rotate invalidates existing sessions; invite links still
                  determine identity and role after re-authentication.
                </Text>
                {/* Destructive + unrecoverable: always confirm. */}
                <AlertDialog.Root>
                  <AlertDialog.Trigger>
                    <Button size="1" variant="soft" color="amber" disabled={saving}>
                      Rotate password
                    </Button>
                  </AlertDialog.Trigger>
                  <AlertDialog.Content maxWidth="480px">
                    <AlertDialog.Title>
                      <Flex align="center" gap="2">
                        <ExclamationTriangleIcon /> Rotate the document password?
                      </Flex>
                    </AlertDialog.Title>
                    <AlertDialog.Description size="2" mb="3">
                      Rotating generates a brand-new password and invalidates every existing
                      session on this document.
                    </AlertDialog.Description>
                    <Flex direction="column" gap="2" mb="4">
                      <Text size="2" as="p">
                        <b>Everyone</b> who has the current password — including users who already
                        had this document open — will be prompted to re-enter it before they can
                        read or write anything.
                      </Text>
                      <Text size="2" as="p">
                        The <b>new password is shown only once</b>, right after rotation. There is
                        no way to recover it afterwards; you'll need to share it out of band with
                        each person you want back in.
                      </Text>
                    </Flex>
                    <Flex gap="2" justify="end">
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

          {freshPassword && (
            <Callout.Root color="amber">
              <Callout.Text>
                <Flex direction="column" gap="2">
                  <span>New password (shown once):</span>
                  <Copyable text={freshPassword} ariaLabel="Copy password" />
                </Flex>
              </Callout.Text>
            </Callout.Root>
          )}

          <Separator size="4" />

          <InvitesPanel uid={doc.uid} />

          {error && (
            <Callout.Root color="red" size="1">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}

          <Flex gap="2" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray">
                Close
              </Button>
            </Dialog.Close>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
