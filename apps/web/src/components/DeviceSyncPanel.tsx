import { MobileIcon, TrashIcon, UpdateIcon } from '@radix-ui/react-icons';
import { Badge, Box, Button, Callout, Dialog, Flex, Separator, Text } from '@radix-ui/themes';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { createKeyringPairing } from '../lib/api.js';
import {
  connectKeyring,
  deleteKeyring,
  disconnectKeyring,
  hasKeyring,
  loadKeyringToken,
  onKeyringChange,
  rotateKeyring,
} from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import { Copyable } from './Copyable.js';
import { PairingQr } from './PairingQr.js';

/**
 * "Your documents" is a per-browser list, which is the right default and
 * the wrong answer as soon as someone owns a laptop and a phone. This
 * panel is the opt-in: one keyring, carried to another device by a code
 * that expires in minutes.
 *
 * The keyring token itself is never rendered anywhere in this component.
 * It stands in for every access link it holds, so it is the one secret in
 * the app that should never be on screen to be photographed, pasted into
 * a chat, or read over someone's shoulder.
 */
export function DeviceSyncPanel({ onSynced }: { onSynced: () => void }) {
  const [connected, setConnected] = useState(() => hasKeyring());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{ code: string; expires_at: number } | null>(null);

  useEffect(() => onKeyringChange((token) => setConnected(token !== null)), []);

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      await connectKeyring();
      onSynced();
      await openPairing();
    } catch (err) {
      reportError('DeviceSyncPanel.connect', err);
      setError('Could not turn on syncing. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  const openPairing = useCallback(async () => {
    const token = loadKeyringToken();
    if (!token) return;
    setError(null);
    try {
      setPairing(await createKeyringPairing(token));
    } catch (err) {
      reportError('DeviceSyncPanel.pair', err);
      setError('Could not create a pairing code.');
    }
  }, []);

  async function rotate() {
    setError(null);
    setBusy(true);
    try {
      await rotateKeyring();
      setPairing(null);
    } catch (err) {
      reportError('DeviceSyncPanel.rotate', err);
      setError('Could not replace the keyring.');
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    setError(null);
    setBusy(true);
    try {
      await deleteKeyring();
      setPairing(null);
    } catch (err) {
      reportError('DeviceSyncPanel.delete', err);
      setError('Could not delete the keyring. Nothing was removed — try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box className={`device-sync ${connected ? 'device-sync--connected' : ''}`}>
      <Flex justify="between" align="start" gap="3" wrap="wrap">
        <Box style={{ flex: '1 1 20rem', minWidth: 0 }}>
          <Flex align="center" gap="2" mb="1">
            <Text size="2" weight="medium">
              Your devices
            </Text>
            {connected && (
              <Badge color="green" variant="soft">
                Syncing
              </Badge>
            )}
          </Flex>
          <Text size="2" color="gray" as="p">
            {connected
              ? 'This browser shares one list of documents with your other devices. New documents and refreshed access links travel between them on their own.'
              : 'Turn this on to see the same documents here, on your phone, and in the installed app — without pasting a link for each one.'}
          </Text>
        </Box>
        <Flex gap="2" align="center" wrap="wrap">
          {connected ? (
            <Button variant="soft" onClick={openPairing} disabled={busy}>
              <MobileIcon /> Add a device
            </Button>
          ) : (
            <Button onClick={connect} loading={busy}>
              <MobileIcon /> Sync my devices
            </Button>
          )}
        </Flex>
      </Flex>

      {connected && (
        <>
          <Separator size="4" my="3" />
          <Flex gap="3" align="center" wrap="wrap" justify="between">
            <Text size="1" color="gray">
              Lost a device, or shared a code by mistake? Replacing the keyring disconnects every
              device but this one. Your documents and their access links are unaffected.
            </Text>
            <Flex gap="2">
              <ArmedButton
                label="Replace keyring"
                confirmLabel="Disconnect other devices"
                color="amber"
                icon={<UpdateIcon />}
                onConfirm={rotate}
                disabled={busy}
              />
              <Button
                variant="soft"
                color="gray"
                onClick={() => {
                  disconnectKeyring();
                  setPairing(null);
                }}
                disabled={busy}
              >
                Stop syncing here
              </Button>
            </Flex>
          </Flex>

          <Separator size="4" my="3" />
          <Flex gap="3" align="center" wrap="wrap" justify="between">
            <Text size="1" color="gray">
              Done with syncing everywhere? Deleting the keyring stops every device and removes the
              server's copy of your access links. Each device keeps the documents it already has.
            </Text>
            <ArmedButton
              label="Delete keyring"
              confirmLabel="Delete it everywhere"
              color="red"
              icon={<TrashIcon />}
              onConfirm={destroy}
              disabled={busy}
            />
          </Flex>
        </>
      )}

      {error && (
        <Callout.Root color="red" size="1" mt="3">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      <PairingDialog
        pairing={pairing}
        onOpenChange={(open) => {
          if (!open) setPairing(null);
        }}
      />
    </Box>
  );
}

/**
 * Two-step confirm, local rather than ConfirmButton because that one is
 * an icon-only trash affordance: both actions here are consequential in
 * ways a trash can doesn't convey, and each has to say in words what the
 * second click actually does — one replaces a token, the other destroys
 * the ring.
 */
function ArmedButton({
  label,
  confirmLabel,
  color,
  icon,
  onConfirm,
  disabled,
}: {
  label: string;
  confirmLabel: string;
  color: 'amber' | 'red';
  icon: ReactNode;
  onConfirm: () => void | Promise<void>;
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

  useEffect(() => {
    if (disabled && armed) setArmed(false);
  }, [disabled, armed]);

  if (!armed) {
    return (
      <Button variant="soft" color={color} disabled={disabled} onClick={() => setArmed(true)}>
        {icon} {label}
      </Button>
    );
  }

  return (
    <Flex gap="2">
      <Button variant="soft" color="gray" onClick={() => setArmed(false)}>
        Cancel
      </Button>
      <Button
        variant="solid"
        color={color}
        disabled={disabled}
        onClick={() => {
          setArmed(false);
          void onConfirm();
        }}
      >
        {confirmLabel}
      </Button>
    </Flex>
  );
}

function PairingDialog({
  pairing,
  onOpenChange,
}: {
  pairing: { code: string; expires_at: number } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const remaining = useCountdown(pairing?.expires_at ?? null);
  const pairUrl = pairing ? `${window.location.origin}/k/${pairing.code}` : '';

  return (
    <Dialog.Root open={pairing !== null} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="26rem">
        <Dialog.Title>Add a device</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          Scan this on the other device, or open Marginalia there and enter the code.
        </Dialog.Description>

        {pairing && (
          <Flex direction="column" align="center" gap="3">
            <PairingQr value={pairUrl} />
            <Copyable text={pairing.code} size="3" ariaLabel="Copy pairing code" />
            <Text size="1" color={remaining === 0 ? 'red' : 'gray'}>
              {remaining === 0
                ? 'This code has expired — close and create a new one.'
                : `Expires in ${formatRemaining(remaining)}. It works once.`}
            </Text>
          </Flex>
        )}

        <Callout.Root color="amber" size="1" mt="4">
          <Callout.Text>
            Anyone who uses this code gets your whole document list, including the ones you
            administer. Only scan it on a device you own.
          </Callout.Text>
        </Callout.Root>

        <Flex justify="end" mt="4">
          <Dialog.Close>
            <Button variant="soft">Done</Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** Seconds left until `expiresAt`, ticking down. Null target → 0. */
function useCountdown(expiresAt: number | null): number {
  const [remaining, setRemaining] = useState(() => secondsUntil(expiresAt));
  const target = useRef(expiresAt);
  target.current = expiresAt;

  useEffect(() => {
    setRemaining(secondsUntil(expiresAt));
    if (expiresAt === null) return;
    const id = window.setInterval(() => {
      setRemaining(secondsUntil(target.current));
    }, 1000);
    return () => window.clearInterval(id);
  }, [expiresAt]);

  return remaining;
}

function secondsUntil(at: number | null): number {
  if (at === null) return 0;
  return Math.max(0, Math.round((at - Date.now()) / 1000));
}

function formatRemaining(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${mins}m` : `${mins}m ${String(rest).padStart(2, '0')}s`;
}
