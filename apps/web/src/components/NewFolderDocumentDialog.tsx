import { FilePlusIcon } from '@radix-ui/react-icons';
import {
  Button,
  Callout,
  Dialog,
  Flex,
  IconButton,
  SegmentedControl,
  Select,
  Text,
} from '@radix-ui/themes';
import { useImperativeHandle, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Document, DocumentFormat } from '../lib/api.js';
import { createFolderDocument, moveToFolder } from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { documentTitle } from '../lib/doc-title.js';
import { syncDocToken } from '../lib/folder.js';
import { loadInviteToken, saveInviteToken } from '../lib/invite.js';
import { reportError } from '../lib/log.js';
import { loadRecentDocs, type RecentDoc } from '../lib/recent-docs.js';
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
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [moving, setMoving] = useState<string>('');
  // Re-read on open: the list is this browser's, and changes between opens.
  const candidates = useMemo(() => (open ? movableDocs(doc) : []), [open, doc]);
  const existing = mode === 'existing' && candidates.length > 0;

  const main = doc.folder?.documents.find((d) => d.main);
  const mainTitle = !main || main.uid === doc.uid ? documentTitle(doc) : (main.title ?? 'Untitled');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (existing) return moveIn();
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

  async function moveIn() {
    const picked = candidates.find((c) => c.uid === moving);
    const folderToken = loadInviteToken(doc.uid);
    if (!picked || !folderToken) {
      setError('Pick the document to move in first.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      // No name needed: moving writes nothing anyone authors.
      await moveToFolder(picked.uid, doc.uid, folderToken, fields.identityForSubmit());
      // Its own link opens nothing now; the folder's opens it, here and on
      // every device the keyring reaches.
      saveInviteToken(picked.uid, folderToken);
      syncDocToken(picked.uid, folderToken, picked.title);
      setOpen(false);
      reset();
      navigate(`/d/${picked.uid}`);
    } catch (err) {
      reportError('NewFolderDocumentDialog.move', err, { uid: picked.uid });
      setError(apiErrorMessage(err, 'Could not move the document in'));
      setCreating(false);
    }
  }

  function reset() {
    fields.reset();
    setCreating(false);
    setError(null);
    setMode('new');
    setMoving('');
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
              {existing ? 'A document you already have' : 'A new document'} that belongs with{' '}
              <b>{mainTitle}</b> — an outline, background notes, a chapter. It opens with the same
              links and password, and everyone keeps their role, so there is nothing new to share.
            </Dialog.Description>

            <Flex direction="column" gap="3">
              {candidates.length > 0 && (
                <SegmentedControl.Root
                  size="1"
                  value={mode}
                  onValueChange={(v) => setMode(v as 'new' | 'existing')}
                  aria-label="New or existing document"
                  style={{ alignSelf: 'flex-start' }}
                >
                  <SegmentedControl.Item value="new">New document</SegmentedControl.Item>
                  <SegmentedControl.Item value="existing">One you have</SegmentedControl.Item>
                </SegmentedControl.Root>
              )}
              {existing ? (
                <Flex direction="column" gap="2">
                  <Text as="label" size="2" weight="medium" htmlFor="move-in-document">
                    Document
                  </Text>
                  <Select.Root value={moving} onValueChange={setMoving}>
                    <Select.Trigger id="move-in-document" placeholder="Pick a document…" />
                    <Select.Content position="popper">
                      {candidates.map((c) => (
                        <Select.Item key={c.uid} value={c.uid}>
                          {c.title}
                        </Select.Item>
                      ))}
                    </Select.Content>
                  </Select.Root>
                  <Text size="1" color="gray">
                    Documents you are the admin of that stand on their own.
                  </Text>
                  {moving && (
                    <Callout.Root color="amber" size="1">
                      <Callout.Text>
                        It keeps its text, history and comments, and opens with <b>{mainTitle}</b>’s
                        links and password from then on. Its own links and password stop working, so
                        anyone who only had those loses access.
                      </Callout.Text>
                    </Callout.Root>
                  )}
                </Flex>
              ) : (
                <NewDocumentFields
                  fields={fields}
                  sourcePlaceholder="Paste or drop the content — or leave this empty and start from a heading with the name."
                />
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
            {existing ? (
              <Button type="submit" color="amber" disabled={creating || !moving}>
                {creating ? 'Moving…' : 'Move it in'}
              </Button>
            ) : (
              <Button type="submit" disabled={creating}>
                {creating ? 'Adding…' : fields.source.trim() ? 'Add document' : 'Add and edit'}
              </Button>
            )}
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}

/**
 * Documents this browser holds an admin link for that could move in
 * beside `doc`: standalone, and not the main document of a folder of
 * their own. Only an admin of the folder may widen it, so none otherwise.
 */
function movableDocs(doc: Document): RecentDoc[] {
  if (doc.role !== 'admin' || !loadInviteToken(doc.uid)) return [];
  const recent = loadRecentDocs();
  const inFolder = new Set(doc.folder?.documents.map((d) => d.uid) ?? [doc.uid]);
  const mains = new Set(recent.flatMap((d) => (d.folder_uid ? [d.folder_uid] : [])));
  return recent
    .filter(
      (d) =>
        d.role === 'admin' &&
        !d.folder_uid &&
        !inFolder.has(d.uid) &&
        !mains.has(d.uid) &&
        loadInviteToken(d.uid),
    )
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** A heading to start from, since a document cannot be empty. */
function starterSource(name: string, format: DocumentFormat): string {
  if (format === 'html') return `<h1>${escapeHtml(name)}</h1>\n`;
  return format === 'asciidoc' ? `= ${name}\n` : `# ${name}\n`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
