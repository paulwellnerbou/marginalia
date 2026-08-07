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
import { needsBetterVoice, selectVoices } from './voices.js';

const VOICE_KEY = 'marginalia.readAloud.voice';
const RATE_KEY = 'marginalia.readAloud.rate';

export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

export type ReadAloudStatus = 'idle' | 'playing' | 'paused';

export interface ReadAloudController {
  /** False when the browser has no speech synthesis at all. */
  supported: boolean;
  status: ReadAloudStatus;
  /** 0-based position in the segment list; -1 when idle. */
  index: number;
  total: number;
  /** Voices offered in the picker, best first. */
  voices: SpeechSynthesisVoice[];
  voice: SpeechSynthesisVoice | null;
  setVoiceUri: (uri: string) => void;
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
  const [voiceUri, setVoiceUriState] = useState<string | null>(
    () => localStorage.getItem(VOICE_KEY) ?? null,
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

  const stop = useCallback(() => {
    genRef.current++;
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
    setStatus('playing');
  }, [synth]);

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

  const setVoiceUri = useCallback(
    (uri: string) => {
      localStorage.setItem(VOICE_KEY, uri);
      setVoiceUriState(uri);
      // Apply immediately: an utterance's voice is fixed once queued,
      // so the current sentence has to be spoken again.
      if (status !== 'idle' && index >= 0) speakFrom(index);
    },
    [index, speakFrom, status],
  );

  const setRate = useCallback(
    (next: number) => {
      localStorage.setItem(RATE_KEY, String(next));
      setRateState(next);
      if (status !== 'idle' && index >= 0) speakFrom(index);
    },
    [index, speakFrom, status],
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
    voices,
    voice,
    setVoiceUri,
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
