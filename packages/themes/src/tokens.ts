/**
 * Structured theme tokens — the non-CSS surface of @marginalia/themes.
 *
 * Themes themselves are CSS (see css/*.css) and that remains the source of
 * truth for rendering in the browser. These tokens mirror those CSS
 * custom properties in a structured form so non-CSS consumers — the
 * DOCX exporter today, future PDF/print generators tomorrow — can
 * produce output that *looks* like the selected theme without having to
 * parse and evaluate CSS.
 *
 * Kept in CSS-native units (points for font size, ems for spacing, hex
 * for colors) so a reader can diff them against the CSS file and spot
 * drift quickly. Consumers convert to their target units (DOCX wants
 * twips, half-points, eighths of a point).
 */

export interface FontStack {
  /** Font family names in fallback order. No quoting — add quotes when emitting. */
  readonly families: readonly string[];
}

export interface ThemeTokens {
  /** Theme id, matching the CSS filename and the BUILT_IN_THEMES id. */
  readonly id: string;
  /** Human-readable label (matches BUILT_IN_THEMES[].label in apps/web). */
  readonly label: string;

  readonly fonts: {
    readonly body: FontStack;
    readonly heading: FontStack;
    readonly mono: FontStack;
  };

  readonly fontSize: {
    /** Base body font size in points. */
    readonly basePt: number;
    /** Heading sizes as multipliers of the base size (em-equivalent). */
    readonly h1Em: number;
    readonly h2Em: number;
    readonly h3Em: number;
    readonly h4Em: number;
    readonly h5Em: number;
    readonly h6Em: number;
  };

  readonly lineHeight: {
    /** Unitless body line-height multiplier. */
    readonly body: number;
    /** Unitless heading line-height multiplier. */
    readonly heading: number;
  };

  /** CSS-style font weight (100–900). */
  readonly headingWeight: number;
  /** Letter-spacing in ems. Negative tightens. */
  readonly headingLetterSpacingEm: number;

  /**
   * Headings that render in ALL CAPS in this theme. We translate to a
   * character-level transform in DOCX because DOCX doesn't have a native
   * "CSS text-transform" attribute.
   */
  readonly headingUppercase: {
    readonly h1: boolean;
    readonly h2: boolean;
    readonly h3: boolean;
    readonly h4: boolean;
    readonly h5: boolean;
    readonly h6: boolean;
  };

  readonly colors: {
    readonly fg: string;
    readonly fgMuted: string;
    readonly bg: string;
    readonly accent: string;
    readonly accentMuted: string;
    readonly border: string;
    readonly codeBg: string;
    readonly codeFg: string;
    readonly quoteBar: string;
    readonly tableStripe: string;
  };

  readonly spacing: {
    /** Space between top-level blocks, as em-multiplier of base. */
    readonly blockEm: number;
    /** Extra space above headings, as em-multiplier of base. */
    readonly headingTopEm: number;
    /** Gap between list items, as em-multiplier of base. */
    readonly listItemEm: number;
  };

  readonly page: {
    readonly size: 'A4' | 'Letter' | 'A5' | 'B5';
    /** Uniform page margin in points (36pt ≈ 0.5in, 72pt = 1in). */
    readonly marginPt: number;
  };

  readonly blockquote: {
    readonly italic: boolean;
    /** Whether to render a left border bar. `false` for pull-quote themes. */
    readonly hasBar: boolean;
  };

  readonly table: {
    /** Header row has a heavier bottom border (matches most CSS themes). */
    readonly headerUnderline: boolean;
    /** Alternate row shading. */
    readonly zebra: boolean;
  };
}

// -- Font stacks, pulled verbatim from the CSS --------------------------

const SYSTEM_SANS: FontStack = {
  families: [
    'ui-sans-serif',
    'system-ui',
    '-apple-system',
    'Segoe UI',
    'Roboto',
    'Helvetica Neue',
    'Arial',
    'sans-serif',
  ],
};

const SYSTEM_MONO: FontStack = {
  families: [
    'ui-monospace',
    'SF Mono',
    'JetBrains Mono',
    'Fira Code',
    'Menlo',
    'Consolas',
    'monospace',
  ],
};

const CLASSIC_SERIF: FontStack = {
  families: [
    'Iowan Old Style',
    'Palatino Linotype',
    'Palatino',
    'Book Antiqua',
    'Georgia',
    'Times New Roman',
    'serif',
  ],
};

const EDITORIAL_BODY_SERIF: FontStack = {
  families: [
    'Iowan Old Style',
    'Palatino Linotype',
    'Palatino',
    'Book Antiqua',
    'Charter',
    'Georgia',
    'serif',
  ],
};

const FRAUNCES_DISPLAY: FontStack = {
  families: ['Fraunces', 'Iowan Old Style', 'Source Serif Pro', 'Georgia', 'serif'],
};

const CHARTER_BODY: FontStack = {
  families: ['Charter', 'Iowan Old Style', 'Source Serif Pro', 'Georgia', 'serif'],
};

const INTER_SANS: FontStack = {
  families: [
    'Inter',
    'ui-sans-serif',
    'system-ui',
    '-apple-system',
    'Segoe UI',
    'Roboto',
    'Helvetica Neue',
    'Arial',
    'sans-serif',
  ],
};

const JETBRAINS_MONO: FontStack = {
  families: [
    'JetBrains Mono',
    'ui-monospace',
    'SF Mono',
    'Fira Code',
    'Menlo',
    'Consolas',
    'monospace',
  ],
};

// -- Helpers ------------------------------------------------------------

/** CSS px → points (CSS convention: 1px = 0.75pt). */
const pxPt = (px: number): number => Number((px * 0.75).toFixed(3));

// -- Per-theme tokens ---------------------------------------------------

const defaultTokens: ThemeTokens = {
  id: 'default',
  label: 'Default',
  fonts: { body: SYSTEM_SANS, heading: SYSTEM_SANS, mono: SYSTEM_MONO },
  fontSize: {
    basePt: pxPt(17),
    h1Em: 2.1,
    h2Em: 1.55,
    h3Em: 1.25,
    h4Em: 1.05,
    h5Em: 0.95,
    h6Em: 0.85,
  },
  lineHeight: { body: 1.65, heading: 1.25 },
  headingWeight: 650,
  headingLetterSpacingEm: -0.01,
  headingUppercase: {
    h1: false,
    h2: false,
    h3: false,
    h4: false,
    h5: true,
    h6: true,
  },
  colors: {
    fg: '#1c1f23',
    fgMuted: '#5c6470',
    bg: '#ffffff',
    accent: '#2465e0',
    accentMuted: '#c7daf7',
    border: '#e4e8ee',
    codeBg: '#f4f6fa',
    codeFg: '#202326',
    quoteBar: '#c9d1dc',
    tableStripe: '#f8f9fb',
  },
  spacing: { blockEm: 1.2, headingTopEm: 2, listItemEm: 0.3 },
  page: { size: 'A4', marginPt: 72 },
  blockquote: { italic: true, hasBar: true },
  table: { headerUnderline: true, zebra: true },
};

const beautifulTokens: ThemeTokens = {
  id: 'beautiful',
  label: 'Book',
  fonts: { body: EDITORIAL_BODY_SERIF, heading: FRAUNCES_DISPLAY, mono: SYSTEM_MONO },
  fontSize: {
    basePt: pxPt(19),
    h1Em: 3.0,
    h2Em: 1.9,
    h3Em: 1.35,
    h4Em: 1.05,
    h5Em: 0.82,
    h6Em: 0.82,
  },
  lineHeight: { body: 1.72, heading: 1.15 },
  headingWeight: 500,
  headingLetterSpacingEm: -0.015,
  headingUppercase: {
    h1: false,
    h2: false,
    h3: false,
    h4: true,
    h5: true,
    h6: true,
  },
  colors: {
    fg: '#1a1712',
    fgMuted: '#736a5c',
    bg: '#fbf8f1',
    accent: '#1f3864',
    accentMuted: '#c9d1e0',
    border: '#e2dccd',
    codeBg: '#f3ede0',
    codeFg: '#22201b',
    // CSS sets quote-bar transparent for a no-bar pull-quote look; keep
    // an accent-tinted value here so if a consumer ignores hasBar=false
    // it still reads as intentional.
    quoteBar: '#1f3864',
    tableStripe: '#f5efe3',
  },
  spacing: { blockEm: 1.25, headingTopEm: 2.4, listItemEm: 0.3 },
  page: { size: 'A4', marginPt: 90 },
  blockquote: { italic: true, hasBar: false },
  table: { headerUnderline: true, zebra: true },
};

const bookTokens: ThemeTokens = {
  id: 'book',
  label: 'Document',
  fonts: { body: CLASSIC_SERIF, heading: CLASSIC_SERIF, mono: SYSTEM_MONO },
  fontSize: {
    basePt: pxPt(18),
    h1Em: 2.2,
    h2Em: 1.5,
    h3Em: 1.25,
    h4Em: 1.05,
    h5Em: 0.95,
    h6Em: 0.85,
  },
  lineHeight: { body: 1.75, heading: 1.3 },
  headingWeight: 600,
  headingLetterSpacingEm: 0,
  headingUppercase: {
    h1: false,
    h2: false,
    h3: false,
    h4: false,
    h5: true,
    h6: true,
  },
  colors: {
    fg: '#1a1915',
    fgMuted: '#6a655a',
    bg: '#fbf9f4',
    accent: '#3a2c1e',
    accentMuted: '#c9b99a',
    border: '#d9cfb8',
    codeBg: '#f3ecdd',
    codeFg: '#202326',
    quoteBar: '#bbae95',
    tableStripe: '#f5efe1',
  },
  spacing: { blockEm: 1.3, headingTopEm: 2.4, listItemEm: 0.3 },
  // A4 with generous inner margins. A5 would be truer to the "book"
  // metaphor, but users export DOCX to share/edit on standard office
  // paper — A5 surprises more often than it delights. Reach for A5
  // explicitly via `options.pageSize` when you really want it.
  page: { size: 'A4', marginPt: 90 },
  blockquote: { italic: true, hasBar: true },
  table: { headerUnderline: true, zebra: true },
};

const articleTokens: ThemeTokens = {
  id: 'article',
  label: 'Article',
  fonts: { body: CHARTER_BODY, heading: INTER_SANS, mono: SYSTEM_MONO },
  fontSize: {
    basePt: pxPt(18),
    h1Em: 2.1,
    h2Em: 1.55,
    h3Em: 1.25,
    h4Em: 1.05,
    h5Em: 0.95,
    h6Em: 0.85,
  },
  lineHeight: { body: 1.7, heading: 1.15 },
  headingWeight: 720,
  headingLetterSpacingEm: -0.02,
  headingUppercase: {
    h1: false,
    h2: false,
    h3: false,
    h4: false,
    h5: true,
    h6: true,
  },
  colors: {
    fg: '#1c1812',
    fgMuted: '#736a60',
    bg: '#fffdf9',
    accent: '#b8360a',
    accentMuted: '#f5d3c2',
    border: '#e8ded0',
    codeBg: '#f6efe2',
    codeFg: '#202326',
    // CSS: --md-color-quote-bar: var(--md-color-accent)
    quoteBar: '#b8360a',
    tableStripe: '#faf4e9',
  },
  spacing: { blockEm: 1.2, headingTopEm: 2, listItemEm: 0.3 },
  page: { size: 'A4', marginPt: 72 },
  blockquote: { italic: true, hasBar: true },
  table: { headerUnderline: true, zebra: true },
};

const technicalTokens: ThemeTokens = {
  id: 'technical',
  label: 'Technical',
  fonts: { body: INTER_SANS, heading: INTER_SANS, mono: JETBRAINS_MONO },
  fontSize: {
    basePt: pxPt(15),
    h1Em: 2.1,
    h2Em: 1.55,
    h3Em: 1.25,
    h4Em: 1.05,
    h5Em: 0.95,
    h6Em: 0.85,
  },
  lineHeight: { body: 1.55, heading: 1.25 },
  headingWeight: 600,
  headingLetterSpacingEm: -0.005,
  headingUppercase: {
    h1: false,
    h2: false,
    h3: false,
    h4: false,
    h5: true,
    h6: true,
  },
  colors: {
    fg: '#17202a',
    fgMuted: '#5a6676',
    bg: '#ffffff',
    accent: '#0b7cc0',
    accentMuted: '#bcddf3',
    border: '#dde3ec',
    codeBg: '#f2f4f8',
    codeFg: '#0c1424',
    quoteBar: '#b8c6d6',
    tableStripe: '#f6f8fb',
  },
  spacing: { blockEm: 1.0, headingTopEm: 1.8, listItemEm: 0.3 },
  page: { size: 'A4', marginPt: 54 },
  blockquote: { italic: true, hasBar: true },
  table: { headerUnderline: true, zebra: true },
};

const serifPrintTokens: ThemeTokens = {
  id: 'serif-print',
  label: 'Serif (Print)',
  fonts: { body: CLASSIC_SERIF, heading: CLASSIC_SERIF, mono: SYSTEM_MONO },
  fontSize: {
    basePt: 12,
    h1Em: 2.1,
    h2Em: 1.55,
    h3Em: 1.25,
    h4Em: 1.05,
    h5Em: 0.95,
    h6Em: 0.85,
  },
  lineHeight: { body: 1.55, heading: 1.25 },
  headingWeight: 600,
  headingLetterSpacingEm: 0,
  headingUppercase: {
    h1: false,
    h2: false,
    h3: false,
    h4: false,
    h5: true,
    h6: true,
  },
  colors: {
    fg: '#111111',
    fgMuted: '#555555',
    bg: '#ffffff',
    accent: '#000000',
    accentMuted: '#888888',
    border: '#aaaaaa',
    codeBg: '#f2f2f2',
    codeFg: '#111111',
    quoteBar: '#999999',
    tableStripe: '#fafafa',
  },
  spacing: { blockEm: 1.2, headingTopEm: 2, listItemEm: 0.3 },
  page: { size: 'A4', marginPt: 72 },
  blockquote: { italic: true, hasBar: true },
  table: { headerUnderline: true, zebra: true },
};

// -- Public map & accessor ---------------------------------------------

export const THEME_TOKENS: Readonly<Record<string, ThemeTokens>> = Object.freeze({
  default: defaultTokens,
  beautiful: beautifulTokens,
  book: bookTokens,
  article: articleTokens,
  technical: technicalTokens,
  'serif-print': serifPrintTokens,
});

export const THEME_IDS: readonly string[] = Object.freeze(Object.keys(THEME_TOKENS));

/**
 * Resolve a theme id to its tokens. Unknown ids fall back to the
 * `default` theme — matches the runtime behavior of `applyTheme` in
 * `apps/web/src/lib/themes.ts`, which warns and no-ops on unknown ids.
 */
export function getThemeTokens(id: string | null | undefined): ThemeTokens {
  if (!id) return defaultTokens;
  return THEME_TOKENS[id] ?? defaultTokens;
}
