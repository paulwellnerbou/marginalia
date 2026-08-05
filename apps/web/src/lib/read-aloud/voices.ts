/**
 * Picking a voice, and telling the reader when the ones they have are
 * not worth listening to.
 *
 * Browser TTS quality is decided entirely by which voices the operating
 * system has installed, and the defaults are poor: a fresh macOS offers
 * `Anna` for German and `Samantha` for English — both compact voices
 * from the concatenative era — while the genuinely good Premium /
 * Enhanced variants exist but must be downloaded by hand. Ranking makes
 * the app pick the best available voice instead of the OS default, and
 * `needsBetterVoice` drives a one-line hint pointing at the download.
 */

/** Structural subset of `SpeechSynthesisVoice`, so this stays testable. */
export interface VoiceLike {
  name: string;
  lang: string;
  voiceURI: string;
  localService: boolean;
}

export const VOICE_TIER = {
  /** Joke and character voices — never auto-selected. */
  novelty: 0,
  /** Compact OS default (Anna, Samantha). Understandable, tiring. */
  compact: 1,
  /** Server-side voice, e.g. Chrome's "Google Deutsch". Good, but the
   *  text is sent to the vendor to be synthesized. */
  network: 2,
  enhanced: 3,
  premium: 4,
} as const;

/**
 * macOS ships these alongside the real voices. They are compact-tier
 * engines with a costume on, and a document read by "Grandpa" or
 * "Zarvox" is not what anyone pressing play wanted.
 */
const NOVELTY_VOICES = new Set(
  [
    'Albert',
    'Bad News',
    'Bahh',
    'Bells',
    'Boing',
    'Bubbles',
    'Cellos',
    'Eddy',
    'Flo',
    'Fred',
    'Good News',
    'Grandma',
    'Grandpa',
    'Jester',
    'Junior',
    'Kathy',
    'Organ',
    'Ralph',
    'Reed',
    'Rocko',
    'Sandy',
    'Shelley',
    'Superstar',
    'Trinoids',
    'Whisper',
    'Wobble',
    'Zarvox',
  ].map((name) => name.toLowerCase()),
);

export function voiceTier(voice: VoiceLike): number {
  const name = voice.name.toLowerCase();
  if (/\(premium\)/.test(name)) return VOICE_TIER.premium;
  if (/\(enhanced\)/.test(name)) return VOICE_TIER.enhanced;
  // Names arrive as "Eddy (German (Germany))" — match the leading part.
  const bare = (name.split('(')[0] ?? name).trim();
  if (NOVELTY_VOICES.has(bare)) return VOICE_TIER.novelty;
  if (!voice.localService) return VOICE_TIER.network;
  return VOICE_TIER.compact;
}

/** Primary subtag, lowercased: `de-DE` → `de`. */
export function primaryLanguage(tag: string): string {
  return (tag.split(/[-_]/)[0] ?? '').toLowerCase();
}

/**
 * POSIX-style tags (`de_DE`, `sr_Latn_RS`) show up in OS voice lists
 * while documents and the Web Speech API use hyphens. Unify on hyphens,
 * every separator — not just the first.
 */
function hyphenate(tag: string): string {
  return tag.replace(/_/g, '-');
}

/** Case- and separator-insensitive form, for comparing two tags. */
function comparableTag(tag: string): string {
  return hyphenate(tag).toLowerCase();
}

/**
 * Voices usable for `lang`, best first. Filtered to the language —
 * an English voice reading German is unusable regardless of its tier.
 */
export function rankVoices<T extends VoiceLike>(voices: readonly T[], lang: string): T[] {
  const primary = primaryLanguage(lang);
  const wanted = comparableTag(lang);

  return voices
    .filter((voice) => primaryLanguage(voice.lang) === primary)
    .map((voice, index) => ({
      voice,
      index,
      tier: voiceTier(voice),
      // Prefer the exact region when the document asked for one.
      exact: comparableTag(voice.lang) === wanted ? 1 : 0,
    }))
    .sort(
      (a, b) =>
        b.tier - a.tier ||
        b.exact - a.exact ||
        a.voice.name.localeCompare(b.voice.name) ||
        a.index - b.index,
    )
    .map((entry) => entry.voice);
}

/**
 * The voice to speak with: the reader's saved choice when it is still
 * installed and still matches the document language, otherwise the best
 * available one.
 */
export function pickVoice<T extends VoiceLike>(
  voices: readonly T[],
  lang: string,
  savedVoiceUri: string | null,
): T | null {
  const ranked = rankVoices(voices, lang);
  if (savedVoiceUri) {
    const saved = ranked.find((voice) => voice.voiceURI === savedVoiceUri);
    if (saved) return saved;
  }
  return ranked[0] ?? null;
}

export interface VoiceSelection<T extends VoiceLike> {
  /** Voices to offer in the picker, best first. */
  offered: T[];
  /** The voice to speak with. */
  active: T | null;
  /** Voices are installed, but none for the document's language. */
  missingLanguage: boolean;
}

/**
 * Everything the UI needs about voices, in one place: what to list, what
 * to speak with, and whether the document's language is covered at all.
 */
export function selectVoices<T extends VoiceLike>(
  all: readonly T[],
  lang: string,
  savedVoiceUri: string | null,
): VoiceSelection<T> {
  const ranked = rankVoices(all, lang);
  if (ranked.length > 0) {
    return { offered: ranked, active: pickVoice(all, lang, savedVoiceUri), missingLanguage: false };
  }

  // Nothing for this language: offer every installed voice rather than
  // an empty picker, and resolve the saved pick against that same full
  // list — `pickVoice` filters by language, so it could only ever
  // return null here and the reader's choice would be discarded.
  const explicit = savedVoiceUri
    ? (all.find((voice) => voice.voiceURI === savedVoiceUri) ?? null)
    : null;
  return {
    offered: [...all],
    active: explicit ?? all[0] ?? null,
    missingLanguage: all.length > 0,
  };
}

/**
 * True when `best` is only a compact OS default, i.e. the reader would
 * get noticeably better results by installing a voice.
 *
 * Pass the top of `rankVoices`, not the reader's current selection:
 * someone who deliberately picked a lesser voice while a Premium one is
 * installed should not be told to go and install one.
 */
export function needsBetterVoice(best: VoiceLike | null): boolean {
  return best !== null && voiceTier(best) <= VOICE_TIER.compact;
}

const LANG_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * Language to read the document in. Frontmatter wins — it is the only
 * place the author can state it — then whatever the page/browser says.
 */
export function resolveDocLang(
  frontmatter: Record<string, unknown> | undefined,
  fallback: string,
): string {
  for (const key of ['lang', 'language', 'locale']) {
    const value = frontmatter?.[key];
    if (typeof value !== 'string') continue;
    // Authors write either `de-DE` or the POSIX-style `de_DE`. Case is
    // preserved — BCP-47 conventionally capitalizes region subtags.
    const normalized = hyphenate(value.trim());
    if (LANG_TAG.test(normalized)) return normalized;
  }
  return fallback;
}
