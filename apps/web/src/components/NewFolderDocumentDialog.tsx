import { FilePlusIcon } from '@radix-ui/react-icons';
import {
  Button,
  Callout,
  Dialog,
  Flex,
  IconButton,
  SegmentedControl,
  Text,
  TextField,
} from '@radix-ui/themes';
import { useImperativeHandle, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Document, DocumentFormat } from '../lib/api.js';
import { createFolderDocument } from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { documentTitle } from '../lib/doc-title.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { loadInviteToken, saveInviteToken } from '../lib/invite.js';
import { reportError } from '../lib/log.js';
import { type FoldableDialogProps, returnFocusTo } from './foldedDialog.js';

/**
 * Start a document that belongs with this one — an outline beside a story.
 * It opens with the main document's links, password and roles, so there is
 * nothing to share afterwards: whoever can open the story can open this.
 *
 * Offered to admins and editors, the same people the server lets add one.
 */
export function NewFolderDocumentDialog({
  doc,
  ref,
  foldedInto,
}: { doc: Document } & FoldableDialogProps) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
  const [name, setName] = useState('');
  const [format, setFormat] = useState<DocumentFormat>(doc.format);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const main = doc.folder?.documents.find((d) => d.main);
  const mainTitle = !main || main.uid === doc.uid ? documentTitle(doc) : (main.title ?? 'Untitled');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give the document a name first.');
      return;
    }
    const displayName = getDisplayName();
    if (!displayName) {
      setError('Please set your display name first.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await createFolderDocument(
        doc.uid,
        { name: trimmed, format, source: starterSource(trimmed, format) },
        { clientId: getClientId(), displayName },
      );
      // The token that opened this document opens the new one too; stored
      // under its uid so the editor it lands in sends it.
      const token = loadInviteToken(doc.uid);
      if (token) saveInviteToken(res.uid, token);
      setOpen(false);
      reset();
      navigate(`/d/${res.uid}/edit`);
    } catch (err) {
      reportError('NewFolderDocumentDialog.create', err, { uid: doc.uid });
      setError(apiErrorMessage(err, 'Could not add the document'));
      setCreating(false);
    }
  }

  function reset() {
    setName('');
    setFormat(doc.format);
    setCreating(false);
    setError(null);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // As with Copy: a close mid-request must not re-arm the button.
        if (!next && !creating) reset();
      }}
    >
      {!foldedInto && (
        <Dialog.Trigger>
          <IconButton variant="soft" size="2" aria-label="Add a document" title="Add a document">
            <FilePlusIcon />
          </IconButton>
        </Dialog.Trigger>
      )}
      <Dialog.Content
        size="3"
        maxWidth="520px"
        className="dialog-content--fixed-footer"
        onCloseAutoFocus={returnFocusTo(foldedInto)}
      >
        <form className="dialog-form-layout" onSubmit={submit}>
          <div className="dialog-scroll-body">
            <Dialog.Title>Add a document</Dialog.Title>
            <Dialog.Description size="2" color="gray" mb="4">
              A new document that belongs with <b>{mainTitle}</b> — an outline, background notes, a
              chapter. It opens with the same links and password, and everyone keeps their role, so
              there is nothing new to share.
            </Dialog.Description>

            <Flex direction="column" gap="4">
              <Flex direction="column" gap="1">
                <Text as="label" size="2" weight="medium" htmlFor="folder-doc-name">
                  Name
                </Text>
                <TextField.Root
                  id="folder-doc-name"
                  size="2"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. OUTLINE"
                  maxLength={200}
                  autoFocus
                />
              </Flex>

              <Flex direction="column" gap="1">
                <Text as="div" size="2" weight="medium">
                  Format
                </Text>
                <SegmentedControl.Root
                  size="1"
                  value={format}
                  onValueChange={(v) => setFormat(v as DocumentFormat)}
                  aria-label="Format"
                >
                  <SegmentedControl.Item value="markdown">Markdown</SegmentedControl.Item>
                  <SegmentedControl.Item value="asciidoc">AsciiDoc</SegmentedControl.Item>
                </SegmentedControl.Root>
              </Flex>

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
            <Button type="submit" disabled={creating}>
              {creating ? 'Adding…' : 'Add and edit'}
            </Button>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/** A heading to start from, since a document cannot be empty. */
function starterSource(name: string, format: DocumentFormat): string {
  return format === 'asciidoc' ? `= ${name}\n` : `# ${name}\n`;
}
