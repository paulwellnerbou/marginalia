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
 * Voices usable for `lang`, best first. Filtered to the language —
 * an English voice reading German is unusable regardless of its tier.
 */
export function rankVoices<T extends VoiceLike>(voices: readonly T[], lang: string): T[] {
  const primary = primaryLanguage(lang);
  const wanted = lang.toLowerCase().replace('_', '-');

  return voices
    .filter((voice) => primaryLanguage(voice.lang) === primary)
    .map((voice, index) => ({
      voice,
      index,
      tier: voiceTier(voice),
      // Prefer the exact region when the document asked for one.
      exact: voice.lang.toLowerCase().replace('_', '-') === wanted ? 1 : 0,
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

/**
 * True when the best available voice is a compact OS default, i.e. the
 * reader would get noticeably better results by installing one.
 */
export function needsBetterVoice(voice: VoiceLike | null): boolean {
  return voice !== null && voiceTier(voice) <= VOICE_TIER.compact;
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
    // Authors write either `de-DE` or the POSIX-style `de_DE`.
    const normalized = value.trim().replace(/_/g, '-');
    if (LANG_TAG.test(normalized)) return normalized;
  }
  return fallback;
}
