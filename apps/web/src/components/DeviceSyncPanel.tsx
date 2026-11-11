import { MobileIcon, Pencil1Icon, PlusIcon, TrashIcon, UpdateIcon } from '@radix-ui/react-icons';
import {
  Badge,
  Box,
  Button,
  Callout,
  Dialog,
  Flex,
  Separator,
  Text,
  TextField,
} from '@radix-ui/themes';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createKeyringPairing } from '../lib/api.js';
import {
  connectKeyring,
  deleteKeyring,
  disconnectKeyring,
  type Keyring,
  keyringLabel,
  listKeyrings,
  onKeyringChange,
  pairWithCode,
  renameProject,
  rotateKeyring,
} from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import { redeemErrorMessage } from '../lib/pairing-error.js';
import { AgentKeysPanel } from './AgentKeysPanel.js';
import { ArmedButton } from './ArmedButton.js';
import { Copyable } from './Copyable.js';
import { PairingQr } from './PairingQr.js';

/**
 * "Your documents" is a per-browser list, which is the right default and
 * the wrong answer as soon as someone owns a laptop and a phone. This
 * panel is the opt-in: a keyring, carried to another device by a code
 * that expires in minutes — and, for someone working for several
 * clients, one keyring per client ("project"), each with its own
 * devices and agent keys.
 *
 * No keyring token is ever rendered anywhere in this component. Each one
 * stands in for every access link it holds, so it is the one secret in
 * the app that should never be on screen to be photographed, pasted into
 * a chat, or read over someone's shoulder.
 */
export function DeviceSyncPanel({
  onSynced,
  dropped = [],
  onDismissDropped,
  idleTtlMs = null,
}: {
  onSynced: () => void;
  /** Labels of rings the last pull found gone, so syncing them switched itself off. */
  dropped?: string[];
  onDismissDropped?: () => void;
  /** Server's idle-expiry window, so the copy below can name it. */
  idleTtlMs?: number | null;
}) {
  const [rings, setRings] = useState<Keyring[]>(() => listKeyrings());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState<{
    code: string;
    expires_at: number;
    ring: Keyring;
  } | null>(null);

  useEffect(() => onKeyringChange(setRings), []);

  const several = rings.length > 1;

  async function connect() {
    setError(null);
    setBusy(true);
    try {
      const ring = await connectKeyring();
      onSynced();
      await openPairing(ring);
    } catch (err) {
      reportError('DeviceSyncPanel.connect', err);
      setError('Could not turn on syncing. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  async function openPairing(ring: Keyring) {
    setError(null);
    try {
      setPairing({ ...(await createKeyringPairing(ring.token)), ring });
    } catch (err) {
      reportError('DeviceSyncPanel.pair', err);
      setError('Could not create a pairing code.');
    }
  }

  const droppedNotice = dropped.length > 0 && (
    <Callout.Root color="amber" size="1" mt="3">
      <Callout.Text>
        {droppedSentence(dropped, rings.length > 0)} It may have been deleted or replaced from
        another device, or removed after going unused. Nothing you can open has changed — every
        document on this device still works. Pair again below to resume.
      </Callout.Text>
      {onDismissDropped && (
        <Flex justify="end" mt="2">
          <Button size="1" variant="soft" color="gray" onClick={onDismissDropped}>
            Dismiss
          </Button>
        </Flex>
      )}
    </Callout.Root>
  );

  const pairingDialog = (
    <PairingDialog
      pairing={pairing}
      several={several}
      onOpenChange={(open) => {
        if (!open) setPairing(null);
      }}
    />
  );

  if (!rings.length) {
    return (
      <Box className="device-sync">
        <Flex justify="between" align="start" gap="3" wrap="wrap">
          <Box style={{ flex: '1 1 20rem', minWidth: 0 }}>
            <Text size="2" weight="medium" as="p" mb="1">
              Your devices
            </Text>
            <Text size="2" color="gray" as="p">
              Turn this on to see the same documents here, on your phone, and in the installed app —
              without pasting a link for each one.
            </Text>
          </Box>
          <Button onClick={connect} loading={busy}>
            <MobileIcon /> Sync my devices
          </Button>
        </Flex>

        {droppedNotice}

        <Separator size="4" my="3" />
        <JoinByCode onPaired={onSynced} />

        {error && (
          <Callout.Root color="red" size="1" mt="3">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
        {pairingDialog}
      </Box>
    );
  }

  return (
    <Box className="device-sync device-sync--connected">
      <Flex align="center" gap="2" mb="1">
        <Text size="2" weight="medium">
          {several ? 'Your projects' : 'Your devices'}
        </Text>
        <Badge color="green" variant="soft">
          Syncing
        </Badge>
      </Flex>
      <Text size="2" color="gray" as="p">
        {several
          ? 'Each project is a list of documents of its own, with its own devices and agent keys. Pairing a device or connecting an agent gives it one project, never the others.'
          : 'This browser shares one list of documents with your other devices. New documents and refreshed access links travel between them on their own.'}
      </Text>

      {droppedNotice}

      {rings.map((ring) => (
        <ProjectSection
          key={ring.id}
          ring={ring}
          several={several}
          onPair={() => void openPairing(ring)}
          onPairingVoid={() => setPairing((p) => (p?.ring.id === ring.id ? null : p))}
        />
      ))}

      <Separator size="4" my="3" />
      <NewProject onCreated={onSynced} first={!several} />

      <Separator size="4" my="3" />
      <JoinByCode onPaired={onSynced} joining />

      {idleTtlMs !== null && (
        <Text size="1" color="gray" as="p" mt="3">
          Left unused on every device for {formatIdleWindow(idleTtlMs)}, a keyring is removed on its
          own. The documents on each device stay where they are.
        </Text>
      )}

      {error && (
        <Callout.Root color="red" size="1" mt="3">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
      {pairingDialog}
    </Box>
  );
}

function droppedSentence(labels: string[], othersLeft: boolean): string {
  if (!othersLeft && labels.length === 1 && labels[0] === keyringLabel({ label: null })) {
    return 'Syncing stopped here: the keyring this browser was using no longer exists.';
  }
  const names = labels.map((l) => `“${l}”`).join(', ');
  return labels.length === 1
    ? `Syncing stopped here for ${names}: its keyring no longer exists.`
    : `Syncing stopped here for ${names}: their keyrings no longer exist.`;
}

/**
 * One ring: its name, a way to add a device, and — behind "Manage" once
 * there are several — its agents and the ways to leave or end it.
 */
function ProjectSection({
  ring,
  several,
  onPair,
  onPairingVoid,
}: {
  ring: Keyring;
  several: boolean;
  onPair: () => void;
  /** A code shown for this ring stops being worth showing. */
  onPairingVoid: () => void;
}) {
  const [open, setOpen] = useState(!several);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  // One project shows everything; among several, each opens on request.
  useEffect(() => {
    setOpen(!several);
  }, [several]);

  async function rotate() {
    setError(null);
    setBusy(true);
    try {
      await rotateKeyring(ring.id);
      onPairingVoid();
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
      await deleteKeyring(ring.id);
      onPairingVoid();
    } catch (err) {
      reportError('DeviceSyncPanel.delete', err);
      setError('Could not delete the keyring. Nothing was removed — try again.');
    } finally {
      setBusy(false);
    }
  }

  const name = keyringLabel(ring);

  return (
    <Box className={several ? 'device-sync-project' : undefined} mt="3">
      <Flex justify="between" align="center" gap="3" wrap="wrap">
        {several || ring.label ? (
          <Flex align="center" gap="2" style={{ minWidth: 0 }}>
            <Text
              size="2"
              weight="medium"
              truncate
              {...(ring.label ? {} : { color: 'gray' as const })}
            >
              {name}
            </Text>
            <Button
              size="1"
              variant="ghost"
              color="gray"
              onClick={() => setRenaming(true)}
              aria-label={`Rename ${name}`}
            >
              <Pencil1Icon />
            </Button>
          </Flex>
        ) : (
          <span />
        )}
        <Flex gap="2" align="center" wrap="wrap">
          <Button variant="soft" onClick={onPair} disabled={busy}>
            <MobileIcon /> Add a device
          </Button>
          {several && (
            <Button
              variant="ghost"
              color="gray"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
            >
              {open ? 'Close' : 'Manage'}
            </Button>
          )}
        </Flex>
      </Flex>

      {open && (
        <>
          <Separator size="4" my="3" />
          <AgentKeysPanel ring={ring} several={several} />

          <Separator size="4" my="3" />
          <Flex gap="3" align="center" wrap="wrap" justify="between">
            <Text size="1" color="gray">
              Lost a device, or shared a code by mistake? Replacing the keyring disconnects every
              device but this one and revokes its agent keys. Your documents and their access links
              are unaffected.
            </Text>
            <Flex gap="2">
              <ArmedButton
                label="Replace keyring"
                confirmLabel="Disconnect devices and agents"
                color="amber"
                icon={<UpdateIcon />}
                onConfirm={rotate}
                disabled={busy}
              />
              <Button
                variant="soft"
                color="gray"
                onClick={() => {
                  disconnectKeyring(ring.id);
                  onPairingVoid();
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
              {several ? 'Done with this project everywhere?' : 'Done with syncing everywhere?'}{' '}
              Deleting the keyring stops every device, revokes its agent keys, and removes the
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

      <RenameDialog ring={renaming ? ring : null} onClose={() => setRenaming(false)} />
    </Box>
  );
}

/**
 * Start another ring, for a client whose documents should stay apart
 * from the rest. Next to the only ring, it also names that one, since
 * "Unnamed project" beside "Acme" tells nobody which is which.
 */
function NewProject({ onCreated, first }: { onCreated: () => void; first: boolean }) {
  const [label, setLabel] = useState('');
  const [existingLabel, setExistingLabel] = useState('');
  const [opened, setOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const only = first ? (listKeyrings()[0] ?? null) : null;
  const needsName = !!only && !only.label;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const name = label.trim();
    if (!name || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (needsName && only && existingLabel.trim()) {
        await renameProject(only.id, existingLabel);
      }
      await connectKeyring(name);
      setLabel('');
      setExistingLabel('');
      setOpened(false);
      onCreated();
    } catch (err) {
      reportError('DeviceSyncPanel.newProject', err);
      setError('Could not create the project. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!opened) {
    return (
      <Flex gap="3" align="center" wrap="wrap" justify="between">
        <Text size="1" color="gray">
          {first
            ? 'Working for several clients? Give each one a project of its own: its documents, devices and agents stay apart from the others.'
            : 'Another client? Start a project for it.'}
        </Text>
        <Button variant="soft" color="gray" onClick={() => setOpened(true)}>
          <PlusIcon /> New project
        </Button>
      </Flex>
    );
  }

  return (
    <form onSubmit={submit}>
      <Flex direction="column" gap="2">
        {needsName && (
          <Box>
            <Text as="label" htmlFor="project-existing-label" size="1" color="gray" mb="1">
              Name for the documents you already sync (optional)
            </Text>
            <TextField.Root
              id="project-existing-label"
              value={existingLabel}
              onChange={(e) => setExistingLabel(e.target.value)}
              placeholder="e.g. Personal"
              maxLength={60}
              disabled={busy}
            />
          </Box>
        )}
        <Box>
          <Text as="label" htmlFor="project-new-label" size="1" color="gray" mb="1">
            New project
          </Text>
          <TextField.Root
            id="project-new-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Acme"
            maxLength={60}
            autoFocus
            disabled={busy}
          />
        </Box>
        <Text size="1" color="gray">
          It starts empty. Move documents into it from their cards, or create them while it is
          selected.
        </Text>
        <Flex gap="2" justify="end">
          <Button type="button" variant="soft" color="gray" onClick={() => setOpened(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={!label.trim()}>
            Create project
          </Button>
        </Flex>
      </Flex>
      {error && (
        <Callout.Root color="red" size="1" mt="2">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
    </form>
  );
}

function RenameDialog({ ring, onClose }: { ring: Keyring | null; onClose: () => void }) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ring) {
      setDraft(ring.label ?? '');
      setError(null);
    }
  }, [ring]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!ring) return;
    setBusy(true);
    setError(null);
    try {
      await renameProject(ring.id, draft);
      onClose();
    } catch (err) {
      reportError('DeviceSyncPanel.rename', err);
      setError('Could not rename the project.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root open={ring !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Content maxWidth="24rem">
        <Dialog.Title>Rename project</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          The name shows on every device that syncs this project.
        </Dialog.Description>
        <form onSubmit={submit}>
          <TextField.Root
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={60}
            autoFocus
            aria-label="Project name"
          />
          {error && (
            <Callout.Root color="red" size="1" mt="2">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}
          <Flex gap="2" justify="end" mt="4">
            <Dialog.Close>
              <Button type="button" variant="soft" color="gray">
                Cancel
              </Button>
            </Dialog.Close>
            <Button type="submit" loading={busy}>
              Save
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * The receiving end of a pairing code, on the home page.
 *
 * `/k` has carried this field all along, but nothing linked to it, so the
 * only way in was knowing the URL — which makes "or open Marginalia there
 * and enter the code" advice nobody can follow. A device that has just
 * been handed a code is by definition a device with an empty document
 * list, and this panel is the first thing on it that mentions devices.
 *
 * No success state of its own: redeeming stores the token, which flips
 * the whole panel to connected and repopulates the list behind it.
 */
function JoinByCode({
  onPaired,
  joining = false,
}: {
  onPaired: () => void;
  /** This browser already syncs, so a code adds a project to it. */
  joining?: boolean;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `busy` disables the button, but only once React has re-rendered — two
  // submits in one tick both read it as false. That spends a single-use
  // code twice and reports the working one as invalid, which is the worst
  // failure this form has. The ref closes the window synchronously.
  const inFlight = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const entered = code.trim();
    if (!entered || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      await pairWithCode(entered);
      setCode('');
      onPaired();
    } catch (err) {
      reportError('DeviceSyncPanel.pairWithCode', err);
      setError(redeemErrorMessage(err));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <Box>
      <Text size={joining ? '1' : '2'} color="gray" as="p" mb="2">
        {joining ? (
          <>
            A project syncing on another device? Open <strong>Add a device</strong> for it there and
            enter the code it shows. It is added next to the ones here.
          </>
        ) : (
          <>
            Already syncing on another device? Open <strong>Add a device</strong> there and enter
            the code it shows.
          </>
        )}
      </Text>
      <form onSubmit={submit}>
        <Flex gap="2" align="start" wrap="wrap">
          <TextField.Root
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              if (error) setError(null);
            }}
            placeholder="ABCD-EFGH"
            aria-label="Pairing code"
            spellCheck={false}
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="one-time-code"
            disabled={busy}
            style={{ flex: '0 1 12rem', fontFamily: 'var(--code-font-family)' }}
          />
          <Button type="submit" variant="soft" loading={busy}>
            Pair
          </Button>
        </Flex>
      </form>
      {error && (
        <Callout.Root color="red" size="1" mt="2">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}
    </Box>
  );
}

function PairingDialog({
  pairing,
  several,
  onOpenChange,
}: {
  pairing: { code: string; expires_at: number; ring: Keyring } | null;
  several: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remaining = useCountdown(pairing?.expires_at ?? null);
  const pairUrl = pairing ? `${window.location.origin}/k/${pairing.code}` : '';

  return (
    <Dialog.Root open={pairing !== null} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="26rem" className="dialog-content--fixed-footer">
        <div className="dialog-scroll-body">
          <Dialog.Title>
            {several && pairing
              ? `Add a device to “${keyringLabel(pairing.ring)}”`
              : 'Add a device'}
          </Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="4">
            Scan this on the other device, or open Marginalia there and enter the code.
          </Dialog.Description>

          {pairing && (
            <Flex direction="column" align="center" gap="3">
              <PairingQr value={pairUrl} ariaLabel="Pairing QR code" />
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
              Anyone who uses this code gets{' '}
              {several ? 'every document in this project' : 'your whole document list'}, including
              the ones you administer. Only scan it on a device you own.
            </Callout.Text>
          </Callout.Root>
        </div>

        <Flex className="dialog-footer" justify="end" mt="4">
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

/**
 * The idle window in words. Rounded hard on purpose — this is a "you have
 * ages" reassurance, and a precise "180 days" invites the reading that
 * something is being counted down.
 */
function formatIdleWindow(ms: number): string {
  const days = Math.max(1, Math.round(ms / 86_400_000));
  if (days < 60) return days === 1 ? 'a day' : `${days} days`;
  const months = Math.round(days / 30);
  return months >= 12 && months % 12 === 0
    ? `${months / 12 === 1 ? 'a year' : `${months / 12} years`}`
    : `${months} months`;
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
