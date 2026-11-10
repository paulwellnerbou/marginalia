import { ResetIcon } from '@radix-ui/react-icons';
import { Flex, IconButton, Text, Tooltip } from '@radix-ui/themes';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  type DocColorRole,
  effectiveBackground,
  rgbToHex,
  setDocColor,
  useDocColors,
} from '../lib/doc-colors.js';

interface Props {
  /** The themed scrollport, whose background is the paper. */
  paperRef: RefObject<HTMLElement | null>;
  /** The rendered article, whose text color is the ink. */
  inkRef: RefObject<HTMLElement | null>;
  /** Re-measure the theme's colors when the theme changes. */
  theme: string;
}

const ROWS: { role: DocColorRole; label: string }[] = [
  { role: 'bg', label: 'Paper' },
  { role: 'fg', label: 'Ink' },
];

/**
 * Two rows of the display grid: paper and ink, each a native color input
 * plus a reset to the theme. Edits the colors of the appearance on screen;
 * the other appearance keeps its own.
 */
export function DocColorControls({ paperRef, inkRef, theme }: Props) {
  const { mode, colors } = useDocColors();
  const [themeColors, setThemeColors] = useState<Partial<Record<DocColorRole, string>>>({});

  // What the theme shows without an override, so the swatch starts there.
  // Measured off the live DOM because the dark palettes leave the paper
  // transparent. Theme stylesheets load async, hence the `load` listener;
  // Radix's Theme flips its `dark` class a render after the appearance
  // changes, hence the observer on it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mode and theme change what the DOM shows, which is read, not referenced.
  useLayoutEffect(() => {
    const measure = () => {
      const next: Partial<Record<DocColorRole, string>> = {};
      if (!colors.bg) {
        const bg = effectiveBackground(paperRef.current);
        if (bg) next.bg = bg;
      }
      if (!colors.fg && inkRef.current) {
        const fg = rgbToHex(getComputedStyle(inkRef.current).color);
        if (fg) next.fg = fg;
      }
      setThemeColors((prev) => ({ ...prev, ...next }));
    };
    measure();
    document.head.addEventListener('load', measure, true);
    const appRoot = paperRef.current?.closest('.radix-themes');
    const observer = new MutationObserver(measure);
    if (appRoot) observer.observe(appRoot, { attributes: true, attributeFilter: ['class'] });
    return () => {
      document.head.removeEventListener('load', measure, true);
      observer.disconnect();
    };
  }, [paperRef, inkRef, colors.bg, colors.fg, mode, theme]);

  return (
    <>
      {ROWS.map(({ role, label }) => {
        const override = colors[role];
        const value = override ?? themeColors[role] ?? (role === 'bg' ? '#ffffff' : '#000000');
        const noun = `${label.toLowerCase()} color`;
        return (
          <ColorRow
            key={role}
            label={label}
            ariaLabel={`${label} color (${mode} mode)`}
            value={value}
            overridden={!!override}
            resetLabel={`Reset ${noun} to the theme's`}
            onChange={(next) => setDocColor(mode, role, next)}
            onReset={() => setDocColor(mode, role, null)}
          />
        );
      })}
    </>
  );
}

function ColorRow({
  label,
  ariaLabel,
  value,
  overridden,
  resetLabel,
  onChange,
  onReset,
}: {
  label: string;
  ariaLabel: string;
  value: string;
  overridden: boolean;
  resetLabel: string;
  onChange: (hex: string) => void;
  onReset: () => void;
}) {
  // A drag fires an input event per mouse move, and each commit restyles
  // the whole document, which on a long one takes longer than a frame. The
  // swatch follows the draft at once; the document gets the latest value
  // at most once per frame.
  const [draft, setDraft] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const frame = useRef(0);
  const commit = useRef(onChange);
  commit.current = onChange;

  const flush = () => {
    frame.current = 0;
    const next = pending.current;
    pending.current = null;
    if (next) commit.current(next);
    setDraft(null);
  };

  const schedule = (hex: string) => {
    setDraft(hex);
    pending.current = hex;
    if (!frame.current) frame.current = requestAnimationFrame(flush);
  };

  // Closing the menu mid-drag still keeps the last color.
  useEffect(
    () => () => {
      if (!frame.current) return;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      if (pending.current) commit.current(pending.current);
    },
    [],
  );

  const shown = draft ?? value;

  return (
    <>
      <Text size="1" color="gray">
        {label}
      </Text>
      <Flex align="center" gap="2">
        <input
          type="color"
          className="doc-color-swatch"
          aria-label={ariaLabel}
          value={shown}
          onChange={(e) => schedule(e.currentTarget.value)}
        />
        <span
          className={`doc-color-value${overridden || draft ? '' : ' doc-color-value-theme'}`}
          title={overridden || draft ? undefined : "The theme's color"}
        >
          {shown}
        </span>
        <Tooltip content={resetLabel}>
          <IconButton
            size="1"
            variant="ghost"
            color="gray"
            className="doc-stepper-reset"
            aria-label={resetLabel}
            disabled={!overridden}
            onClick={onReset}
          >
            <ResetIcon />
          </IconButton>
        </Tooltip>
      </Flex>
    </>
  );
}
