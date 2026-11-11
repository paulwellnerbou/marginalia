import { ArchiveIcon } from '@radix-ui/react-icons';
import { DropdownMenu, IconButton } from '@radix-ui/themes';
import { useState } from 'react';
import { apiErrorMessage } from '../lib/apiErrorMessage.js';
import {
  addDocsToKeyring,
  type FilableDoc,
  type Keyring,
  keyringLabel,
  moveDocsToKeyring,
  type RingView,
  removeDocsFromKeyring,
} from '../lib/keyring.js';
import { reportError } from '../lib/log.js';
import type { RecentDoc } from '../lib/recent-docs.js';

/**
 * Which project a card's documents are in, and the ways to change it.
 * A card stands for a folder's main document and the documents listed
 * on it, which share their access, so they move together: splitting a
 * folder across two clients' rings would leave half of it out of reach
 * of either one's agents.
 */
export function ProjectMenu({
  docs,
  rings,
  view,
  onChanged,
  onError,
}: {
  /** The card's document first, then its companions. */
  docs: readonly RecentDoc[];
  rings: readonly Keyring[];
  view: RingView;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const lead = docs[0];
  if (!lead || rings.length < 2) return null;
  // Only a document with a link of its own can be put in a ring.
  const filable: FilableDoc[] = docs.flatMap((d) =>
    d.invite_token ? [{ uid: d.uid, invite_token: d.invite_token, title: d.title }] : [],
  );
  if (!filable.length) return null;

  const holding = rings.filter((ring) => lead.rings?.includes(ring.id));
  const others = rings.filter((ring) => !lead.rings?.includes(ring.id));
  // Move from the project in front, or from the only one that holds it.
  const from =
    holding.find((ring) => ring.id === view) ?? (holding.length === 1 ? holding[0] : undefined);
  const removable = view === 'all' ? holding : holding.filter((ring) => ring.id === view);

  async function run(what: string, action: () => Promise<void>) {
    setBusy(true);
    try {
      await action();
    } catch (err) {
      reportError('ProjectMenu', err, { uid: lead?.uid, what });
      onError(apiErrorMessage(err, `Could not ${what}`));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger disabled={busy}>
        <IconButton
          variant="ghost"
          size="1"
          color="gray"
          aria-label={`Project of ${lead.title}`}
          className="recent-card-action"
          onClick={(e) => e.stopPropagation()}
        >
          <ArchiveIcon />
        </IconButton>
      </DropdownMenu.Trigger>
      <DropdownMenu.Content size="1" align="end">
        {from && others.length > 0 && (
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger>Move to</DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent>
              {others.map((ring) => (
                <DropdownMenu.Item
                  key={ring.id}
                  onSelect={() =>
                    void run('move the document', () =>
                      moveDocsToKeyring(filable, from.id, ring.id),
                    )
                  }
                >
                  {keyringLabel(ring)}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        )}
        {others.length > 0 && (
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger>
              {holding.length ? 'Also add to' : 'Add to'}
            </DropdownMenu.SubTrigger>
            <DropdownMenu.SubContent>
              {others.map((ring) => (
                <DropdownMenu.Item
                  key={ring.id}
                  onSelect={() =>
                    void run('add the document', () => addDocsToKeyring(filable, ring.id))
                  }
                >
                  {keyringLabel(ring)}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.SubContent>
          </DropdownMenu.Sub>
        )}
        {removable.length > 0 && <DropdownMenu.Separator />}
        {removable.map((ring) => (
          <DropdownMenu.Item
            key={ring.id}
            onSelect={() =>
              void run('remove the document from the project', () =>
                removeDocsFromKeyring(
                  filable.map((d) => d.uid),
                  ring.id,
                ),
              )
            }
          >
            Remove from “{keyringLabel(ring)}”
          </DropdownMenu.Item>
        ))}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
