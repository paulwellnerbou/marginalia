import { extractDocumentTitle, sanitizeDocumentFilename } from '@marginalia/renderer/extract-title';
import { DownloadIcon } from '@radix-ui/react-icons';
import { Button, Callout, Dialog, DropdownMenu, Flex, IconButton, Text } from '@radix-ui/themes';
import { useLayoutEffect, useState } from 'react';
import type { Document, DocumentCover } from '../lib/api.js';
import {
  ApiError,
  coverProxyUrl,
  deleteDocumentCover,
  downloadDocumentDocx,
  downloadDocumentDocxWithAcceptedProposals,
  downloadDocumentEpub,
  downloadDocumentMarkdownChapters,
  downloadDocumentPdf,
  downloadDocumentSourceWithAcceptedProposals,
  uploadDocumentCover,
} from '../lib/api.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { showToast } from '../lib/notifications.js';
import { updateRecentDocCover } from '../lib/recent-docs.js';
import { FileDropZone } from './FileDropZone.js';

/**
 * Download affordance in the document toolbar. Opens a small menu with
 * "source" (the raw markdown or AsciiDoc), "DOCX" (server-side themed
 * Word export, with an optional review-mode variant that folds the
 * document's open comments + edit proposals into native Word features),
 * and "PDF" (server-side themed PDF export via headless Chromium).
 *
 * The JSON bundle export stays in the admin-only Document Settings
 * dialog; it's a tooling/re-import feature, not a day-to-day download.
 *
 * Filename derivation mirrors the server: explicit `doc.name` first,
 * otherwise the document's own title (frontmatter `title:` or first
 * H1 / `= Header`), otherwise the opaque uid. Keeps all download
 * paths producing the same filenames.
 */
export function DownloadMenu({
  doc,
  source,
  theme,
  reviewExportEnabled,
}: {
  doc: Document;
  /** Live source — may differ from doc.source after an applied edit proposal. */
  source: string;
  /** Currently-selected viewer theme, baked into the DOCX / PDF exports. */
  theme: string;
  /**
   * When true, the menu shows the "with comments & change proposals"
   * Word entry alongside the vanilla one. Wired to whether the user
   * has the inline-comments pane visible — i.e. they're in review
   * mode. Closed (resolved / accepted / rejected) threads are never
   * included; only open ones make it into the export.
   */
  reviewExportEnabled?: boolean;
}) {
  const [busy, setBusy] = useState<
    | null
    | 'source'
    | 'accepted-source'
    | 'chapters'
    | 'accepted-chapters'
    | 'docx'
    | 'accepted-docx'
    | 'epub'
    | 'pdf'
  >(null);
  const [epubMode, setEpubMode] = useState<null | 'current' | 'accepted'>(null);
  const [cover, setCover] = useState<File | null>(null);
  /**
   * The document's saved cover, as of the last time the dialog opened.
   * Held locally because uploading one here doesn't re-fetch the parent's
   * `doc`.
   */
  const [storedCover, setStoredCover] = useState<DocumentCover | null>(doc.cover);
  const [removingCover, setRemovingCover] = useState(false);
  const [savingCover, setSavingCover] = useState(false);
  const [coverNotice, setCoverNotice] = useState<string | null>(null);
  const [epubError, setEpubError] = useState<string | null>(null);
  /** Object URL for the picked file, so the dialog can show it before upload. */
  const [coverPreview, setCoverPreview] = useState<string | null>(null);

  // Layout, not passive: a passive effect lands after paint, so clearing
  // the pick (a save, a download, reopening the dialog) would paint one
  // frame of the old preview under a caption that no longer describes
  // it. Minting an object URL is cheap enough to do before paint.
  useLayoutEffect(() => {
    if (!cover) {
      setCoverPreview(null);
      return;
    }
    const url = URL.createObjectURL(cover);
    setCoverPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);

  /** Only editors can write the cover into the document's asset store. */
  const canStoreCover = doc.role === 'admin' || doc.role === 'editor';

  /** A pending pick wins the thumbnail slot: it's what the export would use. */
  const thumbSrc = coverPreview ?? (storedCover ? coverProxyUrl(doc.uid, storedCover) : null);
  const thumbCaption = !coverPreview
    ? 'Saved cover'
    : canStoreCover
      ? 'Not saved yet'
      : 'This download only';

  const sourceExt = doc.format === 'asciidoc' ? 'adoc' : 'md';
  const sourceLabel = doc.format === 'asciidoc' ? 'AsciiDoc source' : 'Markdown source';
  const acceptedSourceLabel =
    doc.format === 'asciidoc'
      ? 'AsciiDoc with proposals accepted'
      : 'Markdown with proposals accepted';

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Defer the revoke: Safari/WebKit treats a synchronous
    // `revokeObjectURL` right after `click()` as an "URL is gone,
    // cancel the download" signal and can truncate or drop the file
    // entirely. One macro-task later the navigation has started and
    // it's safe to release the object URL.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function downloadSource(): void {
    setBusy('source');
    try {
      const base = sanitizeDocumentFilename(resolveTitle(doc, source), doc.uid);
      const mime = doc.format === 'asciidoc' ? 'text/asciidoc' : 'text/markdown';
      downloadBlob(new Blob([source], { type: `${mime};charset=utf-8` }), `${base}.${sourceExt}`);
    } catch (err) {
      reportError('DownloadMenu.source', err, { uid: doc.uid });
      showToast({ title: 'Download failed', body: 'Could not save the source file.' });
    } finally {
      setBusy(null);
    }
  }

  async function downloadDocx(withReview: boolean): Promise<void> {
    setBusy('docx');
    try {
      const { blob, filename } = await downloadDocumentDocx(doc.uid, {
        theme,
        ...(withReview ? { review: 'both' as const } : {}),
      });
      downloadBlob(blob, filename);
    } catch (err) {
      reportError('DownloadMenu.docx', err, { uid: doc.uid, withReview });
      showToast({ title: 'DOCX export failed', body: 'Try again in a moment.' });
    } finally {
      setBusy(null);
    }
  }

  async function downloadAcceptedSource(): Promise<void> {
    setBusy('accepted-source');
    try {
      const { blob, filename, skippedProposals } =
        await downloadDocumentSourceWithAcceptedProposals(doc.uid);
      downloadBlob(blob, filename);
      if (skippedProposals > 0) {
        showToast({
          title: 'Partial download',
          body: `${skippedProposals} proposal${skippedProposals === 1 ? '' : 's'} could not be applied cleanly.`,
        });
      }
    } catch (err) {
      reportError('DownloadMenu.acceptedSource', err, { uid: doc.uid });
      showToast({ title: 'Download failed', body: 'Could not save the source file.' });
    } finally {
      setBusy(null);
    }
  }

  async function downloadAcceptedDocx(): Promise<void> {
    setBusy('accepted-docx');
    try {
      const { blob, filename, skippedProposals } = await downloadDocumentDocxWithAcceptedProposals(
        doc.uid,
        theme,
      );
      downloadBlob(blob, filename);
      if (skippedProposals > 0) {
        showToast({
          title: 'Partial DOCX export',
          body: `${skippedProposals} proposal${skippedProposals === 1 ? '' : 's'} could not be applied cleanly.`,
        });
      }
    } catch (err) {
      reportError('DownloadMenu.acceptedDocx', err, { uid: doc.uid });
      showToast({ title: 'DOCX export failed', body: 'Try again in a moment.' });
    } finally {
      setBusy(null);
    }
  }

  async function downloadChapters(acceptedProposals: boolean): Promise<void> {
    setBusy(acceptedProposals ? 'accepted-chapters' : 'chapters');
    try {
      const { blob, filename, skippedProposals } = await downloadDocumentMarkdownChapters(
        doc.uid,
        acceptedProposals,
      );
      downloadBlob(blob, filename);
      if (skippedProposals > 0) showSkippedToast(skippedProposals, 'chapter archive');
    } catch (err) {
      reportError('DownloadMenu.chapters', err, { uid: doc.uid, acceptedProposals });
      showToast({ title: 'Chapter export failed', body: 'Try again in a moment.' });
    } finally {
      setBusy(null);
    }
  }

  function openEpubDialog(mode: 'current' | 'accepted'): void {
    setCover(null);
    setEpubError(null);
    setCoverNotice(null);
    setStoredCover(doc.cover);
    setEpubMode(mode);
  }

  function closeEpubDialog(): void {
    if (busy === 'epub' || savingCover) return;
    setEpubMode(null);
    setCover(null);
    setEpubError(null);
    setCoverNotice(null);
  }

  async function removeStoredCover(): Promise<void> {
    const displayName = getDisplayName();
    if (!displayName) {
      setEpubError('Please set your display name first.');
      return;
    }
    setRemovingCover(true);
    setEpubError(null);
    setCoverNotice(null);
    try {
      await deleteDocumentCover(doc.uid, { clientId: getClientId(), displayName });
      setStoredCover(null);
      updateRecentDocCover(doc.uid, null);
    } catch (err) {
      reportError('DownloadMenu.removeCover', err, { uid: doc.uid });
      setEpubError('Could not remove the cover. Try again in a moment.');
    } finally {
      setRemovingCover(false);
    }
  }

  /**
   * Persist the picked cover on the document so every later export — and
   * the document list — uses it. Returns false if the upload failed, so
   * the caller can stop before producing a book with the wrong cover.
   * Callers without edit rights skip this and pass the file to the export
   * request instead, where it applies to that one download only.
   */
  async function storeCover(file: File): Promise<boolean> {
    const displayName = getDisplayName();
    if (!displayName) {
      setEpubError('Please set your display name first.');
      return false;
    }
    try {
      const { cover: saved } = await uploadDocumentCover(doc.uid, file, {
        clientId: getClientId(),
        displayName,
      });
      setStoredCover(saved);
      setCover(null);
      updateRecentDocCover(doc.uid, saved);
      return true;
    } catch (err) {
      reportError('DownloadMenu.storeCover', err, { uid: doc.uid });
      // `forbidden` is only about edit rights on this route — the cover
      // store is the one call here gated on them.
      const forbidden = err instanceof ApiError && err.code === 'forbidden';
      setEpubError(
        coverErrorMessage(err) ??
          (forbidden
            ? 'You need edit rights to save a cover on this document.'
            : 'Could not save the cover. Try again in a moment.'),
      );
      return false;
    }
  }

  /**
   * Save the picked cover on its own — the same upload the EPUB export
   * runs first, for people who came here only to change the cover.
   */
  async function saveCoverOnly(): Promise<void> {
    if (!cover) return;
    setSavingCover(true);
    setEpubError(null);
    setCoverNotice(null);
    try {
      if (await storeCover(cover)) setCoverNotice('Cover saved with the document.');
    } finally {
      setSavingCover(false);
    }
  }

  async function downloadEpub(): Promise<void> {
    if (!epubMode) return;
    const acceptedProposals = epubMode === 'accepted';
    setBusy('epub');
    setEpubError(null);
    try {
      // Editors save the cover first and let the server pick it up from
      // the document; everyone else sends it along for this export only.
      if (cover && canStoreCover && !(await storeCover(cover))) return;
      const { blob, filename, skippedProposals } = await downloadDocumentEpub(doc.uid, {
        acceptedProposals,
        cover: canStoreCover ? null : cover,
        theme,
      });
      downloadBlob(blob, filename);
      setEpubMode(null);
      setCover(null);
      if (skippedProposals > 0) showSkippedToast(skippedProposals, 'EPUB');
    } catch (err) {
      reportError('DownloadMenu.epub', err, { uid: doc.uid, acceptedProposals });
      setEpubError(coverErrorMessage(err) ?? 'Could not create the EPUB. Try again in a moment.');
    } finally {
      setBusy(null);
    }
  }

  async function downloadPdf(): Promise<void> {
    setBusy('pdf');
    try {
      const { blob, filename } = await downloadDocumentPdf(doc.uid, theme);
      downloadBlob(blob, filename);
    } catch (err) {
      reportError('DownloadMenu.pdf', err, { uid: doc.uid });
      // PDF-specific error codes from the server let us give a more
      // useful toast than "try again". See apps/server/src/export/pdf.ts
      // for the full list.
      if (err instanceof ApiError) {
        if (err.code === 'export-engine-missing') {
          showToast({
            title: 'PDF export unavailable',
            body: 'The server is missing its PDF engine. Contact the operator.',
          });
          return;
        }
        if (err.code === 'export-busy') {
          showToast({
            title: 'PDF export busy',
            body: 'Another export is in progress. Try again in a moment.',
          });
          return;
        }
        if (err.code === 'export-timeout') {
          showToast({
            title: 'PDF export timed out',
            body: 'The document took too long to render. Try a simpler theme or split the document.',
          });
          return;
        }
      }
      showToast({ title: 'PDF export failed', body: 'Try again in a moment.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <DropdownMenu.Root>
        {/* Radix Tooltip wraps would break the DropdownMenu.Trigger, so
          fall back to the plain HTML `title` attribute on the icon. */}
        <DropdownMenu.Trigger>
          <IconButton
            variant="soft"
            size="2"
            aria-label="Download document"
            title="Download document"
            disabled={busy !== null}
          >
            <DownloadIcon />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Content align="end">
          <DropdownMenu.Item onSelect={downloadSource} disabled={busy !== null}>
            {sourceLabel} (.{sourceExt})
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={downloadAcceptedSource} disabled={busy !== null}>
            {acceptedSourceLabel} (.{sourceExt})
          </DropdownMenu.Item>
          {doc.format === 'markdown' && (
            <>
              <DropdownMenu.Item onSelect={() => downloadChapters(false)} disabled={busy !== null}>
                Markdown chapters (.zip)
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={() => downloadChapters(true)} disabled={busy !== null}>
                Markdown chapters with proposals accepted
              </DropdownMenu.Item>
            </>
          )}
          {/* Word entries grouped between separators so the toolbar
            visually pairs them as one feature. */}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => downloadDocx(false)} disabled={busy !== null}>
            Word document (.docx)
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={downloadAcceptedDocx} disabled={busy !== null}>
            Word document with proposals accepted
          </DropdownMenu.Item>
          {reviewExportEnabled && (
            <DropdownMenu.Item onSelect={() => downloadDocx(true)} disabled={busy !== null}>
              Word document with comments &amp; change proposals
            </DropdownMenu.Item>
          )}
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={() => openEpubDialog('current')} disabled={busy !== null}>
            EPUB book (.epub)
          </DropdownMenu.Item>
          <DropdownMenu.Item onSelect={() => openEpubDialog('accepted')} disabled={busy !== null}>
            EPUB book with proposals accepted
          </DropdownMenu.Item>
          <DropdownMenu.Separator />
          <DropdownMenu.Item onSelect={downloadPdf} disabled={busy !== null}>
            PDF document (.pdf)
          </DropdownMenu.Item>
          {doc.mermaid_renderer === 'chromium' && (
            <DropdownMenu.Label>Diagrams: Chromium (high fidelity, slower)</DropdownMenu.Label>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Root>

      <Dialog.Root open={epubMode !== null} onOpenChange={(open) => !open && closeEpubDialog()}>
        <Dialog.Content size="2" maxWidth="520px">
          <Dialog.Title>Download EPUB</Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="4">
            {epubMode === 'accepted'
              ? 'Open edit proposals will be applied to a temporary export copy.'
              : 'The EPUB will use the current document text.'}
          </Dialog.Description>
          <Flex direction="column" gap="3">
            <Flex gap="3" align="start">
              {thumbSrc && (
                <Flex direction="column" gap="1" align="center" flexShrink="0">
                  <img
                    className="cover-thumb cover-thumb--dialog"
                    src={thumbSrc}
                    alt={coverPreview ? 'Selected cover' : 'Current cover'}
                  />
                  <Text size="1" color="gray" align="center">
                    {thumbCaption}
                  </Text>
                </Flex>
              )}
              <Flex direction="column" gap="2" flexGrow="1">
                <Text size="2" weight="medium">
                  Cover image (optional)
                </Text>
                <Text size="1" color="gray">
                  PNG, JPEG, GIF, or WebP, up to 10 MB.{' '}
                  {canStoreCover
                    ? 'Saved with the document, so every later export and the document list use it.'
                    : 'Used for this download only — saving a cover on the document needs edit rights.'}{' '}
                  {storedCover
                    ? 'Pick a file to replace the current cover.'
                    : 'Without one, a cover is generated from the document title.'}
                </Text>
                <FileDropZone
                  accept="image/png,image/jpeg,image/gif,image/webp"
                  acceptFile={isCoverImageFile}
                  onFile={(file) => {
                    setCover(file);
                    setCoverNotice(null);
                  }}
                  disabled={busy === 'epub' || savingCover}
                  label={
                    cover ? `Selected: ${cover.name}` : 'Drop a cover image — or click to browse'
                  }
                />
                {canStoreCover && (cover || storedCover) && (
                  <Flex gap="2" mt="1" wrap="wrap">
                    {cover && (
                      <Button
                        type="button"
                        size="1"
                        variant="soft"
                        onClick={() => void saveCoverOnly()}
                        disabled={savingCover || removingCover || busy === 'epub'}
                      >
                        {savingCover ? 'Saving…' : 'Save cover'}
                      </Button>
                    )}
                    {storedCover && (
                      <Button
                        type="button"
                        size="1"
                        variant="soft"
                        color="gray"
                        onClick={() => void removeStoredCover()}
                        disabled={removingCover || savingCover || busy === 'epub'}
                      >
                        {removingCover ? 'Removing…' : 'Remove saved cover'}
                      </Button>
                    )}
                  </Flex>
                )}
                {coverNotice && (
                  <Text size="1" color="green">
                    {coverNotice}
                  </Text>
                )}
              </Flex>
            </Flex>
            {epubError && (
              <Callout.Root color="red" size="1">
                <Callout.Text>{epubError}</Callout.Text>
              </Callout.Root>
            )}
            <Flex justify="end" gap="2">
              <Button
                type="button"
                variant="soft"
                color="gray"
                onClick={closeEpubDialog}
                disabled={busy === 'epub' || savingCover}
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void downloadEpub()}
                disabled={busy === 'epub' || savingCover}
              >
                {busy === 'epub' ? 'Creating EPUB…' : 'Download EPUB'}
              </Button>
            </Flex>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}

/**
 * Drag-and-drop filter for the cover picker. The server decides the real
 * format by sniffing magic bytes; this only keeps an obviously wrong
 * drop (a PDF, a folder of source) from reaching the upload at all.
 */
function isCoverImageFile(file: File): boolean {
  if (COVER_MIME_TYPES.has(file.type)) return true;
  return /\.(png|jpe?g|gif|webp)$/i.test(file.name);
}

const COVER_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/**
 * Rejections of the cover image itself. Only codes that *no other part*
 * of these two requests can produce belong here — the export route
 * reuses this mapper, and a generic auth failure there has nothing to
 * do with the cover.
 */
function coverErrorMessage(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === 'cover-too-large') return 'The cover image must be 10 MB or smaller.';
  if (err.code === 'unsupported-cover-image') return 'Use a PNG, JPEG, GIF, or WebP cover image.';
  return null;
}

function showSkippedToast(count: number, exportName: string): void {
  showToast({
    title: `Partial ${exportName}`,
    body: `${count} proposal${count === 1 ? '' : 's'} could not be applied cleanly.`,
  });
}

function resolveTitle(doc: Document, source: string): string | null {
  const name = doc.name?.trim();
  if (name) return name;
  return extractDocumentTitle(source, doc.format);
}
