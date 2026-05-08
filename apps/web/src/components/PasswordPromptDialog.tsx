import { Button, Callout, Checkbox, Dialog, Flex, Text } from '@radix-ui/themes';
import { useEffect, useState } from 'react';
import {
  ApiError,
  AUTH_REQUIRED_EVENT,
  authenticate,
  isAuthPending,
  notifyAuthCancelled,
  notifyAuthResolved,
  recoverCurrentPassword,
} from '../lib/api.js';
import { loadInviteToken } from '../lib/invite.js';
import { reportError } from '../lib/log.js';
import {
  browserPasswordManagerUsername,
  clearSavedPassword,
  loadRememberLoginPreference,
  loadSavedPassword,
  saveRememberLoginPreference,
  saveSavedPassword,
} from '../lib/passwords.js';
import { PasswordField } from './PasswordField.js';

/**
 * Listens for `marginalia:auth-required` from api.ts (fired on any
 * `401 password-required`). On submit re-authenticates and fires
 * `marginalia:auth-resolved`; on cancel fires `marginalia:auth-cancelled`
 * so queued requests reject instead of hanging. Mount once per doc view.
 */
export function PasswordPromptDialog({
  docUid,
  docName,
}: {
  docUid: string;
  docName?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [rememberPassword, setRememberPassword] = useState<boolean>(
    () => !!loadSavedPassword(docUid),
  );
  const [rememberLogin, setRememberLogin] = useState<boolean>(() => loadRememberLoginPreference());
  const [canTryAdminRecovery, setCanTryAdminRecovery] = useState<boolean>(
    () => !!loadInviteToken(docUid),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: preparePrompt is a render-local function declaration; listing it would re-bind the listener every render. The body only depends on docUid via the freshly captured closure.
  useEffect(() => {
    function onAuthRequired(e: Event) {
      const detail = (e as CustomEvent<{ docUid: string }>).detail;
      if (detail?.docUid !== docUid) return;
      void preparePrompt();
    }
    window.addEventListener(AUTH_REQUIRED_EVENT, onAuthRequired);
    // AUTH_REQUIRED is dispatched synchronously, so a gate that armed
    // before this component mounted would be missed. Recover by
    // polling the gate state at mount.
    if (isAuthPending(docUid)) {
      void preparePrompt();
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

  async function preparePrompt() {
    const savedPassword = loadSavedPassword(docUid);
    const nextRememberLogin = loadRememberLoginPreference();
    setError(null);
    setRememberPassword(!!savedPassword);
    setRememberLogin(nextRememberLogin);
    setCanTryAdminRecovery(!!loadInviteToken(docUid));
    setPassword(savedPassword ?? '');
    setOpen(true);
    if (savedPassword) {
      await unlockWithPassword(savedPassword, {
        rememberDevicePassword: true,
        rememberSession: nextRememberLogin,
        auto: true,
      });
    }
  }

  async function unlockWithPassword(
    candidate: string,
    opts: { auto?: boolean; rememberDevicePassword: boolean; rememberSession: boolean },
  ) {
    setSubmitting(true);
    setError(null);
    try {
      await authenticate(docUid, candidate, { remember: opts.rememberSession });
      saveRememberLoginPreference(opts.rememberSession);
      if (opts.rememberDevicePassword) saveSavedPassword(docUid, candidate);
      else clearSavedPassword(docUid);
      notifyAuthResolved(docUid);
      setOpen(false);
      setPassword('');
    } catch (err) {
      reportError('PasswordPromptDialog.unlock', err, { docUid, auto: opts.auto === true });
      if (opts.auto) {
        clearSavedPassword(docUid);
        setRememberPassword(false);
        setPassword('');
      }
      if (err instanceof ApiError && err.status === 401) {
        setError(
          opts.auto
            ? 'The saved password on this device is out of date. Enter the current password.'
            : 'Wrong password',
        );
      } else {
        setError('Login failed');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) return;
    await unlockWithPassword(password, {
      rememberDevicePassword: rememberPassword,
      rememberSession: rememberLogin,
    });
  }

  async function handleRecoverWithAdminLink() {
    setSubmitting(true);
    setError(null);
    try {
      const result = await recoverCurrentPassword(docUid);
      setPassword(result.password);
      await unlockWithPassword(result.password, {
        rememberDevicePassword: rememberPassword,
        rememberSession: rememberLogin,
      });
    } catch (err) {
      reportError('PasswordPromptDialog.recover', err, { docUid });
      if (err instanceof ApiError && err.code === 'password-unavailable') {
        setError(
          'This document was password-protected before recovery was added. Rotate the password once to enable future recovery.',
        );
      } else if (err instanceof ApiError && err.status === 403) {
        setError(
          'This browser does not have the admin link needed to reveal the current password.',
        );
      } else {
        setError('Could not recover the password with the current admin link.');
      }
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
      <Dialog.Content maxWidth="460px">
        <Dialog.Title>Password required</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          This document is password-protected. Enter the password to continue.
        </Dialog.Description>
        <form onSubmit={handleSubmit}>
          <Flex direction="column" gap="3">
            <input
              className="sr-only"
              tabIndex={-1}
              aria-hidden="true"
              autoComplete="username"
              name="username"
              readOnly
              value={browserPasswordManagerUsername(docUid, docName)}
            />
            <PasswordField
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              autoFocus
              autoComplete="current-password"
              name="document-password"
            />
            <Text as="label" size="2">
              <Flex align="center" gap="2">
                <Checkbox
                  checked={rememberPassword}
                  onCheckedChange={(checked) => setRememberPassword(checked === true)}
                />
                Remember password on this device
              </Flex>
            </Text>
            <Text as="label" size="2">
              <Flex align="center" gap="2">
                <Checkbox
                  checked={rememberLogin}
                  onCheckedChange={(checked) => setRememberLogin(checked === true)}
                />
                Remember login on this browser
              </Flex>
            </Text>
            {error && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{error}</Callout.Text>
              </Callout.Root>
            )}
            <Flex gap="2" justify="end" wrap="wrap">
              {canTryAdminRecovery && (
                <Button
                  type="button"
                  variant="soft"
                  disabled={submitting}
                  onClick={() => void handleRecoverWithAdminLink()}
                >
                  Reveal with admin link
                </Button>
              )}
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
              Ask the document admin if you don&apos;t have the password. Admin browsers that still
              have the admin link can reveal the current password without rotating it.
            </Text>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
