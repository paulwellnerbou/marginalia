import { CheckIcon, Pencil1Icon } from '@radix-ui/react-icons';
import { Button, Callout, Dialog, Flex, Text, TextArea } from '@radix-ui/themes';
import {
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ProposalConflict } from '../lib/api.js';
import {
  allDecided,
  type ConflictHunk,
  conflictHunks,
  type HunkChoice,
  initialChoices,
  resolvedText,
  textForChoice,
  undecidedCount,
} from '../lib/conflict-resolution.js';
import type { DiffLine } from '../lib/line-diff.js';
import { splitDiffSides } from '../lib/split-diff.js';
import { DialogLoading } from './DialogLoading.js';
import { DiffView } from './DiffView.js';
import { Disclosure } from './Disclosure.js';
import { renderDiffLineText } from './diffLineText.js';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null while the three-way state is still being fetched. */
  conflict: ProposalConflict | null;
  loading: boolean;
  /** Why the fetch failed, shown in place of the resolver. */
  error?: string | null;
  /** Why the last apply failed, shown beside the buttons. */
  actionError?: string | null;
  applying?: boolean;
  /**
   * Settle the proposal. `resolvedText` is undefined when the merge was
   * clean and the server can redo it unaided.
   */
  onApply: (payload: { resolvedText?: string; comment?: string }) => Promise<boolean>;
}

/**
 * Resolve an edit proposal against the document as it stands.
 *
 * Two shapes behind one dialog. A merge git can make on its own shows
 * its result for confirmation — one button, nothing to decide. A real
 * conflict shows each disputed hunk with both versions side by side, and
 * the apply button stays out of reach until every one of them has an
 * answer.
 */
export function ConflictDialog({
  open,
  onOpenChange,
  conflict,
  loading,
  error = null,
  actionError = null,
  applying = false,
  onApply,
}: Props) {
  const segments = conflict?.segments ?? null;
  const hunks = useMemo(() => (segments ? conflictHunks(segments) : []), [segments]);
  const [choices, setChoices] = useState<Array<HunkChoice | null>>([]);
  const [note, setNote] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const noteId = useId();

  // Re-seed whenever a different conflict arrives (a refetch after
  // someone else's save, or a second proposal opened from the same
  // list). Keyed on identity of the segments array: the fetch replaces
  // it wholesale, and nothing else can change it.
  //
  // The reset-state-from-props pattern, same as ThreadComposer's target
  // reset — during render, so `choices` is already seeded in the pass
  // that first sees the hunks. An effect would commit one frame with
  // the previous conflict's answers, or none at all.
  //
  // The tracker is state rather than a ref for the sake of that render
  // being discardable: a ref written during render survives a render
  // React throws away, but the `setChoices` beside it does not, which
  // would leave the next pass believing it had already seeded.
  const [seededFor, setSeededFor] = useState<ConflictSegmentsKey>(null);
  if (seededFor !== segments) {
    setSeededFor(segments);
    setChoices(segments ? initialChoices(segments) : []);
  }

  useEffect(() => {
    if (!open) setNote('');
  }, [open]);

  const clean = conflict?.status === 'clean';
  // `choices` is seeded above in the same pass that first sees `hunks`,
  // so the two agree by construction. Check anyway: `[].every()` is
  // true, so a mismatch would read as "everything decided" and arm
  // Apply with nothing answered — the one direction this must not fail.
  const seeded = choices.length === hunks.length;
  const decided = seeded && allDecided(choices);
  const pending = seeded ? undecidedCount(choices) : hunks.length;
  const preview = segments ? resolvedText(segments, choices) : (conflict?.merged ?? '');
  // Only a finished resolution can be "nothing to accept". While hunks
  // are open the preview stands in undecided ones with the document's
  // own text, which matches `current` by construction — reading that as
  // an empty resolution would replace the hunks with a dead end the
  // moment the dialog opened.
  const unchanged = conflict !== null && preview === conflict.current && (clean || decided);

  function choose(index: number, choice: HunkChoice) {
    setChoices((prev) => prev.map((existing, i) => (i === index ? choice : existing)));
  }

  async function apply() {
    const comment = note.trim();
    // A clean merge goes back without text so the server redoes it
    // against whatever main is by then, rather than trusting a preview
    // that may have gone stale while the dialog sat open.
    const payload: { resolvedText?: string; comment?: string } = {};
    if (!clean) payload.resolvedText = preview;
    if (comment) payload.comment = comment;
    const ok = await onApply(payload);
    if (ok) onOpenChange(false);
  }

  const applyDisabled = applying || loading || !conflict || unchanged || (!clean && !decided);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content size="3" maxWidth="900px">
        <Dialog.Title>Resolve conflict</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          {unchanged
            ? 'The document has moved past this proposal.'
            : clean
              ? 'The document moved, but not where this proposal edits — it can be merged as it stands.'
              : 'The document and this proposal changed the same text. Pick what it should say.'}
        </Dialog.Description>

        {/* Sits above the hunks rather than replacing them: the way out
            of an empty resolution is to change one of the choices that
            produced it, which needs them on screen. */}
        {unchanged && !error && (
          <Callout.Root color="amber" size="1" mb="3">
            <Callout.Text>
              This leaves the document exactly as it reads now, so there would be nothing to accept.
              Take something from the proposal, or reject it instead.
            </Callout.Text>
          </Callout.Root>
        )}

        {error ? (
          <Callout.Root color="red" size="1">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : loading || !conflict ? (
          <DialogLoading>Working out where this proposal stands…</DialogLoading>
        ) : clean ? (
          <div className="cf-clean">
            {/* Suppressed under `unchanged`: the amber callout above has
                already said the opposite, and both at once reads as the
                dialog arguing with itself. */}
            {!unchanged && (
              <Callout.Root color="green" size="1" mb="3">
                <Callout.Text>
                  No overlap — the proposal still applies. Here is what accepting it will do.
                </Callout.Text>
              </Callout.Root>
            )}
            <DiffView before={conflict.current} after={preview} contextLines={3} active={open} />
          </div>
        ) : (
          <div className="cf-hunks">
            {pending > 0 && (
              <Text size="1" color="gray" as="p" mb="2">
                {pending} of {hunks.length} still to decide.
              </Text>
            )}
            {hunks.map((hunk, index) => (
              <ConflictHunkCard
                // Hunks have no id; their position is their identity, and
                // the list is replaced wholesale on every refetch.
                // biome-ignore lint/suspicious/noArrayIndexKey: index is the hunk's identity here
                key={index}
                hunk={hunk}
                index={index}
                total={hunks.length}
                choice={choices[index] ?? null}
                onChoose={(choice) => choose(index, choice)}
              />
            ))}
            <Disclosure
              className="cf-preview"
              summary="Result"
              open={previewOpen}
              onOpenChange={setPreviewOpen}
            >
              {/* A collapsed body still has layout, so the diff's
                  measuring effects would run against a zero height and
                  cache the wrong line offsets. Gate them on being
                  genuinely on screen. */}
              <DiffView
                before={conflict.current}
                after={preview}
                contextLines={3}
                active={open && previewOpen}
              />
            </Disclosure>
          </div>
        )}

        {conflict && !error && (
          <div className="cf-note">
            <Text as="label" size="1" color="gray" htmlFor={noteId}>
              Note for the thread (optional)
            </Text>
            <TextArea
              id={noteId}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Why you settled it this way"
              rows={2}
              size="1"
            />
          </div>
        )}

        <Flex gap="2" justify="end" mt="4" align="center" wrap="wrap">
          {actionError && (
            <Text color="red" size="1" style={{ marginRight: 'auto' }}>
              {actionError}
            </Text>
          )}
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Cancel
            </Button>
          </Dialog.Close>
          <Button onClick={() => void apply()} disabled={applyDisabled} loading={applying}>
            {clean ? 'Apply merge' : 'Apply resolution'}
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

type ConflictSegmentsKey = ProposalConflict['segments'];

interface HunkProps {
  hunk: ConflictHunk;
  index: number;
  total: number;
  choice: HunkChoice | null;
  onChoose: (choice: HunkChoice) => void;
}

function ConflictHunkCard({ hunk, index, total, choice, onChoose }: HunkProps) {
  const [editing, setEditing] = useState(false);
  const [baseOpen, setBaseOpen] = useState(false);
  const draft = choice ? textForChoice(hunk, choice) : hunk.current;
  // The two sides of a hunk are usually the same passage twice over, a few
  // words apart. Diffing them against each other is what makes the choice a
  // choice rather than two walls of text to compare by eye.
  const sides = useMemo(
    () => splitDiffSides(hunk.current, hunk.proposed),
    [hunk.current, hunk.proposed],
  );
  const currentPane = useRef<HTMLPreElement | null>(null);
  const proposedPane = useRef<HTMLPreElement | null>(null);
  const writing = editing && choice?.kind === 'custom';

  // A pane taller than its box opens at the top, which for the case this
  // view is for — a paragraph reworded near its end — is the half with
  // nothing in it to see.
  //
  // One offset for both, from whichever side has to travel further: they are
  // read across, and a side the other only *added* words to has no
  // difference of its own to scroll to. `writing` is a dependency because
  // leaving the editor mounts the panes afresh, back at the top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the effect reads the DOM these render, not their values
  useLayoutEffect(() => {
    const panes = [currentPane.current, proposedPane.current].filter((pane) => pane !== null);
    // A pane measuring zero has not been laid out. Scrolling it by a height
    // it does not have yet would land it at its own bottom and leave it
    // there once it has one.
    if (panes.some((pane) => pane.clientHeight === 0)) return;

    let target = 0;
    for (const pane of panes) {
      const first = pane.querySelector<HTMLElement>('.diff-inline-change, .cf-side-line-unpaired');
      if (!first) continue;
      const overshoot = first.offsetTop + first.offsetHeight - pane.clientHeight;
      if (overshoot > 0) target = Math.max(target, overshoot + PANE_SCROLL_MARGIN);
    }
    if (target === 0) return;
    for (const pane of panes) pane.scrollTop = target;
  }, [sides, writing]);

  return (
    <section className={`cf-hunk ${choice ? 'cf-hunk-decided' : 'cf-hunk-open'}`}>
      <header className="cf-hunk-head">
        <Text size="1" weight="medium">
          Conflict {index + 1} of {total}
          {hunk.auto && (
            <Text size="1" color="gray" ml="2">
              settled automatically
            </Text>
          )}
        </Text>
        <Flex gap="1" align="center">
          <Button
            size="1"
            variant={choice?.kind === 'both' ? 'solid' : 'soft'}
            color="gray"
            onClick={() => {
              setEditing(false);
              onChoose({ kind: 'both' });
            }}
          >
            Keep both
          </Button>
          <Button
            size="1"
            variant={choice?.kind === 'custom' ? 'solid' : 'soft'}
            color="gray"
            onClick={() => {
              setEditing(true);
              onChoose({ kind: 'custom', text: draft });
            }}
          >
            <Pencil1Icon aria-hidden="true" />
            Write it
          </Button>
        </Flex>
      </header>

      {writing ? (
        <TextArea
          className="cf-hunk-editor"
          value={choice.text}
          onChange={(e) => onChoose({ kind: 'custom', text: e.target.value })}
          rows={Math.min(12, Math.max(3, choice.text.split('\n').length + 1))}
          size="2"
          aria-label={`Replacement text for conflict ${index + 1}`}
        />
      ) : (
        <div className="cf-sides">
          <SideButton
            label="In the document now"
            description={`Keep the document’s version for conflict ${index + 1}`}
            lines={sides.before}
            empty={!hunk.current}
            paneRef={currentPane}
            selected={choice?.kind === 'current'}
            onSelect={() => {
              setEditing(false);
              onChoose({ kind: 'current' });
            }}
          />
          <SideButton
            label="This proposal"
            description={`Take the proposal’s version for conflict ${index + 1}`}
            lines={sides.after}
            empty={!hunk.proposed}
            paneRef={proposedPane}
            selected={choice?.kind === 'proposed'}
            onSelect={() => {
              setEditing(false);
              onChoose({ kind: 'proposed' });
            }}
          />
        </div>
      )}

      {choice?.kind === 'both' && (
        <Text size="1" color="gray" as="p" mt="1">
          Both, the document’s first.
        </Text>
      )}

      <Disclosure
        className="cf-base"
        summary="What it said before either change"
        open={baseOpen}
        onOpenChange={setBaseOpen}
      >
        <pre className="cf-side-text">{hunk.base || '(nothing)'}</pre>
      </Disclosure>
    </section>
  );
}

interface SideProps {
  label: string;
  /**
   * The accessible name. The visible label alone ("This proposal") reads
   * as a heading rather than an action, and the version's own text —
   * which is what the button contains — would otherwise be announced as
   * the name of the control, at whatever length the paragraph runs to.
   */
  description: string;
  /** The side's text as diff lines, marked against the other side. */
  lines: DiffLine[];
  /** Whether this version drops the passage rather than saying something. */
  empty: boolean;
  /** Handle on the scrolling box, so the card can line both sides up. */
  paneRef: RefObject<HTMLPreElement | null>;
  selected: boolean;
  onSelect: () => void;
}

function SideButton({ label, description, lines, empty, paneRef, selected, onSelect }: SideProps) {
  return (
    <button
      type="button"
      className={`cf-side ${selected ? 'cf-side-selected' : ''}`}
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={description}
    >
      <span className="cf-side-label">
        {selected && <CheckIcon aria-hidden="true" />}
        {label}
      </span>
      <pre className="cf-side-text" ref={paneRef}>
        {empty
          ? '(deleted)'
          : keyedLines(lines).map(({ key, line }) => (
              <span key={key} className={sideLineClass(line)}>
                {renderDiffLineText(line)}
              </span>
            ))}
      </pre>
    </button>
  );
}

/** Room left under the first difference, so it lands inside the pane rather
 *  than against its bottom edge. */
const PANE_SCROLL_MARGIN = 8;

/**
 * Only a line the other side has nothing to match is tinted end to end: one
 * paired with its rewrite has said what changed by highlighting the words
 * that did, and colouring the rest would paint a paragraph that differs by
 * three words as a wholly different paragraph.
 *
 * `segments` being set is what pairing means, whether or not any of them
 * changed — a side the other only added words to is the pair with nothing of
 * its own to highlight, and tinting it for that is the exact opposite of
 * what happened to it.
 */
function sideLineClass(line: DiffLine): string {
  const base = `cf-side-line cf-side-line-${line.op}`;
  return line.op === 'equal' || line.segments ? base : `${base} cf-side-line-unpaired`;
}

/** Keys for repeatable lines: identical text twice over is ordinary prose. */
function keyedLines(lines: DiffLine[]): Array<{ key: string; line: DiffLine }> {
  const occurrences = new Map<string, number>();
  return lines.map((line) => {
    const signature = `${line.op} ${line.text}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    return { key: `${signature} ${occurrence}`, line };
  });
}
