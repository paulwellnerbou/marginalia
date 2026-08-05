import {
  Cross2Icon,
  PauseIcon,
  PlayIcon,
  SpeakerLoudIcon,
  StopIcon,
  TrackNextIcon,
  TrackPreviousIcon,
} from '@radix-ui/react-icons';
import { Flex, IconButton, Select, Slider, Text, Tooltip } from '@radix-ui/themes';
import { type RefObject, useEffect, useMemo, useState } from 'react';
import { MAX_RATE, MIN_RATE, useReadAloud } from '../lib/read-aloud/useReadAloud.js';
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
}

/**
 * Read-aloud ("Vorlesen") transport, sitting next to document search in
 * the doc toolbar. Speech runs on the browser's own synthesis engine,
 * so quality depends entirely on the voices the reader's OS has — hence
 * the voice picker and the hint when only a compact default is present.
 */
export function ReadAloudControls({ rootRef, htmlKey, frontmatter, inlineCommentsOffset }: Props) {
  const [open, setOpen] = useState(false);
  const lang = useMemo(
    () => resolveDocLang(frontmatter, document.documentElement.lang || navigator.language || 'en'),
    [frontmatter],
  );
  const reader = useReadAloud({ rootRef, htmlKey, lang });

  const { status, stop } = reader;
  const playing = status === 'playing';
  const active = status !== 'idle';

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
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

  return (
    <>
      <Tooltip content={active ? 'Read-aloud controls' : 'Read this document aloud'}>
        <IconButton
          variant="soft"
          color={APP_ACCENT_COLOR}
          size="2"
          className={`doc-search-trigger read-aloud-trigger ${open || active ? 'active' : ''}`}
          onClick={() => setOpen((prev) => !prev)}
          aria-label={active ? 'Read-aloud controls' : 'Read this document aloud'}
          aria-pressed={open}
        >
          <SpeakerLoudIcon />
        </IconButton>
      </Tooltip>

      {open && (
        <div
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

              <Text size="1" color="gray" className="read-aloud-progress">
                {active ? `${reader.index + 1} / ${reader.total}` : '–'}
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

              <Flex align="center" gap="2" className="read-aloud-rate">
                <Text size="1" color="gray">
                  Speed
                </Text>
                <Slider
                  size="1"
                  style={{ width: 72 }}
                  min={MIN_RATE}
                  max={MAX_RATE}
                  step={0.1}
                  value={[reader.rate]}
                  onValueChange={(value) => reader.setRate(value[0] ?? reader.rate)}
                  aria-label="Reading speed"
                />
                <Text size="1" color="gray" className="read-aloud-rate-value">
                  {reader.rate.toFixed(1)}×
                </Text>
              </Flex>

              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                aria-label="Close read-aloud controls"
                onClick={() => setOpen(false)}
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
        </div>
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
