import { FaceIcon } from '@radix-ui/react-icons';
import { Popover } from '@radix-ui/themes';
import { EmojiPicker } from 'frimousse';
import { useState } from 'react';

interface Props {
  onPick: (emoji: string) => void | Promise<void>;
  /** Disable the trigger (e.g. while a reaction request is in flight). */
  disabled?: boolean;
}

// Static quick-pick row shown above the full picker. Order is hand-tuned
// for "what people actually react with on documents" — no per-user
// frequency tracking (issue #28: intentionally simpler than Slack).
const QUICK_REACTIONS: ReadonlyArray<{ emoji: string; label: string }> = [
  { emoji: '👍', label: 'Thumbs up' },
  { emoji: '❤️', label: 'Red heart' },
  { emoji: '😂', label: 'Face with tears of joy' },
  { emoji: '🎉', label: 'Party popper' },
  { emoji: '🚀', label: 'Rocket' },
  { emoji: '🤩', label: 'Star-struck' },
  { emoji: '🤔', label: 'Thinking face' },
  { emoji: '👀', label: 'Eyes' },
];

// Frimousse fetches its emoji dataset from a CDN on first open. This keeps
// the bundle small (~17KB instead of >100KB inlined) at the cost of one
// network round-trip the first time a viewer opens the picker. If we ever
// need to work offline or pin the dataset version, set `emojibaseUrl` on
// the Root to a self-hosted copy.
export function EmojiReactionPicker({ onPick, disabled }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {/* Themes' Popover.Trigger renders its own <button> and (unlike
          its DropdownMenu sibling) strips `asChild`. Pass the styling
          and a11y props straight to the Trigger and put the icon as
          its child — wrapping a <button> inside would nest two of them. */}
      <Popover.Trigger
        className="ic-icon-btn"
        title="Add reaction"
        aria-label="Add reaction"
        disabled={disabled}
      >
        <FaceIcon />
      </Popover.Trigger>
      <Popover.Content
        className="ic-reaction-popover"
        size="1"
        side="top"
        align="end"
        sideOffset={4}
      >
        {/* Close before awaiting onPick — snappier UX, and the parent
            handles its own busy state. */}
        {/* biome-ignore lint/a11y/useSemanticElements: <fieldset> is form-only; this groups action buttons */}
        <div className="ic-emoji-quick-row" role="group" aria-label="Common reactions">
          {QUICK_REACTIONS.map(({ emoji, label }) => (
            <button
              key={emoji}
              type="button"
              className="ic-emoji-quick-btn"
              title={label}
              aria-label={label}
              onClick={() => {
                setOpen(false);
                void onPick(emoji);
              }}
            >
              {emoji}
            </button>
          ))}
        </div>
        <EmojiPicker.Root
          className="ic-emoji-picker"
          onEmojiSelect={({ emoji }) => {
            setOpen(false);
            void onPick(emoji);
          }}
          columns={8}
        >
          <EmojiPicker.Search
            className="ic-emoji-picker-search"
            autoFocus
            placeholder="Search emoji…"
          />
          <EmojiPicker.Viewport className="ic-emoji-picker-viewport">
            <EmojiPicker.Loading className="ic-emoji-picker-status">
              Loading emojis…
            </EmojiPicker.Loading>
            <EmojiPicker.Empty className="ic-emoji-picker-status">
              {({ search }) => `No emoji matches "${search}".`}
            </EmojiPicker.Empty>
            <EmojiPicker.List />
          </EmojiPicker.Viewport>
        </EmojiPicker.Root>
      </Popover.Content>
    </Popover.Root>
  );
}
