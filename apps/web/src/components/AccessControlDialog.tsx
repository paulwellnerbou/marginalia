import { ExclamationTriangleIcon, LockClosedIcon, Share2Icon } from '../icons.js';
import {
  ActionIcon as IconButton,
  Alert,
  Button,
  Checkbox,
  Divider as Separator,
  Flex,
  Modal,
  Text,
} from '@mantine/core';
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
  const [rotateDialogOpen, setRotateDialogOpen] = useState(false);

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

  async function rotate(): Promise<boolean> {
    setError(null);
    const name = getDisplayName();
    if (!name) {
      setError('Please set your display name first.');
      return false;
    }
    const identity = { clientId: getClientId(), displayName: name };
    setSaving(true);
    try {
      const result = await updateDocumentSettings(doc.uid, { password: 'rotate' }, identity);
      onChange(result);
      if (result.password) setFreshPassword(result.password);
      return true;
    } catch (err) {
      reportError('AccessControl.rotate', err);
      setError(err instanceof Error ? err.message : 'Rotate failed');
      return false;
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <IconButton variant="light" size="sm" aria-label="Access control" title="Access control" onClick={() => setOpen(true)}>
        <Share2Icon />
      </IconButton>
      <Modal
        opened={open}
        onClose={() => {
          setOpen(false);
          setRotateDialogOpen(false);
          setFreshPassword(null);
          setError(null);
          setPasswordProtected(doc.password_protected);
        }}
        size="780px"
        title={<Text fw={600} size="lg">Access control</Text>}
      >
        <Text size="sm" c="dimmed" mb="4">
          Who can read, edit, and comment. Document name, theme, and export live in Document
          settings.
        </Text>

        <Flex direction="column" gap="4">
          {/* No anyone-can-edit toggle: non-reader rights come only from
              invite links below. */}
          <Flex direction="column" gap="2">
            <Text component="label" size="sm">
              <Flex align="center" gap="2">
                <Checkbox
                  checked={passwordProtected}
                  disabled={saving}
                  onChange={(event) => void setPasswordProtection(event.currentTarget.checked)}
                />
                <LockClosedIcon />
                Password-protect this document
              </Flex>
            </Text>
            {passwordProtected && doc.password_protected && (
              <Flex align="center" gap="2" pl="6">
                <Text size="xs" c="dimmed">
                  Password is set. Rotate invalidates existing sessions; invite links still
                  determine identity and role after re-authentication.
                </Text>
                {/* Destructive + unrecoverable: always confirm. */}
                <Button size="xs" variant="light" color="amber" disabled={saving} onClick={() => setRotateDialogOpen(true)}>
                  Rotate password
                </Button>
              </Flex>
            )}
          </Flex>

          {freshPassword && (
            <Alert color="amber" variant="light">
              <Flex direction="column" gap="2">
                <span>New password (shown once):</span>
                <Copyable text={freshPassword} ariaLabel="Copy password" />
              </Flex>
            </Alert>
          )}

          <Separator />

          <InvitesPanel uid={doc.uid} />

          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}

          <Flex gap="2" justify="end">
            <Button variant="light" color="gray" onClick={() => setOpen(false)}>
              Close
            </Button>
          </Flex>
        </Flex>
      </Modal>
      <Modal
        opened={rotateDialogOpen}
        onClose={() => setRotateDialogOpen(false)}
        size="480px"
        title={(
          <Flex align="center" gap="2">
            <ExclamationTriangleIcon /> Rotate the document password?
          </Flex>
        )}
        withCloseButton={false}
      >
        <Text size="sm" mb="3">
          Rotating generates a brand-new password and invalidates every existing
          session on this document.
        </Text>
        <Flex direction="column" gap="2" mb="4">
          <Text size="sm" component="p">
            <b>Everyone</b> who has the current password — including users who already
            had this document open — will be prompted to re-enter it before they can
            read or write anything.
          </Text>
          <Text size="sm" component="p">
            The <b>new password is shown only once</b>, right after rotation. There is
            no way to recover it afterwards; you'll need to share it out of band with
            each person you want back in.
          </Text>
        </Flex>
        <Flex gap="2" justify="end">
          <Button variant="light" color="gray" onClick={() => setRotateDialogOpen(false)}>
            Cancel
          </Button>
          <Button
            color="amber"
            onClick={async () => {
              const rotated = await rotate();
              if (rotated) setRotateDialogOpen(false);
            }}
          >
            Rotate password
          </Button>
        </Flex>
      </Modal>
    </>
  );
}
