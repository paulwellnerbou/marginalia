import { DownloadIcon, GearIcon, LockClosedIcon } from '@radix-ui/react-icons';
import {
  Button,
  Callout,
  Checkbox,
  Code,
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
import { Copyable } from './Copyable.js';
import { InvitesPanel } from './InvitesPanel.js';

export function AdminSettingsDialog({
  doc,
  onChange,
}: {
  doc: Document;
  onChange: (s: DocumentSettingsResponse) => void;
}) {
  const [open, setOpen] = useState(false);
  const [docName, setDocName] = useState(doc.name ?? '');
  const [editableByAnyone, setEditableByAnyone] = useState(doc.editable_by_anyone);
  const [defaultTheme, setDefaultTheme] = useState(doc.default_theme);
  const [passwordProtected, setPasswordProtected] = useState(doc.password_protected);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshPassword, setFreshPassword] = useState<string | null>(null);

  async function save() {
    const name = getDisplayName();
    if (!name) {
      setError('Set your display name first (user menu, top-right).');
      return;
    }
    const identity = { clientId: getClientId(), displayName: name };
    setSaving(true);
    setError(null);
    try {
      const patch: Parameters<typeof updateDocumentSettings>[1] = {
        editable_by_anyone: editableByAnyone,
        default_theme: defaultTheme,
        name: docName.trim() ? docName.trim() : null,
      };
      if (!passwordProtected && doc.password_protected) patch.password = null;
      if (passwordProtected && !doc.password_protected) patch.password = 'rotate';

      const result = await updateDocumentSettings(doc.uid, patch, identity);
      onChange(result);
      if (result.password) setFreshPassword(result.password);
    } catch (err) {
      reportError('AdminSettings.save', err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    const name = getDisplayName();
    if (!name) return;
    const identity = { clientId: getClientId(), displayName: name };
    setSaving(true);
    setError(null);
    try {
      const result = await updateDocumentSettings(doc.uid, { password: 'rotate' }, identity);
      onChange(result);
      if (result.password) setFreshPassword(result.password);
    } catch (err) {
      reportError('AdminSettings.rotate', err);
      setError(err instanceof Error ? err.message : 'Rotate failed');
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
      reportError('AdminSettings.exportJson', err, { uid: doc.uid });
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setFreshPassword(null);
      }}
    >
      <Dialog.Trigger>
        <IconButton variant="soft" size="2" aria-label="Document settings">
          <GearIcon />
        </IconButton>
      </Dialog.Trigger>
      <Dialog.Content size="3" maxWidth="780px">
        <Dialog.Title>Document settings</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="4">
          Access and defaults for this document. You are the admin.
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

          <Text as="label" size="2">
            <Flex align="center" gap="2">
              <Checkbox
                checked={editableByAnyone}
                onCheckedChange={(c) => setEditableByAnyone(c === true)}
              />
              Allow anyone (with access) to edit the source
            </Flex>
          </Text>

          <Separator size="4" />

          <Flex direction="column" gap="2">
            <Text as="label" size="2">
              <Flex align="center" gap="2">
                <Checkbox
                  checked={passwordProtected}
                  onCheckedChange={(c) => setPasswordProtected(c === true)}
                />
                <LockClosedIcon />
                Password-protect this document
              </Flex>
            </Text>
            {passwordProtected && doc.password_protected && (
              <Flex align="center" gap="2" pl="6">
                <Text size="1" color="gray">
                  Password is set. Rotate invalidates existing sessions; invite links still
                  determine identity and role after re-authentication.
                </Text>
                <Button size="1" variant="soft" onClick={rotate} disabled={saving}>
                  Rotate password
                </Button>
              </Flex>
            )}
          </Flex>

          {freshPassword && (
            <Callout.Root color="amber">
              <Callout.Text>
                <Flex direction="column" gap="2">
                  <span>New password (shown once):</span>
                  <Copyable text={freshPassword} ariaLabel="Copy password" />
                </Flex>
              </Callout.Text>
            </Callout.Root>
          )}

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
              JSON export
            </Text>
            <Text size="1" color="gray">
              Downloads a versioned JSON bundle with the markdown source, comments, and renderer
              metadata for tooling or later import.
            </Text>
            <Flex>
              <Button variant="soft" onClick={exportJson} disabled={exporting}>
                <DownloadIcon />
                {exporting ? 'Exporting…' : 'Export JSON bundle'}
              </Button>
            </Flex>
          </Flex>

          <Separator size="4" />

          <InvitesPanel uid={doc.uid} />

          {error && (
            <Callout.Root color="red" size="1">
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          )}

          <Flex gap="2" justify="end">
            <Dialog.Close>
              <Button variant="soft" color="gray">
                Close
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
