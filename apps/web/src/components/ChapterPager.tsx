import { ChevronLeftIcon, ChevronRightIcon } from '@radix-ui/react-icons';
import { Flex, IconButton, Select, Text } from '@radix-ui/themes';
import type { TocNode } from '../lib/api.js';

interface Props {
  chapters: readonly TocNode[];
  /** 0-based index of the chapter on screen. */
  index: number;
  onGoTo: (index: number) => void;
}

function chapterTitle(chapter: TocNode | undefined, index: number): string {
  return chapter?.text.trim() || `Chapter ${index + 1}`;
}

/**
 * Chapter reading's counterpart to the page pager: the same quiet line
 * under the document, stepping a chapter at a time, with the title doubling
 * as the way to jump to any other.
 */
export function ChapterPager({ chapters, index, onGoTo }: Props) {
  const total = chapters.length;
  const title = chapterTitle(chapters[index], index);
  return (
    <Flex className="doc-pager" align="center" gap="2">
      <IconButton
        variant="ghost"
        size="1"
        aria-label="Previous chapter"
        disabled={index <= 0}
        onClick={() => onGoTo(index - 1)}
      >
        <ChevronLeftIcon />
      </IconButton>
      <Select.Root size="1" value={String(index)} onValueChange={(next) => onGoTo(Number(next))}>
        <Select.Trigger
          variant="ghost"
          color="gray"
          className="doc-pager-chapter"
          aria-label={`Chapter ${index + 1} of ${total}: ${title}. Jump to chapter`}
        >
          <Text as="span" aria-live="polite" className="doc-pager-chapter-label">
            <span className="doc-pager-chapter-title">{title}</span>
            <Text as="span" color="gray" className="doc-pager-chapter-count">
              {index + 1} / {total}
            </Text>
          </Text>
        </Select.Trigger>
        <Select.Content position="popper" side="top" align="center" className="doc-pager-chapters">
          {chapters.map((chapter, i) => (
            <Select.Item key={chapter.id} value={String(i)}>
              {chapterTitle(chapter, i)}
            </Select.Item>
          ))}
        </Select.Content>
      </Select.Root>
      <IconButton
        variant="ghost"
        size="1"
        aria-label="Next chapter"
        disabled={index >= total - 1}
        onClick={() => onGoTo(index + 1)}
      >
        <ChevronRightIcon />
      </IconButton>
    </Flex>
  );
}
