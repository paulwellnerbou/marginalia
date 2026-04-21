import { DownloadIcon } from '@radix-ui/react-icons';
import { DropdownMenu, IconButton } from '@radix-ui/themes';
import { useState } from 'react';
import { extractDocumentTitle, sanitizeDocumentFilename } from '@marginalia/renderer';
import type { Document } from '../lib/api.js';
import { downloadDocumentDocx } from '../lib/api.js';
import { reportError } from '../lib/log.js';
import { showToast } from '../lib/notifications.js';

/**
 * Download affordance in the document toolbar. Opens a small menu with
 * "source" (the raw markdown or AsciiDoc) and "DOCX" (server-side
 * themed Word export).
 *
 * The JSON bundle export stays in the admin-only Document Settings
 * dialog; it's a tooling/re-import feature, not a day-to-day download.
 *
 * Filename derivation mirrors the server: explicit `doc.name` first,
 * otherwise the document's own title (frontmatter `title:` or first
 * H1 / `= Header`), otherwise the opaque uid. Keeps the two download
 * paths producing the same filenames.
 */
export function DownloadMenu({
  doc,
  source,
  theme,
}: {
  doc: Document;
  /** Live source — may differ from doc.source after an applied edit proposal. */
  source: string;
  /** Currently-selected viewer theme, baked into the DOCX export. */
  theme: string;
}) {
  const [busy, setBusy] = useState<null | 'source' | 'docx'>(null);

  const sourceExt = doc.format === 'asciidoc' ? 'adoc' : 'md';
  const sourceLabel = doc.format === 'asciidoc' ? 'AsciiDoc source' : 'Markdown source';

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
      downloadBlob(
        new Blob([source], { type: `${mime};charset=utf-8` }),
        `${base}.${sourceExt}`,
      );
    } catch (err) {
      reportError('DownloadMenu.source', err, { uid: doc.uid });
      showToast({ title: 'Download failed', body: 'Could not save the source file.' });
    } finally {
      setBusy(null);
    }
  }

  async function downloadDocx(): Promise<void> {
    setBusy('docx');
    try {
      const { blob, filename } = await downloadDocumentDocx(doc.uid, theme);
      downloadBlob(blob, filename);
    } catch (err) {
      reportError('DownloadMenu.docx', err, { uid: doc.uid });
      showToast({ title: 'DOCX export failed', body: 'Try again in a moment.' });
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
        <DropdownMenu.Item onSelect={downloadDocx} disabled={busy !== null}>
          Word document (.docx)
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}

function resolveTitle(doc: Document, source: string): string | null {
  if (doc.name && doc.name.trim()) return doc.name.trim();
  return extractDocumentTitle(source, doc.format);
}
