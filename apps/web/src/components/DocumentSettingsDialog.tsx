import { DownloadIcon, GearIcon } from '@radix-ui/react-icons';
import {
  Button,
  Callout,
  Dialog,
  Flex,
  IconButton,
  Select,
  Separator,
  Text,
  TextField,
} from '@radix-ui/themes';
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
      URL.revokeObjectURL(url);
    } catch (err) {
      reportError('DocumentSettings.exportJson', err, { uid: doc.uid });
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger>
        <IconButton variant="soft" size="2" aria-label="Document settings" title="Document settings">
          <GearIcon />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Content size="3" maxWidth="640px">
        <Dialog.Title>Document settings</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          Naming, presentation, and export. Permissions live in Access control.
        </Dialog.Description>

        <Flex direction="column" gap="4">
          <Flex direction="column" gap="1">
            <Text as="label" size="2" weight="medium" htmlFor="doc-name-setting">
              Document name
            </Text>
            <Text size="1" color="gray">
              Shown on the home page and in the browser tab. Leave blank to derive from the
              document's title / first heading.
            </Text>
            <TextField.Root
              id="doc-name-setting"
              size="2"
              value={docName}
              onChange={(e) => setDocName(e.target.value)}
              placeholder="Leave blank to use the document's title"
              maxLength={200}
            />
          </Flex>

          <Separator size="4" />

          <Flex direction="column" gap="1">
            <Text size="2" weight="medium">
              Default theme
            </Text>
            <Text size="1" color="gray">
              Applied to anyone opening this document for the first time.
            </Text>
            <Select.Root value={defaultTheme} onValueChange={setDefaultTheme}>
              <Select.Trigger />
              <Select.Content position="popper">
                {BUILT_IN_THEMES.map((t) => (
                  <Select.Item key={t.id} value={t.id}>
                    {t.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>

          <Separator size="4" />

          <Flex direction="column" gap="2">
            <Text size="2" weight="medium">
              JSON bundle
            </Text>
            <Text size="1" color="gray">
              Versioned bundle with the source, comments, and renderer metadata for tooling or
              later import. For day-to-day source or DOCX downloads, use the download icon
              next to this gear instead.
            </Text>
            <Flex>
              <Button variant="soft" onClick={exportJson} disabled={exporting}>
                <DownloadIcon />
                {exporting ? 'Exporting…' : 'Export JSON bundle'}
              </Button>
            </Flex>
          </Flex>

          {error && (
            <Callout.Root color="red" size="1">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}

          <Flex gap="2" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray">
                Cancel
              </Button>
            </Dialog.Close>
            <Button onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return 'document';
  return trimmed.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'document';
}
