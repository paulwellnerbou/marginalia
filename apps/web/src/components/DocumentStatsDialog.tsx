import {
  computeDocumentStats,
  type DocumentStats,
  type SectionStats,
  type TextCounts,
} from '@marginalia/renderer/stats';
import { BarChartIcon, ChevronRightIcon } from '@radix-ui/react-icons';
import { Button, Checkbox, Dialog, Flex, IconButton, Table, Text } from '@radix-ui/themes';
import { type ReactNode, useImperativeHandle, useMemo, useState } from 'react';
import type { RenderedDocument } from '../lib/api.js';
import { separatorFragment } from '../lib/fragment-target.js';
import { formatCount, formatPages, formatReadingTime, formatShare } from '../lib/stats-format.js';
import { DisplayStepper } from './DisplayStepper.js';
import { type FoldableDialogProps, returnFocusTo } from './foldedDialog.js';

interface Assumption {
  key: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
}

/**
 * The two conversions the dialog rests on, both adjustable because
 * neither has one right value. A printed novel page holds roughly
 * 250–300 words and a manuscript page is 250 by convention; adults
 * read silently at about 240 words a minute.
 */
const WORDS_PER_PAGE: Assumption = {
  key: 'marginalia.stats.wordsPerPage',
  min: 100,
  max: 600,
  step: 25,
  defaultValue: 250,
};
const READING_SPEED: Assumption = {
  key: 'marginalia.stats.readingSpeed',
  min: 100,
  max: 600,
  step: 10,
  defaultValue: 240,
};

const SPLIT_AT_BREAKS_KEY = 'marginalia.stats.splitAtBreaks';

/** Storage can refuse (blocked site data); the dialog then keeps defaults. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The choice then lasts until the page closes.
  }
}

function readAssumption({ key, min, max, defaultValue }: Assumption): number {
  const stored = readStored(key);
  const saved = stored === null ? Number.NaN : Number(stored);
  return Number.isFinite(saved) && saved >= min && saved <= max ? saved : defaultValue;
}

/**
 * Word counts and the numbers a writer derives from them, for the whole
 * document and for every chapter. Counted from the rendered block map,
 * so it reflects what is on the page — proposals accepted, code left out.
 */
export function DocumentStatsDialog({
  rendered,
  ref,
  foldedInto,
}: { rendered: RenderedDocument } & FoldableDialogProps) {
  const [open, setOpen] = useState(false);
  useImperativeHandle(ref, () => ({ open: () => setOpen(true) }), []);
  const [wordsPerPage, setWordsPerPage] = useState(() => readAssumption(WORDS_PER_PAGE));
  const [readingSpeed, setReadingSpeed] = useState(() => readAssumption(READING_SPEED));
  const [splitAtBreaks, setSplitAtBreaks] = useState(() => readStored(SPLIT_AT_BREAKS_KEY) === '1');
  // Only while open: the count walks every block, and the document can
  // be a book.
  const stats = useMemo(
    () => (open ? computeDocumentStats(rendered, { splitAtBreaks }) : null),
    [open, rendered, splitAtBreaks],
  );

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      {!foldedInto && (
        <Dialog.Trigger>
          <IconButton
            variant="soft"
            size="2"
            aria-label="Document statistics"
            title="Document statistics"
          >
            <BarChartIcon />
          </IconButton>
        </Dialog.Trigger>
      )}
      <Dialog.Content
        size="3"
        maxWidth="900px"
        className="doc-stats-dialog dialog-content--fixed-footer"
        onCloseAutoFocus={returnFocusTo(foldedInto)}
      >
        <div className="dialog-scroll-body">
          <Dialog.Title>Statistics</Dialog.Title>
          <Dialog.Description size="2" color="gray" mb="4">
            Word counts for the whole document and for each chapter.
          </Dialog.Description>
          {stats && (
            <StatsBody
              stats={stats}
              wordsPerPage={wordsPerPage}
              readingSpeed={readingSpeed}
              onWordsPerPage={(next) => {
                setWordsPerPage(next);
                writeStored(WORDS_PER_PAGE.key, String(next));
              }}
              onReadingSpeed={(next) => {
                setReadingSpeed(next);
                writeStored(READING_SPEED.key, String(next));
              }}
              splitAtBreaks={splitAtBreaks}
              onSplitAtBreaks={(next) => {
                setSplitAtBreaks(next);
                writeStored(SPLIT_AT_BREAKS_KEY, next ? '1' : '0');
              }}
              onNavigate={() => setOpen(false)}
            />
          )}
        </div>
        <Flex className="dialog-footer" justify="end" mt="4">
          <Dialog.Close>
            <Button variant="soft" color="gray">
              Close
            </Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function StatsBody({
  stats,
  wordsPerPage,
  readingSpeed,
  onWordsPerPage,
  onReadingSpeed,
  splitAtBreaks,
  onSplitAtBreaks,
  onNavigate,
}: {
  stats: DocumentStats;
  wordsPerPage: number;
  readingSpeed: number;
  onWordsPerPage: (value: number) => void;
  onReadingSpeed: (value: number) => void;
  splitAtBreaks: boolean;
  onSplitAtBreaks: (value: boolean) => void;
  onNavigate: () => void;
}) {
  const { total, chapters, preamble } = stats;
  const perSentence = total.sentences > 0 ? Math.round(total.words / total.sentences) : 0;
  const perParagraph = total.paragraphs > 0 ? Math.round(total.words / total.paragraphs) : 0;

  return (
    <>
      <div className="doc-stats-tiles">
        <Tile label="Words" value={formatCount(total.words)} />
        <Tile
          label="Pages"
          value={formatPages(total.words, wordsPerPage)}
          hint={`at ${wordsPerPage} words a page`}
        />
        <Tile
          label="Reading time"
          value={formatReadingTime(total.words, readingSpeed)}
          hint={`at ${readingSpeed} words a minute`}
        />
        <Tile
          label="Characters"
          value={formatCount(total.characters)}
          hint={`${formatCount(total.charactersNoSpaces)} without spaces`}
        />
        <Tile
          label="Sentences"
          value={formatCount(total.sentences)}
          hint={perSentence > 0 ? `${perSentence} words each on average` : undefined}
        />
        <Tile
          label="Paragraphs"
          value={formatCount(total.paragraphs)}
          hint={perParagraph > 0 ? `${perParagraph} words each on average` : undefined}
        />
      </div>

      <div className="doc-view-grid doc-stats-assumptions">
        <Text size="1" color="gray">
          Words per page
        </Text>
        <DisplayStepper
          ariaLabel="Words per page"
          min={WORDS_PER_PAGE.min}
          max={WORDS_PER_PAGE.max}
          step={WORDS_PER_PAGE.step}
          defaultValue={WORDS_PER_PAGE.defaultValue}
          value={wordsPerPage}
          format={(v) => String(v)}
          onCommit={onWordsPerPage}
        />
        <Text size="1" color="gray">
          Reading speed
        </Text>
        <DisplayStepper
          ariaLabel="Reading speed"
          min={READING_SPEED.min}
          max={READING_SPEED.max}
          step={READING_SPEED.step}
          defaultValue={READING_SPEED.defaultValue}
          value={readingSpeed}
          format={(v) => `${v} wpm`}
          onCommit={onReadingSpeed}
        />
        {stats.separators > 0 && (
          <Text as="label" size="1" color="gray" className="doc-view-grid-control">
            <Flex align="center" gap="2">
              <Checkbox
                size="1"
                checked={splitAtBreaks}
                onCheckedChange={(c) => onSplitAtBreaks(c === true)}
              />
              Split sections at separators ({stats.separators})
            </Flex>
          </Text>
        )}
      </div>
      <Text as="p" size="1" color="gray" className="doc-stats-note">
        A printed book page holds about 250–300 words; adults read about 240 words a minute.
        {stats.codeBlocks > 0 &&
          ` Code blocks and diagrams (${stats.codeBlocks}) are left out of every count.`}
      </Text>

      <ChapterTable
        chapters={chapters}
        preamble={preamble}
        totalWords={total.words}
        wordsPerPage={wordsPerPage}
        readingSpeed={readingSpeed}
        splitSeparators={splitAtBreaks ? stats.separators : 0}
        onNavigate={onNavigate}
      />
    </>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string | undefined }) {
  return (
    <div className="doc-stats-tile">
      <Text size="1" color="gray">
        {label}
      </Text>
      <Text size="5" weight="medium" className="doc-stats-value">
        {value}
      </Text>
      {hint && (
        <Text size="1" color="gray">
          {hint}
        </Text>
      )}
    </div>
  );
}

interface Row {
  section: SectionStats;
  depth: number;
}

function visibleRows(
  sections: readonly SectionStats[],
  expanded: ReadonlySet<string>,
  depth = 0,
  out: Row[] = [],
): Row[] {
  for (const section of sections) {
    out.push({ section, depth });
    if (expanded.has(section.id)) visibleRows(section.children, expanded, depth + 1, out);
  }
  return out;
}

function ChapterTable({
  chapters,
  preamble,
  totalWords,
  wordsPerPage,
  readingSpeed,
  splitSeparators,
  onNavigate,
}: {
  chapters: SectionStats[];
  preamble: TextCounts;
  totalWords: number;
  wordsPerPage: number;
  readingSpeed: number;
  /** Separators the rows were split at; 0 when not splitting. */
  splitSeparators: number;
  onNavigate: () => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  if (chapters.length === 0) {
    return (
      <Text as="p" size="2" color="gray" className="doc-stats-empty">
        Chapters follow the document’s headings, and this one has none.
        {splitSeparators === 1 && ' Its separator does not divide the text into two parts.'}
        {splitSeparators > 1 && ' Its separators do not divide the text into two or more parts.'}
      </Text>
    );
  }

  const rows = visibleRows(chapters, expanded);
  // Rows a separator bounds are not chapters, so the table stops calling them that.
  const runRows = chapters.some((c) => c.break);
  const numbers = (counts: TextCounts) => (
    <>
      <Table.Cell justify="end" className="doc-stats-num">
        {formatCount(counts.words)}
      </Table.Cell>
      <Table.Cell justify="end" className="doc-stats-num">
        {formatPages(counts.words, wordsPerPage)}
      </Table.Cell>
      <Table.Cell justify="end" className="doc-stats-num">
        {formatReadingTime(counts.words, readingSpeed)}
      </Table.Cell>
      <Table.Cell justify="end" className="doc-stats-num">
        <span className="doc-stats-share">
          <span className="doc-stats-bar" aria-hidden>
            <span style={{ width: `${totalWords > 0 ? (counts.words / totalWords) * 100 : 0}%` }} />
          </span>
          {formatShare(counts.words, totalWords)}
        </span>
      </Table.Cell>
    </>
  );

  return (
    <>
      <Table.Root size="1" variant="surface" className="doc-stats-table">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>{runRows ? 'Section' : 'Chapter'}</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell justify="end">Words</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell justify="end">Pages</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell justify="end">Time</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell justify="end">Share</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {preamble.words > 0 && (
            <Table.Row>
              <Table.RowHeaderCell>
                <span className="doc-stats-heading">
                  <span className="doc-stats-toggle-spacer" aria-hidden />
                  <Text color="gray">
                    {runRows ? 'Before the first section' : 'Before the first chapter'}
                  </Text>
                </span>
              </Table.RowHeaderCell>
              {numbers(preamble)}
            </Table.Row>
          )}
          {rows.map(({ section, depth }) => {
            const title = section.break
              ? `§ ${section.break.index} · ${section.title}`
              : stripHtml(section.title);
            const isOpen = expanded.has(section.id);
            return (
              <Table.Row key={section.id}>
                <Table.RowHeaderCell>
                  <span
                    className="doc-stats-heading"
                    style={{ '--doc-stats-depth': depth } as React.CSSProperties}
                  >
                    {section.children.length > 0 ? (
                      <IconButton
                        size="1"
                        variant="ghost"
                        color="gray"
                        className="doc-stats-toggle"
                        aria-label={isOpen ? `Collapse “${title}”` : `Expand “${title}”`}
                        aria-expanded={isOpen}
                        onClick={() => toggle(section.id)}
                      >
                        <ChevronRightIcon />
                      </IconButton>
                    ) : (
                      <span className="doc-stats-toggle-spacer" aria-hidden />
                    )}
                    <SectionLink section={section} title={title} onNavigate={onNavigate} />
                  </span>
                </Table.RowHeaderCell>
                {numbers(section)}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
      <ChapterSummary chapters={chapters} unit={runRows ? 'sections' : 'chapters'} />
    </>
  );
}

function ChapterSummary({
  chapters,
  unit,
}: {
  chapters: SectionStats[];
  unit: 'chapters' | 'sections';
}) {
  if (chapters.length < 2) return null;
  const words = chapters.map((c) => c.words);
  const average = Math.round(words.reduce((sum, n) => sum + n, 0) / chapters.length);
  const shortest = chapters.reduce((a, b) => (b.words < a.words ? b : a));
  const longest = chapters.reduce((a, b) => (b.words > a.words ? b : a));
  const parts: ReactNode[] = [
    `${chapters.length} ${unit}`,
    `${formatCount(average)} words on average`,
    `shortest “${summaryTitle(shortest)}” (${formatCount(shortest.words)})`,
    `longest “${summaryTitle(longest)}” (${formatCount(longest.words)})`,
  ];
  return (
    <Text as="p" size="1" color="gray" className="doc-stats-note">
      {parts.join(' · ')}
    </Text>
  );
}

function summaryTitle(section: SectionStats): string {
  return section.break ? `§ ${section.break.index}` : stripHtml(section.title);
}

/**
 * Plain fragment links: the document's own hash handling expands and
 * scrolls to the target once the dialog is gone. A run a separator opens
 * goes by `#separator-N`; the first run starts where its section does.
 */
function SectionLink({
  section,
  title,
  onNavigate,
}: {
  section: SectionStats;
  title: string;
  onNavigate: () => void;
}) {
  const run = section.break;
  const fragment = run
    ? run.separator !== null
      ? separatorFragment(run.separator)
      : (run.sectionId ?? separatorFragment(0))
    : section.id;
  return (
    <a href={`#${fragment}`} onClick={onNavigate}>
      {title}
    </a>
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}
