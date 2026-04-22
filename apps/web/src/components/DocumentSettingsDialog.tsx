import { DownloadIcon, GearIcon } from '../icons.js';
import {
  ActionIcon as IconButton,
  Alert,
  Button,
  Divider as Separator,
  Flex,
  Modal,
  Select,
  Text,
  TextInput,
} from '@mantine/core';
import { useState } from 'react';
import type { Document } from '../lib/api.js';
import {
  type DocumentSettingsResponse,
  exportDocumentBundle,
  updateDocumentSettings,
} from '../lib/api.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { BUILT_IN_THEMES } from '../lib/themes.js';

/**
 * "Document Settings" — non-permission concerns. Splits cleanly from
 * AccessControlDialog so admins can rename/restyle/export without the
 * mental overhead of a permissions screen.
 *
 * Surface: document name, default theme, JSON bundle export. The
 * everyday "download the source or a DOCX" lives in `DownloadMenu`
 * next to the gear, since it's not admin-only.
 */
export function DocumentSettingsDialog({
  doc,
  onChange,
}: {
  doc: Document;
  onChange: (s: DocumentSettingsResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [docName, setDocName] = useState(doc.name ?? '');
  const [defaultTheme, setDefaultTheme] = useState(doc.default_theme);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const name = getDisplayName();
    if (!name) {
      setError('Please set your display name first.');
      return;
    }
    const identity = { clientId: getClientId(), displayName: name };
    setSaving(true);
    setError(null);
    try {
      // Only the fields this dialog owns. PATCH-style: omitted fields
      // stay as-is on the server.
      const patch: Parameters<typeof updateDocumentSettings>[1] = {
        name: docName.trim() ? docName.trim() : null,
        default_theme: defaultTheme,
      };
      const result = await updateDocumentSettings(doc.uid, patch, identity);
      onChange(result);
      setOpen(false);
    } catch (err) {
      reportError('DocumentSettings.save', err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function exportJson() {
    setExporting(true);
    setError(null);
    try {
      const bundle = await exportDocumentBundle(doc.uid);
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${sanitizeFilename(doc.name ?? doc.uid)}.marginalia.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer the revoke a tick: a synchronous revoke right after
      // `click()` can cancel the download in Safari/WebKit. See
      // DownloadMenu's `downloadBlob` for the longer write-up.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      reportError('DocumentSettings.exportJson', err, { uid: doc.uid });
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  return (
    <>
      <IconButton variant="light" size="sm" aria-label="Document settings" title="Document settings" onClick={() => setOpen(true)}>
        <GearIcon />
      </IconButton>
      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        size="640px"
        title={<Text fw={600} size="lg">Document settings</Text>}
      >
        <Text size="sm" c="dimmed" mb="4">
          Naming, presentation, and export. Permissions live in Access control.
        </Text>

        <Flex direction="column" gap="4">
          <Flex direction="column" gap="1">
            <Text component="label" size="sm" fw={500} htmlFor="doc-name-setting">
              Document name
            </Text>
            <Text size="xs" c="dimmed">
              Shown on the home page and in the browser tab. Leave blank to derive from the
              document's title / first heading.
            </Text>
            <TextInput
              id="doc-name-setting"
              size="sm"
              value={docName}
              onChange={(e: any) => setDocName(e.target.value)}
              placeholder="Leave blank to use the document's title"
              maxLength={200}
            />
          </Flex>

          <Separator />

          <Flex direction="column" gap="1">
            <Text size="sm" fw={500}>
              Default theme
            </Text>
            <Text size="xs" c="dimmed">
              Applied to anyone opening this document for the first time.
            </Text>
            <Select
              value={defaultTheme}
              onChange={(value) => {
                if (value) setDefaultTheme(value);
              }}
              data={BUILT_IN_THEMES.map((theme) => ({ value: theme.id, label: theme.label }))}
            />
          </Flex>

          <Separator />

          <Flex direction="column" gap="2">
            <Text size="sm" fw={500}>
              JSON bundle
            </Text>
            <Text size="xs" c="dimmed">
              Versioned bundle with the source, comments, and renderer metadata for tooling or
              later import. For day-to-day source or DOCX downloads, use the download icon
              next to this gear instead.
            </Text>
            <Flex>
              <Button variant="light" onClick={exportJson} disabled={exporting}>
                <DownloadIcon />
                {exporting ? 'Exporting…' : 'Export JSON bundle'}
              </Button>
            </Flex>
          </Flex>

          {error && (
            <Alert color="red" variant="light">
              {error}
            </Alert>
          )}

          <Flex gap="2" justify="end">
            <Button variant="light" color="gray" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </Flex>
        </Flex>
      </Modal>
    </>
  );
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'document';
  return trimmed.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'document';
}
