import { normalizeAccent } from '@marginalia/themes/accent';
import { Button } from '@radix-ui/themes';
import { type RefObject, useState } from 'react';
import {
  type Document,
  type DocumentSettingsResponse,
  updateDocumentSettings,
} from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import {
  accentResetTarget,
  announceDocAccentDefault,
  clearDocAccentOverride,
  resetDocAccent,
  setDocAccent,
  useDocAccent,
} from '../lib/doc-accent.js';
import { getClientId, getDisplayName } from '../lib/identity.js';
import { reportError } from '../lib/log.js';
import { showToast } from '../lib/notifications.js';
import { useThemeMeasure } from '../lib/useThemeMeasure.js';
import { ColorRow } from './DocColorControls.js';

/**
 * The accent row of the display grid: links and the theme's other accent
 * marks, in shades derived from one pick. An admin whose accent differs
 * from the document's default can make it the default for every reader,
 * like the theme.
 */
export function AccentControl({
  doc,
  inkRef,
  theme,
  onDocSettingsChanged,
}: {
  doc: Pick<Document, 'uid' | 'role'>;
  /** The rendered article, which carries the theme's accent. */
  inkRef: RefObject<HTMLElement | null>;
  /** Re-measure the theme's accent when the theme changes. */
  theme: string;
  onDocSettingsChanged?: ((uid: string, s: Partial<DocumentSettingsResponse>) => void) | undefined;
}) {
  const state = useDocAccent(doc.uid);
  const { accent, docDefault } = state;
  const [themeAccent, setThemeAccent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // What the theme shows without a pick, so the swatch starts there.
  // Only while nothing is picked: a pick replaces the variable inline.
  useThemeMeasure(
    () => {
      const el = inkRef.current;
      if (accent !== null || !el) return;
      const hex = cssColorToHex(getComputedStyle(el).getPropertyValue('--md-color-accent'));
      if (hex) setThemeAccent(hex);
    },
    inkRef,
    [accent, theme],
  );

  async function makeDefault() {
    if (!onDocSettingsChanged) return;
    const identity = { clientId: getClientId(), displayName: getDisplayName() };
    setSaving(true);
    try {
      const result = await updateDocumentSettings(doc.uid, { default_accent: accent }, identity);
      announceDocAccentDefault(doc.uid, result.default_accent);
      clearDocAccentOverride(doc.uid);
      onDocSettingsChanged(doc.uid, { default_accent: result.default_accent });
    } catch (err) {
      reportError('AccentControl.makeDefault', err, { uid: doc.uid });
      showToast({
        title: 'Default accent not changed',
        body: apiErrorMessage(err, 'Could not change the default accent'),
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  const reset = accentResetTarget(state);
  const inherited =
    state.override !== null && accent !== null
      ? undefined
      : accent !== null
        ? "The document's accent"
        : "The theme's accent";

  return (
    <>
      <ColorRow
        label="Accent"
        ariaLabel="Accent color for links"
        value={accent ?? themeAccent ?? '#2156a5'}
        inherited={inherited}
        canReset={reset !== null && !saving}
        resetLabel={
          reset === 'document' ? "Reset accent to the document's" : "Use the theme's accent"
        }
        onChange={(next) => setDocAccent(doc.uid, next)}
        onReset={() => resetDocAccent(doc.uid)}
      />
      {onDocSettingsChanged && doc.role === 'admin' && accent !== docDefault && (
        <Button
          size="1"
          variant="soft"
          className="doc-view-grid-control"
          title={
            accent
              ? 'Every reader of this document sees this accent unless they pick another'
              : "Every reader of this document sees the theme's accent unless they pick another"
          }
          disabled={saving}
          onClick={() => void makeDefault()}
        >
          Make document default
        </Button>
      )}
    </>
  );
}

let probe: CanvasRenderingContext2D | null | undefined;

/** Any CSS color the canvas understands, as `#rrggbb`; null for the rest. */
function cssColorToHex(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const direct = normalizeAccent(v);
  if (direct) return direct;
  if (probe === undefined) probe = document.createElement('canvas').getContext('2d');
  const ctx = probe;
  if (!ctx) return null;
  // The canvas keeps its previous style for a value it can't parse, so a
  // value parsed only when two different starting styles both give way.
  const parsed = ['#000000', '#ffffff'].map((start) => {
    ctx.fillStyle = start;
    ctx.fillStyle = v;
    return String(ctx.fillStyle);
  });
  return parsed[0] === parsed[1] ? normalizeAccent(parsed[0]) : null;
}
