import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { expandAncestors } from '../heading-collapse.js';
import {
  goToPage,
  measurePages,
  PAGED_CLASS,
  pageIndexOfClientRect,
  revealElement,
} from '../paged-reading.js';
import { clearHighlight, paintSegment } from './highlight.js';
import { collectSegments, type ReadAloudSegment, resolveSegmentRange } from './segment.js';
import { needsBetterVoice, primaryLanguage, selectVoices, voiceLanguages } from './voices.js';

/** Suffixed with the primary language: a reader who listens in two
 *  languages picks a voice for each. The bare key is the older,
 *  language-blind choice, still honoured where it fits. */
const VOICE_KEY = 'marginalia.readAloud.voice';
const RATE_KEY = 'marginalia.readAloud.rate';

export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

const RATE_RESTART_DELAY_MS = 300;

/** The speeds the one-button speed control cycles through. */
export const RATE_STEPS = [0.5, 0.8, 1, 1.2, 1.5, 2] as const;

/**
 * The step after `rate`, wrapping to the slowest past the fastest. A
 * saved rate from between the steps rounds up to the next one rather
 * than jamming the control.
 */
export function nextRate(rate: number): number {
  return RATE_STEPS.find((step) => step > rate + 1e-9) ?? RATE_STEPS[0];
}

export type ReadAloudStatus = 'idle' | 'playing' | 'paused';

export interface ReadAloudController {
  /** False when the browser has no speech synthesis at all. */
  supported: boolean;
  status: ReadAloudStatus;
  /** 0-based position in the segment list; -1 when idle. */
  index: number;
  total: number;
  /** Primary subtags with at least one installed voice. */
  languages: string[];
  /** Voices offered in the picker, best first. */
  voices: SpeechSynthesisVoice[];
  voice: SpeechSynthesisVoice | null;
  setVoiceUri: (uri: string) => void;
  /** Call alongside a change the reader asked for that may resolve a
   *  different voice (a language pick), so the sentence in progress is
   *  spoken again in it. */
  expectVoiceChange: () => void;
  rate: number;
  setRate: (rate: number) => void;
  /** No installed voice matches the document's language. */
  missingLanguageVoice: boolean;
  /** Only compact OS voices available — suggest installing a better one. */
  showVoiceHint: boolean;
  error: string | null;
  play: () => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  next: () => void;
  previous: () => void;
}

interface Options {
  /** The `<article>` holding the rendered document. */
  rootRef: RefObject<HTMLElement | null>;
  /** Rendered HTML. A change replaces the DOM and invalidates segments. */
  htmlKey: string;
  /** BCP-47 tag the document should be read in. */
  lang: string;
}

export function useReadAloud({ rootRef, htmlKey, lang }: Options): ReadAloudController {
  const synth = typeof window === 'undefined' ? null : window.speechSynthesis;
  const supported = Boolean(synth);

  const [status, setStatus] = useState<ReadAloudStatus>('idle');
  const [index, setIndex] = useState(-1);
  const [total, setTotal] = useState(0);
  const [allVoices, setAllVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [error, setError] = useState<string | null>(null);
  const primary = primaryLanguage(lang);
  const [chosenVoices, setChosenVoices] = useState<Record<string, string>>({});
  const voiceUri = useMemo(
    () =>
      chosenVoices[primary] ??
      localStorage.getItem(`${VOICE_KEY}.${primary}`) ??
      localStorage.getItem(VOICE_KEY),
    [chosenVoices, primary],
  );
  const [rate, setRateState] = useState<number>(() => {
    const saved = Number(localStorage.getItem(RATE_KEY));
    return Number.isFinite(saved) && saved >= MIN_RATE && saved <= MAX_RATE ? saved : 1;
  });

  const segmentsRef = useRef<ReadAloudSegment[]>([]);
  /**
   * Bumped on every stop / jump. Utterance callbacks captured an older
   * value bail out, so a `cancel()` that lands after its utterance has
   * already queued the next one cannot restart playback. Same guard
   * shape as `scrollSeq` in RenderedDoc.
   */
  const genRef = useRef(0);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const indexRef = useRef(index);
  indexRef.current = index;
  const statusRef = useRef(status);
  statusRef.current = status;
  /** Set when a voice or rate change lands while paused: resuming the
   *  queued utterance would finish the sentence the old way, so resume
   *  speaks it again instead. */
  const restartOnResumeRef = useRef(false);

  // `getVoices()` is empty until the engine has enumerated them, and
  // Chrome only fires `voiceschanged` once that finishes.
  useEffect(() => {
    if (!synth) return;
    const load = () => setAllVoices(synth.getVoices());
    load();
    synth.addEventListener('voiceschanged', load);
    return () => synth.removeEventListener('voiceschanged', load);
  }, [synth]);

  const selection = useMemo(
    () => selectVoices(allVoices, lang, voiceUri),
    [allVoices, lang, voiceUri],
  );
  const { offered: voices, active: voice, missingLanguage: missingLanguageVoice } = selection;
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const languages = useMemo(() => voiceLanguages(allVoices), [allVoices]);

  const stop = useCallback(() => {
    genRef.current++;
    restartOnResumeRef.current = false;
    synth?.cancel();
    clearHighlight();
    setStatus('idle');
    setIndex(-1);
  }, [synth]);

  const reveal = useCallback((root: HTMLElement, segment: ReadAloudSegment) => {
    paintSegment(resolveSegmentRange(root, segment), segment.blockEl);
    void expandAncestors(segment.blockEl).then(() => {
      // Re-resolve after the section has finished expanding: the
      // range is unaffected, but the block only has its real
      // geometry once the collapse animation settles.
      if (!root.contains(segment.blockEl)) return;
      scrollIntoViewIfNeeded(root, segment.blockEl, resolveSegmentRange(root, segment));
    });
  }, []);

  const speakFrom = useCallback(
    (startIndex: number) => {
      const root = rootRef.current;
      if (!synth || !root) return;

      const segments = segmentsRef.current;
      const gen = ++genRef.current;
      restartOnResumeRef.current = false;
      const wasActive = synth.speaking || synth.pending;
      synth.cancel();

      const speakAt = (i: number) => {
        if (gen !== genRef.current) return;
        const segment = segments[i];
        if (!segment) {
          stop();
          return;
        }

        setIndex(i);
        reveal(root, segment);

        const utterance = new SpeechSynthesisUtterance(segment.text);
        const selected = voiceRef.current;
        if (selected) utterance.voice = selected;
        utterance.lang = selected?.lang ?? lang;
        utterance.rate = rateRef.current;
        utterance.onend = () => {
          if (gen !== genRef.current) return;
          speakAt(i + 1);
        };
        utterance.onerror = (event) => {
          if (gen !== genRef.current) return;
          // Our own cancel() landing late, not a real failure.
          if (event.error === 'interrupted' || event.error === 'canceled') return;
          setError(`Speech failed (${event.error}).`);
          stop();
        };
        synth.speak(utterance);
      };

      setError(null);
      setStatus('playing');
      // Chrome can drop a `speak()` issued in the same task as the
      // `cancel()` that preceded it. Deferring avoids that — but only
      // when something was actually playing, because the very first
      // `speak()` must stay inside the user's click for iOS Safari to
      // unlock audio at all.
      if (wasActive) {
        setTimeout(() => speakAt(startIndex), 0);
      } else {
        speakAt(startIndex);
      }
    },
    [lang, reveal, rootRef, stop, synth],
  );

  const play = useCallback(() => {
    const root = rootRef.current;
    if (!synth || !root) return;
    const segments = collectSegments(root, lang);
    segmentsRef.current = segments;
    setTotal(segments.length);
    if (segments.length === 0) {
      setError('Nothing to read in this document.');
      return;
    }
    speakFrom(0);
  }, [lang, rootRef, speakFrom, synth]);

  const pause = useCallback(() => {
    if (!synth) return;
    synth.pause();
    setStatus('paused');
  }, [synth]);

  const resume = useCallback(() => {
    if (!synth) return;
    synth.resume();
    if (restartOnResumeRef.current && indexRef.current >= 0) {
      speakFrom(indexRef.current);
      return;
    }
    setStatus('playing');
  }, [speakFrom, synth]);

  /** Re-speak the current sentence with the voice and rate as they are
   *  now — or, while paused, once the reader resumes. */
  const respeakCurrent = useCallback(() => {
    if (statusRef.current === 'idle' || indexRef.current < 0) return;
    if (statusRef.current === 'paused') restartOnResumeRef.current = true;
    else speakFrom(indexRef.current);
  }, [speakFrom]);

  const jump = useCallback(
    (delta: number) => {
      const segments = segmentsRef.current;
      if (segments.length === 0) return;
      const target = Math.min(Math.max(index + delta, 0), segments.length - 1);
      speakFrom(target);
    },
    [index, speakFrom],
  );

  const next = useCallback(() => jump(1), [jump]);
  const previous = useCallback(() => jump(-1), [jump]);

  /** Bumped by reader actions that may resolve a different voice. The
   *  bump renders together with the change it announces, so the effect
   *  below can tell a requested change from one nobody asked for. */
  const [voiceRequest, setVoiceRequest] = useState(0);
  const expectVoiceChange = useCallback(() => setVoiceRequest((n) => n + 1), []);

  const setVoiceUri = useCallback(
    (uri: string) => {
      localStorage.setItem(`${VOICE_KEY}.${primary}`, uri);
      setVoiceRequest((n) => n + 1);
      setChosenVoices((chosen) => ({ ...chosen, [primary]: uri }));
    },
    [primary],
  );

  // An utterance's voice is fixed once queued, so a voice the reader
  // picked (directly, or through the language) means speaking the
  // current sentence again. Changes nobody asked for — voices arriving
  // late, detection settling — take effect from the next sentence
  // instead of cutting one off.
  const voiceUriInUse = voice?.voiceURI ?? null;
  const lastVoiceUri = useRef(voiceUriInUse);
  const handledVoiceRequest = useRef(voiceRequest);
  useEffect(() => {
    const changed = lastVoiceUri.current !== voiceUriInUse;
    const requested = handledVoiceRequest.current !== voiceRequest;
    lastVoiceUri.current = voiceUriInUse;
    handledVoiceRequest.current = voiceRequest;
    if (changed && requested) respeakCurrent();
  }, [voiceUriInUse, voiceRequest, respeakCurrent]);

  /** Pending restart after a rate change. Speech can't change rate
   *  mid-utterance, so applying it means cancelling and re-speaking
   *  the sentence; a burst of taps on the cycling speed button should
   *  do that once, at the final rate, not once per tap. */
  const rateRestartRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setRate = useCallback(
    (next: number) => {
      localStorage.setItem(RATE_KEY, String(next));
      setRateState(next);
      if (rateRestartRef.current) clearTimeout(rateRestartRef.current);
      if (status === 'idle' || index < 0) return;
      const gen = genRef.current;
      rateRestartRef.current = setTimeout(() => {
        rateRestartRef.current = null;
        // Any other transport action in the meantime supersedes this
        // restart: a jump, stop or voice change bumps the generation,
        // pause and resume flip the status. A sentence advancing on its
        // own does neither, so restart wherever the reader is now
        // rather than where the tap happened.
        if (genRef.current !== gen || statusRef.current !== status) return;
        respeakCurrent();
      }, RATE_RESTART_DELAY_MS);
    },
    [index, respeakCurrent, status],
  );
  useEffect(
    () => () => {
      if (rateRestartRef.current) clearTimeout(rateRestartRef.current);
    },
    [],
  );

  // The document can be rewritten under us: a collaborator saves, or a
  // proposal is accepted, and RenderedDoc replaces the article's
  // innerHTML. Every captured block element is detached at that point,
  // so re-collect and continue at the same sentence text if it is still
  // there; otherwise give up rather than jumping somewhere arbitrary.
  // biome-ignore lint/correctness/useExhaustiveDependencies: htmlKey is the re-collect trigger; re-running on the callbacks it closes over would restart playback on unrelated renders.
  useEffect(() => {
    if (status === 'idle') return;
    const root = rootRef.current;
    if (!root) return;

    const spoken = segmentsRef.current[index] ?? null;
    const segments = collectSegments(root, lang);
    segmentsRef.current = segments;
    setTotal(segments.length);

    const resumeAt = spoken ? findResumeIndex(segments, spoken) : -1;
    if (resumeAt < 0) {
      stop();
      return;
    }
    if (status === 'paused') {
      // Stay paused. The queued utterance belongs to the old DOM, so its
      // callbacks are cut loose and resume speaks the sentence afresh.
      genRef.current++;
      setIndex(resumeAt);
      const segment = segments[resumeAt];
      if (segment) reveal(root, segment);
      restartOnResumeRef.current = true;
      return;
    }
    speakFrom(resumeAt);
  }, [htmlKey]);

  // Chrome keeps speaking after the page goes away unless told to stop.
  useEffect(() => {
    if (!synth) return;
    const cancel = () => synth.cancel();
    window.addEventListener('pagehide', cancel);
    return () => {
      window.removeEventListener('pagehide', cancel);
      genRef.current++;
      synth.cancel();
      clearHighlight();
    };
  }, [synth]);

  return {
    supported,
    status,
    index,
    total,
    languages,
    voices,
    voice,
    setVoiceUri,
    expectVoiceChange,
    rate,
    setRate,
    missingLanguageVoice,
    // Keyed on the best voice *available* for the language, not the one
    // selected — see `needsBetterVoice`. Suppressed when the language
    // isn't covered at all, since `missingLanguageVoice` says more.
    showVoiceHint: !missingLanguageVoice && needsBetterVoice(voices[0] ?? null),
    error,
    play,
    pause,
    resume,
    stop,
    next,
    previous,
  };
}

/**
 * Where to continue after the article was re-rendered.
 *
 * Block ids are content hashes, so an id match means the block's text
 * is byte-for-byte what it was; pinning id *and* offset identifies the
 * exact sentence even when the same wording occurs several times in
 * the document (repeated table cells, one-word list items), which
 * matching on text alone would resolve to the first occurrence.
 * Text-only is the fallback for blocks the renderer left unmarked.
 */
export function findResumeIndex(
  segments: readonly ReadAloudSegment[],
  previous: ReadAloudSegment,
): number {
  if (previous.blockId) {
    const exact = segments.findIndex(
      (segment) =>
        segment.blockId === previous.blockId &&
        segment.start === previous.start &&
        segment.text === previous.text,
    );
    if (exact >= 0) return exact;
  }
  return segments.findIndex((segment) => segment.text === previous.text);
}

/**
 * Scroll only when the block has drifted out of the comfortable middle
 * of the reading pane — following every sentence inside an already
 * visible paragraph would make the page twitch continuously. Paged mode
 * has an exact version of the same rule: stay put until the sentence
 * being read is no longer on the page in front of the reader.
 */
function scrollIntoViewIfNeeded(
  root: HTMLElement,
  block: HTMLElement,
  sentence: Range | null,
): void {
  const scroller = root.closest<HTMLElement>('.doc-scroll');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';
  const rect = block.getBoundingClientRect();

  if (scroller?.classList.contains(PAGED_CLASS)) {
    // Page from the sentence's own rect, never the block's. A paragraph
    // long enough to be worth reading aloud is long enough to fragment,
    // and its bounding rect is the union of those fragments — it names
    // the paragraph's first page throughout, which would drag the reader
    // back a page on every sentence after the break.
    const spoken = sentence?.getClientRects()[0] ?? block.getClientRects()[0];
    if (!spoken) return;
    const page = pageIndexOfClientRect(scroller, spoken);
    if (page === null || page === measurePages(scroller).currentPage) return;
    goToPage(scroller, page, behavior);
    return;
  }

  const bounds = scroller?.getBoundingClientRect() ?? {
    top: 0,
    bottom: window.innerHeight,
    height: window.innerHeight,
  };
  const margin = bounds.height * 0.15;
  if (rect.top >= bounds.top + margin && rect.bottom <= bounds.bottom - margin) return;

  revealElement(block, { behavior, block: 'center' });
}
