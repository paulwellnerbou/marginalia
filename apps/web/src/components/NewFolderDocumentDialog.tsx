import { FilePlusIcon } from '@radix-ui/react-icons';
import { Button, Callout, Dialog, Flex, IconButton } from '@radix-ui/themes';
import { useImperativeHandle, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Document, DocumentFormat } from '../lib/api.js';
import { createFolderDocument } from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { documentTitle } from '../lib/doc-title.js';
import { loadInviteToken, saveInviteToken } from '../lib/invite.js';
import { reportError } from '../lib/log.js';
import { type FoldableDialogProps, returnFocusTo } from './foldedDialog.js';
import {
  DISPLAY_NAME_REQUIRED,
  NewDocumentFields,
  useNewDocumentFields,
} from './NewDocumentFields.js';

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
  const fields = useNewDocumentFields({ source: '', format: doc.format });
  const { format } = fields;
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const main = doc.folder?.documents.find((d) => d.main);
  const mainTitle = !main || main.uid === doc.uid ? documentTitle(doc) : (main.title ?? 'Untitled');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // The folder lists its documents by name, so the detected title is
    // sent as one rather than left for the server to derive.
    const name = fields.effectiveDocName;
    if (!name) {
      setError('Give the document a name, or content with a title of its own.');
      return;
    }
    const identity = fields.identityForSubmit();
    if (!identity) {
      setError(DISPLAY_NAME_REQUIRED);
      return;
    }
    const written = fields.source.trim().length > 0;
    setCreating(true);
    setError(null);
    try {
      const res = await createFolderDocument(
        doc.uid,
        { name, format, source: written ? fields.source : starterSource(name, format) },
        identity,
      );
      // The token that opened this document opens the new one too; stored
      // under its uid so the page it lands on sends it.
      const token = loadInviteToken(doc.uid);
      if (token) saveInviteToken(res.uid, token);
      setOpen(false);
      reset();
      // Nothing written yet: straight into the editor to write it.
      navigate(written ? `/d/${res.uid}` : `/d/${res.uid}/edit`);
    } catch (err) {
      reportError('NewFolderDocumentDialog.create', err, { uid: doc.uid });
      setError(apiErrorMessage(err, 'Could not add the document'));
      setCreating(false);
    }
  }

  function reset() {
    fields.reset();
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
        maxWidth="860px"
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

            <Flex direction="column" gap="3">
              <NewDocumentFields
                fields={fields}
                sourcePlaceholder="Paste or drop the content — or leave this empty and start from a heading with the name."
              />

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
              {creating ? 'Adding…' : fields.source.trim() ? 'Add document' : 'Add and edit'}
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
