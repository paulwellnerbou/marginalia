import { useEffect, useState } from 'react';
import { Alert, Button, Flex, Modal, Text } from '@mantine/core';
import {
  ApiError,
  AUTH_REQUIRED_EVENT,
  authenticate,
  isAuthPending,
  notifyAuthCancelled,
  notifyAuthResolved,
} from '../lib/api.js';
import { reportError } from '../lib/log.js';
import { PasswordField } from './PasswordField.js';

/**
 * Listens for `marginalia:auth-required` from api.ts (fired on any
 * `401 password-required`). On submit re-authenticates and fires
 * `marginalia:auth-resolved`; on cancel fires `marginalia:auth-cancelled`
 * so queued requests reject instead of hanging. Mount once per doc view.
 */
export function PasswordPromptDialog({ docUid }: { docUid: string }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    function onAuthRequired(e: Event) {
      const detail = (e as CustomEvent<{ docUid: string }>).detail;
      if (detail?.docUid !== docUid) return;
      setError(null);
      setPassword('');
      setOpen(true);
    }
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    // AUTH_REQUIRED is dispatched synchronously, so a gate that armed
    // before this component mounted would be missed. Recover by
    // polling the gate state at mount.
    if (isAuthPending(docUid)) {
      setError(null);
      setPassword('');
      setOpen(true);
    }
    return () => {
      window.removeEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
      // Wake any in-flight auth-gate for this doc so navigating away
      // (or switching docUid) rejects the queued requests instead of
      // leaving them hanging on a dialog that no longer exists.
      // Harmless when no gate is pending — the event has no listener.
      notifyAuthCancelled(docUid);
    };
  }, [docUid]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    setSubmitting(true);
    setError(null);
    try {
      await authenticate(docUid, password);
      notifyAuthResolved(docUid);
      setOpen(false);
      setPassword('');
    } catch (err) {
      reportError('PasswordPromptDialog.submit', err);
      if (err instanceof ApiError && err.status === 401) {
        setError('Wrong password');
      } else {
        setError('Login failed');
      }
    } finally {
      setSubmitting(false);
    }
  }

  function handleOpenChange(next: boolean) {
    // Treat any close that wasn't a successful submit as a cancel: wake
    // queued requests with a 401 rejection so they don't hang forever.
    if (!next && open) {
      notifyAuthCancelled(docUid);
    }
    setOpen(next);
  }

  return (
    <Modal
      opened={open}
      onClose={() => handleOpenChange(false)}
      size="420px"
      title={<Text fw={600} size="lg">Password required</Text>}
    >
      <Text size="sm" c="dimmed" mb="4">
          This document is password-protected. Enter the password to continue.
      </Text>
      <form onSubmit={handleSubmit}>
        <Flex direction="column" gap="3">
          <PasswordField
            value={password}
            onChange={(e: any) => setPassword(e.target.value)}
            placeholder="Password"
            autoFocus
          />
          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}
          <Flex gap="2" justify="end">
            <Button type="button" variant="light" color="gray" disabled={submitting} onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !password}>
              {submitting ? 'Checking…' : 'Unlock'}
            </Button>
          </Flex>
          <Text size="xs" c="dimmed">
            The password was shown once when the document was created or rotated. Ask the doc
            admin if you don't have it.
          </Text>
        </Flex>
      </form>
    </Modal>
  );
}
