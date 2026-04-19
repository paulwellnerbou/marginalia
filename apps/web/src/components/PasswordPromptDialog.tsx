import { useEffect, useState } from 'react';
import { Button, Callout, Dialog, Flex, Text } from '@radix-ui/themes';
import {
  ApiError,
  AUTH_REQUIRED_EVENT,
  authenticate,
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
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Content maxWidth="420px">
        <Dialog.Title>Password required</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          This document is password-protected. Enter the password to continue.
        </Dialog.Description>
        <form onSubmit={handleSubmit}>
          <Flex direction="column" gap="3">
            <PasswordField
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
            />
            {error && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}
            <Flex gap="2" justify="end">
              <Dialog.Close>
                <Button type="button" variant="soft" color="gray" disabled={submitting}>
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={submitting || !password}>
                {submitting ? 'Checking…' : 'Unlock'}
              </Button>
            </Flex>
            <Text size="1" color="gray">
              The password was shown once when the document was created or rotated. Ask the doc
              admin if you don't have it.
            </Text>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
