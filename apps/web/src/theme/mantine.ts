import {
  Badge,
  Button,
  Card,
  DEFAULT_THEME,
  Modal,
  Tabs,
  createTheme,
  mergeMantineTheme,
  type MantineTheme,
} from '@mantine/core';

export const APP_THEME_ROOT_CLASS = 'app-theme';

export type AppMantineThemeOptions = {
  accentColor?: string;
  grayColor?: string;
  radius?: string;
  scaling?: string;
  appearance?: 'light' | 'dark';
};

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  const full =
    normalized.length === 3
      ? normalized
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : normalized;
  const value = Number.parseInt(full, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parseScale(scaling?: string): number {
  if (!scaling) return 1;
  if (scaling.endsWith('%')) {
    const percent = Number.parseFloat(scaling);
    return Number.isFinite(percent) && percent > 0 ? percent / 100 : 1;
  }
  const numeric = Number.parseFloat(scaling);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 1;
}

export function normalizeThemeColorName(color?: string): string | undefined {
  switch (color) {
    case undefined:
      return undefined;
    case 'amber':
      return 'amber';
    case 'plum':
      return 'plum';
    case 'ruby':
      return 'ruby';
    case 'slate':
      return 'slate';
    default:
      return color;
  }
}

export function mapThemeRadius(radius?: string): string | number | undefined {
  switch (radius) {
    case 'full':
      return 'xl';
    case 'medium':
      return 'md';
    default:
      return radius;
  }
}

export function createAppMantineTheme({
  accentColor = 'blue',
  radius,
  scaling = '100%',
}: AppMantineThemeOptions) {
  const primaryColor = normalizeThemeColorName(accentColor) ?? 'blue';

  return createTheme({
    scale: parseScale(scaling),
    autoContrast: true,
    primaryColor,
    primaryShade: { light: 6, dark: 5 },
    defaultRadius: mapThemeRadius(radius) ?? DEFAULT_THEME.defaultRadius,
    spacing: {
      '0': '0rem',
      '1': '0.25rem',
      '2': '0.5rem',
      '3': '0.75rem',
      '4': '1rem',
      '5': '1.25rem',
      '6': '1.5rem',
      '7': '2rem',
      '8': '2.5rem',
      '9': '3rem',
    },
    fontSizes: {
      xs: '0.75rem',
      sm: '0.875rem',
      md: '1rem',
      lg: '1.125rem',
      xl: '1.25rem',
      '1': '0.75rem',
      '2': '0.875rem',
      '3': '1rem',
      '4': '1.125rem',
      '5': '1.25rem',
    },
    lineHeights: {
      xs: '1.3',
      sm: '1.35',
      md: '1.5',
      lg: '1.55',
      xl: '1.6',
      '1': '1.3',
      '2': '1.35',
      '3': '1.5',
      '4': '1.55',
      '5': '1.6',
    },
    radius: {
      medium: '0.625rem',
      full: '999px',
    },
    defaultGradient: { from: `${primaryColor}.6`, to: `${primaryColor}.4`, deg: 135 },
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    headings: {
      fontFamily: 'ui-serif, Georgia, Cambria, "Times New Roman", serif',
      fontWeight: '600',
      textWrap: 'balance',
      sizes: {
        h1: { fontSize: '2.875rem', lineHeight: '1.05' },
        h2: { fontSize: '2.125rem', lineHeight: '1.08' },
        h3: { fontSize: '1.65rem', lineHeight: '1.14' },
        h4: { fontSize: '1.35rem', lineHeight: '1.18' },
        h5: { fontSize: '1.12rem', lineHeight: '1.22' },
        h6: { fontSize: '1rem', lineHeight: '1.26' },
      },
    },
    shadows: {
      xs: '0 1px 2px rgba(15, 23, 42, 0.08)',
      sm: '0 8px 24px rgba(15, 23, 42, 0.08)',
      md: '0 16px 40px rgba(15, 23, 42, 0.12)',
      lg: '0 24px 60px rgba(15, 23, 42, 0.18)',
      xl: '0 32px 80px rgba(15, 23, 42, 0.24)',
    },
    colors: {
      amber: DEFAULT_THEME.colors.yellow,
      plum: DEFAULT_THEME.colors.grape,
      ruby: DEFAULT_THEME.colors.red,
      slate: DEFAULT_THEME.colors.gray,
    },
    components: {
      Button: Button.extend({
      }),
      Badge: Badge.extend({
        defaultProps: {
          radius: 'xl',
        },
        styles: {
          label: {
            fontWeight: 400,
          },
        },
      }),
      Card: Card.extend({
        defaultProps: {
          radius: 'lg',
          shadow: 'xs',
          withBorder: true,
        },
      }),
      Modal: Modal.extend({
        defaultProps: {
          centered: true,
          radius: 'lg',
          shadow: 'xl',
          overlayProps: {
            backgroundOpacity: 0.55,
            blur: 10,
          },
        },
      }),
      Tabs: Tabs.extend({
        defaultProps: {
          color: primaryColor,
        },
      }),
    },
  });
}

export function createAppThemeCssVars(
  themeOverride: ReturnType<typeof createTheme>,
  {
    accentColor = 'blue',
    grayColor = 'slate',
    appearance = 'light',
  }: AppMantineThemeOptions,
): Record<string, string> {
  const theme: MantineTheme = mergeMantineTheme(DEFAULT_THEME, themeOverride);
  const accent = theme.colors[normalizeThemeColorName(accentColor) ?? 'blue'] ?? theme.colors.blue;
  const gray = theme.colors[normalizeThemeColorName(grayColor) ?? 'slate'] ?? theme.colors.gray;
  const red = theme.colors.red;
  const ruby = theme.colors.ruby ?? red;
  const dark = theme.colors.dark ?? DEFAULT_THEME.colors.dark;
  const amber = theme.colors.amber ?? DEFAULT_THEME.colors.yellow;
  const isDark = appearance === 'dark';

  return {
    '--color-background': isDark ? dark[7] : '#ffffff',
    '--color-panel-solid': isDark ? dark[6] : '#ffffff',
    '--color-surface': isDark ? dark[6] : '#ffffff',
    '--color-overlay': isDark ? 'rgba(0, 0, 0, 0.72)' : 'rgba(0, 0, 0, 0.55)',
    '--color-muted': isDark ? gray[2] : gray[7],
    '--color-muted-bg': isDark ? rgba(gray[0], 0.12) : rgba(gray[9], 0.08),
    '--color-warn': amber[6],
    '--container-size-1': '32.5rem',
    '--container-size-2': '40rem',
    '--container-size-3': '55rem',
    '--container-size-4': '70rem',
    '--button-height-1': '1.75rem',
    '--button-height-2': '2.5rem',
    '--button-height-3': '2.875rem',
    '--button-height-4': '3.25rem',
    '--button-padding-x-1': '0.75rem',
    '--button-padding-x-2': '1.125rem',
    '--button-padding-x-3': '1.35rem',
    '--button-padding-x-4': '1.6rem',
    '--ai-size-1': '1.75rem',
    '--ai-size-2': '2.5rem',
    '--ai-size-3': '2.875rem',
    '--ai-size-4': '3.25rem',
    '--input-height-1': '2rem',
    '--input-height-2': '2.5rem',
    '--input-height-3': '2.875rem',
    '--input-height-4': '3.25rem',
    '--input-padding-y-1': '0.35rem',
    '--input-padding-y-2': '0.5rem',
    '--input-padding-y-3': '0.625rem',
    '--input-padding-y-4': '0.75rem',
    '--checkbox-size-1': '0.95rem',
    '--checkbox-size-2': '1.1rem',
    '--checkbox-size-3': '1.25rem',
    '--badge-height-1': '1.2rem',
    '--badge-height-2': '1.45rem',
    '--badge-height-3': '1.7rem',
    '--badge-height-4': '1.95rem',
    '--badge-padding-x-1': '0.4rem',
    '--badge-padding-x-2': '0.55rem',
    '--badge-padding-x-3': '0.7rem',
    '--badge-padding-x-4': '0.85rem',
    '--badge-fz-1': '0.6875rem',
    '--badge-fz-2': '0.75rem',
    '--badge-fz-3': '0.8125rem',
    '--badge-fz-4': '0.875rem',
    '--gray-1': isDark ? dark[9] : '#ffffff',
    '--gray-2': isDark ? dark[8] : gray[0],
    '--gray-3': isDark ? dark[7] : gray[1],
    '--gray-4': isDark ? dark[6] : gray[2],
    '--gray-5': isDark ? dark[5] : gray[3],
    '--gray-6': isDark ? dark[4] : gray[4],
    '--gray-7': isDark ? dark[3] : gray[5],
    '--gray-8': isDark ? dark[2] : gray[6],
    '--gray-9': gray[6],
    '--gray-10': isDark ? gray[4] : gray[7],
    '--gray-11': isDark ? gray[2] : gray[8],
    '--gray-12': isDark ? gray[0] : gray[9],
    '--gray-a2': isDark ? 'rgba(255, 255, 255, 0.05)' : rgba(gray[9], 0.04),
    '--gray-a3': isDark ? 'rgba(255, 255, 255, 0.08)' : rgba(gray[9], 0.08),
    '--gray-a4': isDark ? 'rgba(255, 255, 255, 0.12)' : rgba(gray[9], 0.12),
    '--gray-a5': isDark ? 'rgba(255, 255, 255, 0.16)' : rgba(gray[9], 0.16),
    '--gray-a6': isDark ? 'rgba(255, 255, 255, 0.20)' : rgba(gray[9], 0.2),
    '--gray-a7': isDark ? 'rgba(255, 255, 255, 0.28)' : rgba(gray[9], 0.28),
    '--gray-a8': isDark ? 'rgba(255, 255, 255, 0.36)' : rgba(gray[9], 0.36),
    '--accent-2': isDark ? rgba(accent[4], 0.1) : accent[0],
    '--accent-3': isDark ? rgba(accent[4], 0.18) : accent[1],
    '--accent-8': isDark ? accent[4] : accent[5],
    '--accent-9': isDark ? accent[5] : accent[6],
    '--accent-11': isDark ? accent[2] : accent[8],
    '--accent-12': isDark ? accent[1] : accent[9],
    '--accent-a2': isDark ? rgba(accent[4], 0.08) : rgba(accent[6], 0.08),
    '--accent-a3': isDark ? rgba(accent[4], 0.12) : rgba(accent[6], 0.12),
    '--accent-a4': isDark ? rgba(accent[4], 0.18) : rgba(accent[6], 0.18),
    '--accent-a5': isDark ? rgba(accent[4], 0.24) : rgba(accent[6], 0.24),
    '--accent-a6': isDark ? rgba(accent[4], 0.32) : rgba(accent[6], 0.32),
    '--accent-a7': isDark ? rgba(accent[4], 0.42) : rgba(accent[6], 0.42),
    '--accent-contrast': '#ffffff',
    '--red-9': red[6],
    '--ruby-a3': rgba(ruby[5], 0.12),
    '--ruby-a5': rgba(ruby[6], 0.24),
    '--ruby-11': isDark ? ruby[2] : ruby[8],
  };
}
