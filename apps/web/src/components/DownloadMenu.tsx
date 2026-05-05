import { extractDocumentTitle, sanitizeDocumentFilename } from '@marginalia/renderer';
import { DownloadIcon } from '@radix-ui/react-icons';
import { DropdownMenu, IconButton } from '@radix-ui/themes';
import { useState } from 'react';
import type { Document } from '../lib/api.js';
import {
  ApiError,
  downloadDocumentDocx,
  downloadDocumentDocxWithAcceptedProposals,
  downloadDocumentPdf,
  downloadDocumentSourceWithAcceptedProposals,
} from '../lib/api.js';
import { reportError } from '../lib/log.js';
import { showToast } from '../lib/notifications.js';

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
    null | 'source' | 'accepted-source' | 'docx' | 'accepted-docx' | 'pdf'
  >(null);

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
        <DropdownMenu.Item onSelect={downloadPdf} disabled={busy !== null}>
          PDF document (.pdf)
        </DropdownMenu.Item>
        {doc.mermaid_renderer === 'chromium' && (
          <DropdownMenu.Label>Diagrams: Chromium (high fidelity, slower)</DropdownMenu.Label>
        )}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

function resolveTitle(doc: Document, source: string): string | null {
  const name = doc.name?.trim();
  if (name) return name;
  return extractDocumentTitle(source, doc.format);
}
