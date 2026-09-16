import {
  computeDocumentStats,
  type DocumentStats,
  type SectionStats,
  type TextCounts,
} from '@marginalia/renderer/stats';
import { BarChartIcon, ChevronRightIcon } from '@radix-ui/react-icons';
import { Button, Dialog, Flex, IconButton, Table, Text } from '@radix-ui/themes';
import { type ReactNode, useMemo, useState } from 'react';
import type { RenderedDocument } from '../lib/api.js';
import { formatCount, formatPages, formatReadingTime, formatShare } from '../lib/stats-format.js';
import { DisplayStepper } from './DisplayStepper.js';

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

function readAssumption({ key, min, max, defaultValue }: Assumption): number {
  const saved = Number(localStorage.getItem(key));
  return Number.isFinite(saved) && saved >= min && saved <= max ? saved : defaultValue;
}

/**
 * Word counts and the numbers a writer derives from them, for the whole
 * document and for every chapter. Counted from the rendered block map,
 * so it reflects what is on the page — proposals accepted, code left out.
 */
export function DocumentStatsDialog({ rendered }: { rendered: RenderedDocument }) {
  const [open, setOpen] = useState(false);
  const [wordsPerPage, setWordsPerPage] = useState(() => readAssumption(WORDS_PER_PAGE));
  const [readingSpeed, setReadingSpeed] = useState(() => readAssumption(READING_SPEED));
  // Only while open: the count walks every block, and the document can
  // be a book.
  const stats = useMemo(() => (open ? computeDocumentStats(rendered) : null), [open, rendered]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
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
      <Dialog.Content
        size="3"
        maxWidth="900px"
        className="doc-stats-dialog dialog-content--fixed-footer"
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
                localStorage.setItem(WORDS_PER_PAGE.key, String(next));
              }}
              onReadingSpeed={(next) => {
                setReadingSpeed(next);
                localStorage.setItem(READING_SPEED.key, String(next));
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
  onNavigate,
}: {
  stats: DocumentStats;
  wordsPerPage: number;
  readingSpeed: number;
  onWordsPerPage: (value: number) => void;
  onReadingSpeed: (value: number) => void;
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
  onNavigate,
}: {
  chapters: SectionStats[];
  preamble: TextCounts;
  totalWords: number;
  wordsPerPage: number;
  readingSpeed: number;
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
        Chapters follow the document's headings, and this one has none.
      </Text>
    );
  }

  const rows = visibleRows(chapters, expanded);
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
            <Table.ColumnHeaderCell>Chapter</Table.ColumnHeaderCell>
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
                  <Text color="gray">Before the first chapter</Text>
                </span>
              </Table.RowHeaderCell>
              {numbers(preamble)}
            </Table.Row>
          )}
          {rows.map(({ section, depth }) => {
            const title = stripHtml(section.title);
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
                    {/* A plain fragment link: the document's own hash handling
                        expands and scrolls to the heading once the dialog is
                        gone. */}
                    <a href={`#${section.id}`} onClick={onNavigate}>
                      {title}
                    </a>
                  </span>
                </Table.RowHeaderCell>
                {numbers(section)}
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
      <ChapterSummary chapters={chapters} />
    </>
  );
}

function ChapterSummary({ chapters }: { chapters: SectionStats[] }) {
  if (chapters.length < 2) return null;
  const words = chapters.map((c) => c.words);
  const average = Math.round(words.reduce((sum, n) => sum + n, 0) / chapters.length);
  const shortest = chapters.reduce((a, b) => (b.words < a.words ? b : a));
  const longest = chapters.reduce((a, b) => (b.words > a.words ? b : a));
  const parts: ReactNode[] = [
    `${chapters.length} chapters`,
    `${formatCount(average)} words on average`,
    `shortest “${stripHtml(shortest.title)}” (${formatCount(shortest.words)})`,
    `longest “${stripHtml(longest.title)}” (${formatCount(longest.words)})`,
  ];
  return (
    <Text as="p" size="1" color="gray" className="doc-stats-note">
      {parts.join(' · ')}
    </Text>
  );
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}
