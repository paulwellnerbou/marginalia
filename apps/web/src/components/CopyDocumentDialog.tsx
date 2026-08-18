import { CopyIcon } from '@radix-ui/react-icons';
import {
  Box,
  Button,
  Callout,
  Checkbox,
  Dialog,
  Flex,
  IconButton,
  RadioCards,
  Text,
  TextField,
} from '@radix-ui/themes';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CopyDocumentResponse, CopyMode, Document } from '../lib/api.js';
import { copyDocument } from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { documentTitle } from '../lib/doc-title.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { saveInviteToken } from '../lib/invite.js';
import { pushDoc as keyringPushDoc } from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import { recordVisit } from '../lib/recent-docs.js';
import { Copyable } from './Copyable.js';
import { PasswordDisclosureCard } from './PasswordDisclosureCard.js';

/**
 * Fork this document into a new one, either carrying its whole working
 * life across — history, threads, comments, proposals — or taking only
 * the text as it stands right now.
 *
 * Admin-only, like the gear and Access control it sits beside, because
 * the roster is copyable from here.
 */
export function CopyDocumentDialog({ doc }: { doc: Document }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [includeAccess, setIncludeAccess] = useState(false);
  const [mode, setMode] = useState<CopyMode>('full');
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CopyDocumentResponse | null>(null);

  const defaultName = `${documentTitle(doc)} - Copy`;
  const copyName = name.trim() || defaultName;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const displayName = getDisplayName();
    if (!displayName) {
      setError('Please set your display name first.');
      return;
    }
    setCopying(true);
    setError(null);
    try {
      const res = await copyDocument(
        doc.uid,
        { name: copyName, include_access: includeAccess, mode },
        { clientId: getClientId(), displayName },
      );
      const title = res.name ?? copyName;
      // The copy's admin token is the only way back into it with full
      // control, and this response is the only time we are handed it.
      // Persist and sync it before anything else can throw.
      saveInviteToken(res.uid, res.admin_invite.token);
      keyringPushDoc(res.uid, res.admin_invite.token, title);
      recordVisit({
        uid: res.uid,
        title,
        role: 'admin',
        password_protected: !!res.password,
        format: res.format,
        visited_at: Date.now(),
        updated_at: Date.now(),
        invite_token: res.admin_invite.token,
      });
      setCreated(res);
    } catch (err) {
      reportError('CopyDocumentDialog.copy', err, { uid: doc.uid });
      setError(apiErrorMessage(err, 'Could not copy this document'));
    } finally {
      setCopying(false);
    }
  }

  function reset() {
    setName('');
    setIncludeAccess(false);
    setMode('full');
    setCopying(false);
    setError(null);
    setCreated(null);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Closing mid-copy (Escape, click outside) does not cancel the
        // request, so clearing `copying` here would re-enable the submit
        // button for anyone who reopens before it lands — one stray
        // Escape, and they make two documents. Keep the state; the
        // request's own `finally` settles it, and reopening shows either
        // the disabled form or the copy that meanwhile succeeded.
        if (!next && !copying) reset();
      }}
    >
      <Dialog.Trigger>
        <IconButton variant="soft" size="2" aria-label="Copy document" title="Copy document">
          <CopyIcon />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Content size="3" maxWidth="640px" className="dialog-content--fixed-footer">
        {created ? (
          <>
            <div className="dialog-scroll-body">
              <Dialog.Title>Copy created</Dialog.Title>
              <Dialog.Description size="2" color="gray" mb="4">
                Bookmark the admin link below — it's the only way back into the copy with full
                control.
              </Dialog.Description>
              <Flex direction="column" gap="3">
                <Box className="created-admin-link">
                  <Text as="div" size="1" color="gray" mb="1">
                    Admin link
                  </Text>
                  <Copyable
                    text={window.location.origin + created.admin_invite.url}
                    multiline
                    ariaLabel="Copy admin link"
                  />
                </Box>
                {created.password && (
                  <PasswordDisclosureCard
                    docUid={created.uid}
                    password={created.password}
                    label="Password"
                    docName={created.name}
                  />
                )}
                {includeAccess && (
                  <Callout.Root color="amber" size="1">
                    <Callout.Text>
                      The copy has its own access links — each person's role came across, but the
                      links themselves are new. Share them from Access control; the originals still
                      only open the source document.
                    </Callout.Text>
                  </Callout.Root>
                )}
              </Flex>
            </div>
            <Flex className="dialog-footer" gap="2" justify="end" mt="4">
              <Dialog.Close>
                <Button variant="soft" color="gray">
                  Stay here
                </Button>
              </Dialog.Close>
              <Button onClick={() => navigate(`/d/${created.uid}/${created.admin_invite.token}`)}>
                Open the copy
              </Button>
            </Flex>
          </>
        ) : (
          <form className="dialog-form-layout" onSubmit={submit}>
            <div className="dialog-scroll-body">
              <Dialog.Title>Copy document</Dialog.Title>
              <Dialog.Description size="2" color="gray" mb="4">
                Creates a second document from this one. It gets its own URL and its own admin link;
                nothing you do to it touches this one.
              </Dialog.Description>

              <Flex direction="column" gap="4">
                <Flex direction="column" gap="2">
                  <Text as="div" size="2" weight="medium">
                    What to copy
                  </Text>
                  {/* Cards rather than a toggle: the two differ in what
                      they leave behind, and a copy cannot be undone, so
                      both descriptions stay on screen to be compared
                      instead of alternating as the choice changes. */}
                  <RadioCards.Root
                    size="1"
                    columns={{ initial: '1', sm: '2' }}
                    value={mode}
                    onValueChange={(v) => setMode(v as CopyMode)}
                    aria-label="What to copy"
                  >
                    {/* Named explicitly, or the card's whole text becomes
                        the accessible name and a screen reader reads the
                        title and the description as one run-on phrase. */}
                    <RadioCards.Item
                      value="full"
                      aria-label="Copy with history"
                      aria-describedby="copy-mode-full-hint"
                    >
                      <Flex direction="column" gap="1" align="start">
                        <Text size="2" weight="medium">
                          Copy with history
                        </Text>
                        <Text size="1" color="gray" id="copy-mode-full-hint">
                          Every thread, comment and edit proposal comes across, open or settled,
                          along with the document's full revision history.
                        </Text>
                      </Flex>
                    </RadioCards.Item>
                    <RadioCards.Item
                      value="clean"
                      aria-label="Clean copy"
                      aria-describedby="copy-mode-clean-hint"
                    >
                      <Flex direction="column" gap="1" align="start">
                        <Text size="2" weight="medium">
                          Clean copy
                        </Text>
                        <Text size="1" color="gray" id="copy-mode-clean-hint">
                          Only the text as it stands now. The history is cut and the discussion is
                          left behind.
                        </Text>
                      </Flex>
                    </RadioCards.Item>
                  </RadioCards.Root>
                </Flex>

                <Flex direction="column" gap="1">
                  <Text as="label" size="2" weight="medium" htmlFor="copy-doc-name">
                    Name of the copy
                  </Text>
                  <TextField.Root
                    id="copy-doc-name"
                    size="2"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={defaultName}
                    maxLength={200}
                    autoFocus
                  />
                </Flex>

                <Flex direction="column" gap="2">
                  <Text as="label" size="2">
                    <Flex align="center" gap="2">
                      <Checkbox
                        checked={includeAccess}
                        disabled={copying}
                        onCheckedChange={(c) => setIncludeAccess(c === true)}
                      />
                      Include access and roles
                    </Flex>
                  </Text>
                  <Text size="1" color="gray">
                    {includeAccess
                      ? "Everyone's role and name carry over, as freshly minted access links — the originals keep opening this document only, so you hand the new ones out yourself."
                      : "You are the copy's only member. Nobody reaches it until you invite them."}
                  </Text>
                </Flex>

                {doc.password_protected && (
                  <Callout.Root color="amber" size="1">
                    <Callout.Text>
                      The copy is password-protected too, with a new password shown once after
                      copying. Only the password's hash is stored, so this one cannot travel.
                    </Callout.Text>
                  </Callout.Root>
                )}

                {error && (
                  <Callout.Root color="red" size="1">
                    <Callout.Text>{error}</Callout.Text>
                  </Callout.Root>
                )}
              </Flex>
            </div>
            <Flex className="dialog-footer" gap="2" justify="end" mt="4">
              <Dialog.Close>
                <Button variant="soft" color="gray" type="button">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button type="submit" disabled={copying}>
                {copying ? 'Copying…' : 'Copy document'}
              </Button>
            </Flex>
          </form>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
