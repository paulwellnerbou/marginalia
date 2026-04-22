import { ActionIcon as IconButton, Tooltip } from '@mantine/core';
import { MoonIcon, SunIcon, DesktopIcon } from '../icons.js';
import { useAppearance, type Appearance } from '../lib/appearance.js';

/**
 * Three-state toggle: light → dark → auto → light → …
 * Displays the icon of whatever the NEXT click will cycle to, so the user
 * can read the button as "switch to X".
 */
const CYCLE: Record<Appearance, Appearance> = {
  light: 'dark',
  dark: 'auto',
  auto: 'light',
};

const LABEL: Record<Appearance, string> = {
  light: 'Light (click for dark)',
  dark: 'Dark (click for system)',
  auto: 'System (click for light)',
};

const MANTINE_SIZE = {
  '1': 'xs',
  '2': 'sm',
  '3': 'md',
} as const;

export function AppearanceToggle({ size = '2' }: { size?: '1' | '2' | '3' }) {
  const { appearance, setAppearance } = useAppearance();
  const icon =
    appearance === 'light' ? <SunIcon /> : appearance === 'dark' ? <MoonIcon /> : <DesktopIcon />;

  return (
    <Tooltip label={LABEL[appearance]}>
      <IconButton
        variant="light"
        size={MANTINE_SIZE[size]}
        onClick={() => setAppearance(CYCLE[appearance])}
        aria-label={LABEL[appearance]}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );
}
