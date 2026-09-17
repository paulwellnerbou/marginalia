import {
  Cross2Icon,
  PauseIcon,
  PlayIcon,
  SpeakerLoudIcon,
  StopIcon,
  TrackNextIcon,
  TrackPreviousIcon,
} from '@radix-ui/react-icons';
import { Button, Flex, IconButton, Select, Text, Tooltip } from '@radix-ui/themes';
import {
  type Ref,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { nextRate, useReadAloud } from '../lib/read-aloud/useReadAloud.js';
import { resolveDocLang } from '../lib/read-aloud/voices.js';
import { APP_ACCENT_COLOR } from '../styles/theme.js';

interface Props {
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
  ref?: Ref<ReadAloudHandle> | undefined;
  /**
   * The overflow button the trigger is folded into. While set, no trigger
   * renders and closing the panel returns focus here instead.
   */
  foldedInto?: RefObject<HTMLElement | null> | undefined;
  /** What an overflow menu needs to stand in for the trigger. */
  onStateChange?: ((state: ReadAloudState) => void) | undefined;
}

export interface ReadAloudHandle {
  toggle(): void;
}

export interface ReadAloudState {
  supported: boolean;
  /** The transport panel is showing. */
  open: boolean;
  /** Reading or paused: a session is under way, panel or not. */
  active: boolean;
}

/**
 * Read-aloud ("Vorlesen") transport, sitting next to document search in
 * the doc toolbar. Speech runs on the browser's own synthesis engine,
 * so quality depends entirely on the voices the reader's OS has — hence
 * the voice picker and the hint when only a compact default is present.
 */
export function ReadAloudControls({
  rootRef,
  htmlKey,
  frontmatter,
  inlineCommentsOffset,
  dock,
  ref,
  foldedInto,
  onStateChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const lang = useMemo(
    () => resolveDocLang(frontmatter, document.documentElement.lang || navigator.language || 'en'),
    [frontmatter],
  );
  const reader = useReadAloud({ rootRef, htmlKey, lang });

  const { status, stop } = reader;
  const playing = status === 'playing';
  const active = status !== 'idle';

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
      (foldedInto ?? triggerRef).current?.focus({ preventScroll: true });
      quietFocus.current = false;
    }
    setOpen(false);
  }, [dock, foldedInto]);

  useImperativeHandle(ref, () => ({ toggle: () => (open ? close() : setOpen(true)) }), [
    open,
    close,
  ]);

  const { supported } = reader;
  useEffect(() => {
    onStateChange?.({ supported, open, active });
  }, [onStateChange, supported, open, active]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // An Escape the voice dropdown already consumed must not also
      // take the panel with it.
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
  if (!supported) return null;

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

  return (
    <>
      {!foldedInto && (
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
      )}

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
            <Flex direction="column" gap="1" className="read-aloud-panel">
              <Flex align="center" gap="2" className="read-aloud-toolbar">
                <Tooltip
                  content={playing ? 'Pause' : status === 'paused' ? 'Continue' : 'Read aloud'}
                >
                  <IconButton
                    size="1"
                    variant="soft"
                    color={APP_ACCENT_COLOR}
                    onClick={toggle}
                    aria-label={transportLabel}
                  >
                    {playing ? <PauseIcon /> : <PlayIcon />}
                  </IconButton>
                </Tooltip>
                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  className="doc-toolbar-toggle"
                  aria-label="Previous sentence"
                  onClick={reader.previous}
                  disabled={!active}
                >
                  <TrackPreviousIcon />
                </IconButton>
                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  className="doc-toolbar-toggle"
                  aria-label="Next sentence"
                  onClick={reader.next}
                  disabled={!active}
                >
                  <TrackNextIcon />
                </IconButton>
                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  className="doc-toolbar-toggle"
                  aria-label="Stop reading"
                  onClick={stop}
                  disabled={!active}
                >
                  <StopIcon />
                </IconButton>

                {/* Always mounted: its width is reserved while idle so the
                    transport doesn't shift under the finger that just
                    pressed Play. */}
                <Text size="1" color="gray" className="read-aloud-progress">
                  {active ? `${reader.index + 1} / ${reader.total}` : ''}
                </Text>

                <Select.Root
                  size="1"
                  value={reader.voice?.voiceURI ?? ''}
                  onValueChange={reader.setVoiceUri}
                >
                  <Select.Trigger
                    variant="soft"
                    className="read-aloud-voice"
                    aria-label="Voice"
                    placeholder="Voice"
                  />
                  <Select.Content position="popper" style={{ maxHeight: 360 }}>
                    {reader.voices.map((voice) => (
                      <Select.Item key={voice.voiceURI} value={voice.voiceURI}>
                        {voice.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>

                <Tooltip content="Reading speed">
                  <Button
                    size="1"
                    variant="soft"
                    color="gray"
                    className="read-aloud-rate"
                    onClick={() => reader.setRate(nextRate(reader.rate))}
                    aria-label={`Reading speed ${reader.rate.toFixed(1)}×, change`}
                  >
                    {reader.rate.toFixed(1)}×
                  </Button>
                </Tooltip>

                <IconButton
                  size="1"
                  variant="ghost"
                  color="gray"
                  className="read-aloud-close"
                  aria-label="Close read-aloud controls"
                  onClick={close}
                >
                  <Cross2Icon />
                </IconButton>
              </Flex>

              {(reader.error || reader.missingLanguageVoice || reader.showVoiceHint) && (
                <Text size="1" color={reader.error ? 'red' : 'gray'} className="read-aloud-hint">
                  {reader.error ??
                    (reader.missingLanguageVoice
                      ? `No voice installed for "${lang}" — pick another or install one in your system speech settings.`
                      : voiceHint())}
                </Text>
              )}
            </Flex>
          </div>,
          dock,
        )}
    </>
  );
}

/**
 * The stock voices (macOS `Anna` / `Samantha`, and their equivalents
 * elsewhere) are compact engines that get tiring over a long document.
 * Better ones ship with the OS but have to be downloaded, so point at
 * where — the exact path only exists on macOS.
 */
function voiceHint(): string {
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
  return isMac
    ? 'Basic system voice. For much better quality install a Premium voice under System Settings → Accessibility → Spoken Content → System Voice → Manage Voices.'
    : 'Basic system voice. Installing an enhanced or premium voice in your operating system’s speech settings improves quality considerably.';
}
