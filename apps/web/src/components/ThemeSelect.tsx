import { Button, Select, Text } from '@radix-ui/themes';
import { useState } from 'react';
import {
  type Document,
  type DocumentSettingsResponse,
  updateDocumentSettings,
} from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { showToast } from '../lib/notifications.js';
import {
  BUILT_IN_THEMES,
  canOfferThemeAsDefault,
  setUserThemeOverride,
  themeOverrideFor,
} from '../lib/themes.js';

/**
 * The reader's theme for this document, with the document's default
 * marked in the list. An admin whose pick differs from the default can
 * make it the document's default for every reader. Renders the select
 * and, when offered, the button as siblings, so the caller's grid or row
 * places them.
 */
export function ThemeSelect({
  id,
  doc,
  theme,
  onThemeChange,
  onDocSettingsChanged,
}: {
  id: string;
  doc: Pick<Document, 'uid' | 'role' | 'default_theme'>;
  theme: string;
  onThemeChange: (next: string) => void;
  /** Without it there is nowhere to report a new default, so none is offered. */
  onDocSettingsChanged?: ((uid: string, s: Partial<DocumentSettingsResponse>) => void) | undefined;
}) {
  const [saving, setSaving] = useState(false);
  const label = BUILT_IN_THEMES.find((t) => t.id === theme)?.label ?? theme;

  async function makeDefault() {
    if (!onDocSettingsChanged) return;
    const identity = { clientId: getClientId(), displayName: getDisplayName() };
    setSaving(true);
    try {
      const result = await updateDocumentSettings(doc.uid, { default_theme: theme }, identity);
      setUserThemeOverride(doc.uid, null);
      onDocSettingsChanged(doc.uid, { default_theme: result.default_theme });
    } catch (err) {
      reportError('ThemeSelect.makeDefault', err, { uid: doc.uid });
      showToast({
        title: 'Default theme not changed',
        body: apiErrorMessage(err, 'Could not change the default theme'),
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {/* Disabled while saving: a pick made meanwhile would be stored as an
          override and then cleared by the save. */}
      <Select.Root
        value={theme}
        size="1"
        disabled={saving}
        onValueChange={(next) => {
          onThemeChange(next);
          setUserThemeOverride(doc.uid, themeOverrideFor(next, doc.default_theme));
        }}
      >
        {/* Just the name: the item's default marker would read
            "Default · document default" here. */}
        <Select.Trigger id={id} variant="soft">
          {label}
        </Select.Trigger>
        <Select.Content position="popper" style={{ maxHeight: 360 }}>
          {BUILT_IN_THEMES.map((t) => (
            <Select.Item key={t.id} value={t.id}>
              {t.label}
              {t.id === doc.default_theme && <Text color="gray"> · document default</Text>}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      {onDocSettingsChanged &&
        canOfferThemeAsDefault({ role: doc.role, theme, defaultTheme: doc.default_theme }) && (
          <Button
            size="1"
            variant="soft"
            className="doc-view-grid-control"
            title="Every reader of this document sees this theme unless they pick another"
            disabled={saving}
            onClick={() => void makeDefault()}
          >
            Make document default
          </Button>
        )}
    </>
  );
}
