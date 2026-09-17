import {
  Cross2Icon,
  GlobeIcon,
  PauseIcon,
  PlayIcon,
  SpeakerLoudIcon,
  StopIcon,
  TrackNextIcon,
  TrackPreviousIcon,
} from '@radix-ui/react-icons';
import { Button, IconButton, Select, Text, Tooltip } from '@radix-ui/themes';
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { detectLanguage } from '../lib/read-aloud/detect-language.js';
import { sampleText } from '../lib/read-aloud/segment.js';
import { nextRate, useReadAloud } from '../lib/read-aloud/useReadAloud.js';
import { primaryLanguage, regionOf, resolveDocLang, withRegion } from '../lib/read-aloud/voices.js';
import { APP_ACCENT_COLOR } from '../styles/theme.js';

interface Props {
  /** Keys the reader's language choice, which belongs to the document. */
  docUid: string;
  /** The `<article>` holding the rendered document. */
  rootRef: RefObject<HTMLElement | null>;
  /** Rendered HTML; changes invalidate captured segments. */
  htmlKey: string;
  /** Document frontmatter — the author's chance to declare the language. */
  frontmatter: Record<string, unknown>;
  /** Width of the inline comments column, so the popover clears it. */
  inlineCommentsOffset: number;
  /** Element at the foot of the doc pane the transport renders into. */
  dock: HTMLElement | null;
}

const LANG_KEY = 'marginalia.readAloud.lang';
const AUTO_LANG = 'auto';
const DETECT_SAMPLE_CHARS = 20_000;

/**
 * Read-aloud ("Vorlesen") transport, sitting next to document search in
 * the doc toolbar. Speech runs on the browser's own synthesis engine,
 * so quality depends entirely on the voices the reader's OS has — hence
 * the voice picker and the hint when only a compact default is present.
 */
export function ReadAloudControls({
  docUid,
  rootRef,
  htmlKey,
  frontmatter,
  inlineCommentsOffset,
  dock,
}: Props) {
  const [open, setOpen] = useState(false);

  // Language, most specific first: what the reader picked for this
  // document, what the author declared, what the text looks like, and
  // only then the reader's own language. The page's `<html lang>` is the
  // UI's language and says nothing about the document.
  const [chosenLangs, setChosenLangs] = useState<Record<string, string | null>>({});
  const chosenLang = useMemo(
    () =>
      docUid in chosenLangs
        ? (chosenLangs[docUid] ?? null)
        : localStorage.getItem(`${LANG_KEY}.${docUid}`),
    [chosenLangs, docUid],
  );
  // Kept with the document it was detected in, so another document
  // never starts out in this one's language.
  const [detected, setDetected] = useState<{ docUid: string; lang: string | null } | null>(null);
  const detectedLang = detected?.docUid === docUid ? detected.lang : null;
  const autoLang = useMemo(
    () => resolveDocLang(frontmatter, detectedLang ?? navigator.language ?? 'en'),
    [frontmatter, detectedLang],
  );
  const lang = useMemo(
    () =>
      withRegion(
        chosenLang ?? autoLang,
        navigator.languages?.length ? navigator.languages : [navigator.language],
      ),
    [chosenLang, autoLang],
  );
  const reader = useReadAloud({ rootRef, htmlKey, lang });
  const setLanguage = (value: string) => {
    const key = `${LANG_KEY}.${docUid}`;
    const chosen = value === AUTO_LANG ? null : value;
    if (chosen) localStorage.setItem(key, chosen);
    else localStorage.removeItem(key);
    reader.expectVoiceChange();
    setChosenLangs((current) => ({ ...current, [docUid]: chosen }));
  };
  const languageOptions = useMemo(
    () =>
      reader.languages
        .map((code) => ({ code, name: languageName(code) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [reader.languages],
  );
  const langName = useMemo(() => languageName(primaryLanguage(lang)), [lang]);
  /** Region names for the voice list, when the voices on offer differ in
   *  region; otherwise the name alone says it. */
  const voiceRegions = useMemo(() => {
    const regions = reader.voices.map((voice) => regionOf(voice.lang));
    if (new Set(regions).size < 2) return null;
    return new Map(
      reader.voices.map((voice, i) => [voice.voiceURI, regionName(regions[i] ?? null)]),
    );
  }, [reader.voices]);

  const { status, stop } = reader;
  const playing = status === 'playing';
  const active = status !== 'idle';

  // Deferred a task: RenderedDoc writes the new HTML in its own effect,
  // which may run after this one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: htmlKey is the re-detect trigger; the text is read from the DOM.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      const root = rootRef.current;
      if (!root) return;
      setDetected({ docUid, lang: detectLanguage(sampleText(root, DETECT_SAMPLE_CHARS)) });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, htmlKey, rootRef, docUid]);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  /** Set around a programmatic focus of the trigger. Radix opens a
   *  tooltip on any focus not preceded by a pointerdown on that same
   *  trigger, and handing focus back should not raise a balloon. */
  const quietFocus = useRef(false);

  /** Close, returning focus to the trigger if it was inside the panel:
   *  the panel unmounts, and focus left on a removed element falls to
   *  the body, far from where the keyboard user was. */
  const close = useCallback(() => {
    const focused = document.activeElement;
    if (focused && dock?.contains(focused)) {
      quietFocus.current = true;
      triggerRef.current?.focus({ preventScroll: true });
      quietFocus.current = false;
    }
    setOpen(false);
  }, [dock]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // An Escape a dropdown already consumed must not also take the
      // panel with it.
      if (event.key === 'Escape' && !event.defaultPrevented) close();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, close]);

  /** The panel lives at the foot of the pane, after the whole document,
   *  so Tab from the trigger would never reach it: hand focus to the
   *  panel on open, the way document search hands it to its field. The
   *  wrapper rather than Play itself, whose tooltip would open on focus
   *  and then eat the first Escape. */
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() =>
      popoverRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  // A browser without speech synthesis gets no control at all rather
  // than a button that silently does nothing.
  if (!reader.supported) return null;

  // Three states, not two: without the paused case a screen reader
  // announces "Start reading aloud" on a control that will resume.
  const transportLabel = playing
    ? 'Pause reading'
    : status === 'paused'
      ? 'Continue reading'
      : 'Start reading aloud';

  const toggle = () => {
    if (status === 'idle') {
      reader.play();
      setOpen(true);
      return;
    }
    if (playing) reader.pause();
    else reader.resume();
  };

  const hint =
    reader.error ??
    (reader.missingLanguageVoice
      ? `No ${langName} voice on this device. Voices can be added in ${voiceSettings()}.`
      : // Advice for before listening, not a caption to read along with.
        reader.showVoiceHint && !active
        ? `Basic system voice. Better ones can be downloaded in ${voiceSettings()}.`
        : null);

  const progress = active && reader.total > 0 ? (reader.index + 1) / reader.total : 0;

  return (
    <>
      <Tooltip content={active ? 'Read-aloud controls' : 'Read this document aloud'}>
        <IconButton
          ref={triggerRef}
          variant="soft"
          color={APP_ACCENT_COLOR}
          size="2"
          className={`doc-search-trigger read-aloud-trigger ${open || active ? 'active' : ''}`}
          onClick={() => (open ? close() : setOpen(true))}
          onFocus={(event) => {
            if (quietFocus.current) event.preventDefault();
          }}
          aria-label={active ? 'Read-aloud controls' : 'Read this document aloud'}
          aria-pressed={open}
        >
          <SpeakerLoudIcon />
        </IconButton>
      </Tooltip>

      {open &&
        dock &&
        createPortal(
          <div
            ref={popoverRef}
            tabIndex={-1}
            className="read-aloud-popover"
            style={
              inlineCommentsOffset > 0
                ? ({
                    '--doc-search-inline-comments-offset': `${inlineCommentsOffset}px`,
                  } as React.CSSProperties)
                : undefined
            }
          >
            <section
              className="read-aloud-panel"
              aria-label="Read aloud"
              style={{ '--read-aloud-progress': progress } as React.CSSProperties}
            >
              <div className="read-aloud-main">
                <Tooltip content="Reading speed">
                  <Button
                    size="2"
                    variant="soft"
                    color="gray"
                    className="read-aloud-rate"
                    onClick={() => reader.setRate(nextRate(reader.rate))}
                    aria-label={`Reading speed ${reader.rate.toFixed(1)}×, change`}
                  >
                    {reader.rate.toFixed(1)}×
                  </Button>
                </Tooltip>

                <div className="read-aloud-transport">
                  <Tooltip content="Previous sentence">
                    <IconButton
                      size="2"
                      variant="ghost"
                      color="gray"
                      aria-label="Previous sentence"
                      onClick={reader.previous}
                      disabled={!active}
                    >
                      <TrackPreviousIcon />
                    </IconButton>
                  </Tooltip>
                  <Tooltip
                    content={playing ? 'Pause' : status === 'paused' ? 'Continue' : 'Read aloud'}
                  >
                    <IconButton
                      size="3"
                      variant="solid"
                      radius="full"
                      color={APP_ACCENT_COLOR}
                      className="read-aloud-play"
                      onClick={toggle}
                      aria-label={transportLabel}
                    >
                      {playing ? <PauseIcon /> : <PlayIcon />}
                    </IconButton>
                  </Tooltip>
                  <Tooltip content="Next sentence">
                    <IconButton
                      size="2"
                      variant="ghost"
                      color="gray"
                      aria-label="Next sentence"
                      onClick={reader.next}
                      disabled={!active}
                    >
                      <TrackNextIcon />
                    </IconButton>
                  </Tooltip>
                </div>

                <Tooltip content="Stop">
                  <IconButton
                    size="2"
                    variant="ghost"
                    color="gray"
                    className="read-aloud-stop"
                    aria-label="Stop reading"
                    onClick={stop}
                    disabled={!active}
                  >
                    <StopIcon />
                  </IconButton>
                </Tooltip>
              </div>

              <div className="read-aloud-settings">
                <Select.Root
                  size="2"
                  value={chosenLang ? primaryLanguage(chosenLang) : AUTO_LANG}
                  onValueChange={setLanguage}
                >
                  <Select.Trigger
                    variant="soft"
                    color="gray"
                    className="read-aloud-language"
                    aria-label={`Reading language: ${langName}`}
                  >
                    <span className="read-aloud-select-value">
                      <GlobeIcon aria-hidden />
                      <span>{langName}</span>
                    </span>
                  </Select.Trigger>
                  <Select.Content position="popper" style={{ maxHeight: 360 }}>
                    <Select.Item value={AUTO_LANG}>
                      Automatic ({languageName(primaryLanguage(autoLang))})
                    </Select.Item>
                    <Select.Separator />
                    {languageOptions.map(({ code, name }) => (
                      <Select.Item key={code} value={code}>
                        {name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>

                <Select.Root
                  size="2"
                  value={reader.voice?.voiceURI ?? ''}
                  onValueChange={reader.setVoiceUri}
                >
                  <Select.Trigger
                    variant="soft"
                    color="gray"
                    className="read-aloud-voice"
                    aria-label="Voice"
                    placeholder="Voice"
                  >
                    {reader.voice?.name}
                  </Select.Trigger>
                  <Select.Content position="popper" style={{ maxHeight: 360 }}>
                    {reader.voices.map((voice) => (
                      <Select.Item
                        key={voice.voiceURI}
                        value={voice.voiceURI}
                        textValue={voice.name}
                      >
                        {voice.name}
                        {voiceRegions?.get(voice.voiceURI) && (
                          <>
                            {' '}
                            <span className="read-aloud-voice-region">
                              {voiceRegions.get(voice.voiceURI)}
                            </span>
                          </>
                        )}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>

                <Text size="1" color="gray" className="read-aloud-position">
                  {active && reader.total > 0 ? `${reader.index + 1} / ${reader.total}` : ''}
                </Text>
                <IconButton
                  size="2"
                  variant="ghost"
                  color="gray"
                  className="read-aloud-close"
                  aria-label="Close read-aloud controls"
                  onClick={close}
                >
                  <Cross2Icon />
                </IconButton>
              </div>

              {hint && (
                <Text size="1" color={reader.error ? 'red' : 'gray'} className="read-aloud-hint">
                  {hint}
                </Text>
              )}
            </section>
          </div>,
          dock,
        )}
    </>
  );
}

/** A language's name in that language — "Deutsch", "Français" — so
 *  readers find theirs whatever language the app is in. */
function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if (name && name !== code) return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    // Not a tag Intl knows.
  }
  return code;
}

let regionNames: Intl.DisplayNames | null | undefined;

function regionName(region: string | null): string {
  if (!region) return '';
  if (regionNames === undefined) {
    try {
      regionNames = new Intl.DisplayNames(undefined, { type: 'region' });
    } catch {
      regionNames = null;
    }
  }
  try {
    return regionNames?.of(region) ?? region;
  } catch {
    return region;
  }
}

/**
 * Where to get more voices. The stock ones (Anna, Samantha, and their
 * equivalents elsewhere) are compact engines that get tiring over a long
 * document; better ones ship with the OS but have to be downloaded, and
 * only Apple's platforms have a single place to name.
 */
function voiceSettings(): string {
  const platform = navigator.platform || '';
  // iPadOS reports itself as a Mac; the touch screen gives it away.
  const isIOS =
    /iPhone|iPad|iPod/.test(platform) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (isIOS) return 'Settings → Accessibility → Spoken Content → Voices';
  if (/Mac/.test(platform)) {
    return 'System Settings → Accessibility → Spoken Content → System Voice → Manage Voices';
  }
  return 'your system’s speech settings';
}
