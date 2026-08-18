import { Button, Flex, Popover, Text, TextField } from '@radix-ui/themes';
import { type FormEvent, useState } from 'react';

interface Props {
  /** 0-based index of the page on screen. */
  page: number;
  pageCount: number;
  /** Takes a 0-based index, as `usePagedReading` does. */
  onGoTo: (index: number) => void;
}

/**
 * The page counter, doubling as the way to jump to a page.
 *
 * There is nowhere else to put a page field: the pager is one line of
 * chrome under the document and a permanently visible input would take
 * more of it than the arrows do. The counter is already where a reader
 * looks to find out where they are, so it is where they reach to say
 * where they want to be.
 */
export function PageJump({ page, pageCount, onGoTo }: Props) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');

  // `Number`, not `parseInt`: a number field accepts `1.5` and `1e2`, and
  // parsing the leading digits of those reads them both as page 1 — an
  // unremarkable-looking jump to a page nobody asked for.
  const requested = Number(value);
  const valid = Number.isInteger(requested) && requested >= 1 && requested <= pageCount;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!valid) return;
    onGoTo(requested - 1);
    setOpen(false);
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        // Seeded with the page in front of the reader, so the field is a
        // starting point to edit rather than something to fill in blind.
        if (next) setValue(String(page + 1));
        setOpen(next);
      }}
    >
      <Popover.Trigger>
        <Button
          variant="ghost"
          size="1"
          color="gray"
          className="doc-pager-count"
          aria-label={`Page ${page + 1} of ${pageCount}. Jump to page`}
        >
          {/* The live region is the text, not the button: announcing the
              whole control on every turn would repeat its label too. */}
          <Text as="span" aria-live="polite">
            Page {page + 1} of {pageCount}
          </Text>
        </Button>
      </Popover.Trigger>
      <Popover.Content size="1" align="center" side="top" className="doc-pager-jump">
        <form onSubmit={submit}>
          <Flex align="center" gap="2">
            <TextField.Root
              type="number"
              min={1}
              max={pageCount}
              step={1}
              size="1"
              value={value}
              aria-label="Page number"
              className="doc-pager-jump-field"
              onFocus={(event) => event.currentTarget.select()}
              onChange={(event) => setValue(event.target.value)}
            />
            <Text size="1" color="gray">
              of {pageCount}
            </Text>
            <Button type="submit" size="1" variant="soft" disabled={!valid}>
              Go
            </Button>
          </Flex>
        </form>
      </Popover.Content>
    </Popover.Root>
  );
}
