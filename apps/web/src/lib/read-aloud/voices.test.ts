import { describe, expect, test } from 'bun:test';
import {
  needsBetterVoice,
  pickVoice,
  primaryLanguage,
  rankVoices,
  resolveDocLang,
  VOICE_TIER,
  type VoiceLike,
  voiceTier,
} from './voices.js';

function voice(name: string, lang: string, localService = true): VoiceLike {
  return { name, lang, voiceURI: `urn:${name}`, localService };
}

// Names taken verbatim from `say -v '?'` on macOS.
const anna = voice('Anna', 'de_DE');
const petraPremium = voice('Petra (Premium)', 'de-DE');
const annaEnhanced = voice('Anna (Enhanced)', 'de-DE');
const googleGerman = voice('Google Deutsch', 'de-DE', false);
const grandpa = voice('Grandpa (German (Germany))', 'de_DE');
const samantha = voice('Samantha', 'en_US');

describe('voiceTier', () => {
  test('ranks premium and enhanced above the compact default', () => {
    expect(voiceTier(petraPremium)).toBe(VOICE_TIER.premium);
    expect(voiceTier(annaEnhanced)).toBe(VOICE_TIER.enhanced);
    expect(voiceTier(anna)).toBe(VOICE_TIER.compact);
  });

  test('treats a non-local voice as network tier', () => {
    expect(voiceTier(googleGerman)).toBe(VOICE_TIER.network);
  });

  test('demotes novelty voices below everything', () => {
    expect(voiceTier(grandpa)).toBe(VOICE_TIER.novelty);
    expect(voiceTier(voice('Zarvox', 'en_US'))).toBe(VOICE_TIER.novelty);
    expect(voiceTier(voice('Bad News', 'en_US'))).toBe(VOICE_TIER.novelty);
  });
});

describe('rankVoices', () => {
  test('keeps only voices for the requested language', () => {
    expect(rankVoices([anna, samantha], 'de-DE')).toEqual([anna]);
  });

  test('matches on the primary subtag, ignoring separator style', () => {
    // `say` reports de_DE, the Web Speech API reports de-DE.
    expect(rankVoices([anna], 'de')).toEqual([anna]);
    expect(rankVoices([anna], 'de-AT')).toEqual([anna]);
  });

  test('orders best first', () => {
    const ranked = rankVoices([anna, grandpa, googleGerman, petraPremium], 'de-DE');
    expect(ranked).toEqual([petraPremium, googleGerman, anna, grandpa]);
  });

  test('prefers the exact region within a tier', () => {
    const atVoice = voice('Regional', 'de-AT');
    const deVoice = voice('Standard', 'de-DE');
    expect(rankVoices([atVoice, deVoice], 'de-AT')[0]).toEqual(atVoice);
  });

  test('returns nothing when no voice matches', () => {
    expect(rankVoices([samantha], 'de-DE')).toEqual([]);
  });
});

describe('pickVoice', () => {
  test('honours a saved choice', () => {
    expect(pickVoice([anna, petraPremium], 'de-DE', anna.voiceURI)).toEqual(anna);
  });

  test('falls back to the best voice when the saved one is gone', () => {
    expect(pickVoice([anna, petraPremium], 'de-DE', 'urn:Uninstalled')).toEqual(petraPremium);
  });

  test('ignores a saved voice from another language', () => {
    expect(pickVoice([anna, samantha], 'de-DE', samantha.voiceURI)).toEqual(anna);
  });

  test('returns null when there is nothing to pick', () => {
    expect(pickVoice([], 'de-DE', null)).toBeNull();
  });
});

describe('needsBetterVoice', () => {
  test('prompts when only a compact voice is available', () => {
    expect(needsBetterVoice(anna)).toBe(true);
    expect(needsBetterVoice(grandpa)).toBe(true);
  });

  test('stays quiet once a good voice is in use', () => {
    expect(needsBetterVoice(petraPremium)).toBe(false);
    expect(needsBetterVoice(googleGerman)).toBe(false);
  });

  test('says nothing when there is no voice at all', () => {
    expect(needsBetterVoice(null)).toBe(false);
  });
});

describe('resolveDocLang', () => {
  test('prefers frontmatter', () => {
    expect(resolveDocLang({ lang: 'de' }, 'en-US')).toBe('de');
    expect(resolveDocLang({ language: 'de-AT' }, 'en-US')).toBe('de-AT');
    expect(resolveDocLang({ locale: 'fr_FR' }, 'en-US')).toBe('fr-FR');
  });

  test('ignores values that are not language tags', () => {
    expect(resolveDocLang({ lang: 'Deutsch (Deutschland)' }, 'en-US')).toBe('en-US');
    expect(resolveDocLang({ lang: 42 }, 'en-US')).toBe('en-US');
    expect(resolveDocLang({}, 'en-US')).toBe('en-US');
    expect(resolveDocLang(undefined, 'en-US')).toBe('en-US');
  });
});

describe('primaryLanguage', () => {
  test('extracts the primary subtag', () => {
    expect(primaryLanguage('de-DE')).toBe('de');
    expect(primaryLanguage('de_DE')).toBe('de');
    expect(primaryLanguage('DE')).toBe('de');
  });
});
