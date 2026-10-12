import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import type {
  CHAPTER_HIDDEN_ATTR,
  chapterIndexOf,
  REVEAL_CHAPTER_EVENT,
  revealChapterOf,
  showChapter,
} from '../src/lib/chapter-reading.js';

/** What the fixture hangs on `window` for the page to call. */
interface ChapterReadingApi {
  CHAPTER_HIDDEN_ATTR: typeof CHAPTER_HIDDEN_ATTR;
  chapterIndexOf: typeof chapterIndexOf;
  REVEAL_CHAPTER_EVENT: typeof REVEAL_CHAPTER_EVENT;
  revealChapterOf: typeof revealChapterOf;
  showChapter: typeof showChapter;
}

// Which elements a chapter hides depends on how the live article nests its
// sections — fold wrappers, AsciiDoc containers — and on real layout to
// say what is on screen, which no stub of the DOM exercises.
describe.if(process.env.MARGINALIA_TEST_PROFILE === 'chromium')(
  'chapter reading in the browser',
  () => {
    let browser: Browser;
    let server: ReturnType<typeof Bun.serve>;
    let page: Page;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'marginalia-chapter-test-'));
      let script: string;
      try {
        // Built in a separate process so Bun's test-module resolver does not
        // interfere with .js imports that resolve to TypeScript sources.
        const result = Bun.spawnSync([
          process.execPath,
          'build',
          `${import.meta.dir}/fixtures/chapter-reading.ts`,
          '--target',
          'browser',
          '--outfile',
          join(dir, 'fixture.js'),
        ]);
        if (result.exitCode !== 0) throw new Error(result.stderr.toString());
        script = await Bun.file(join(dir, 'fixture.js')).text();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      server = Bun.serve({
        hostname: '127.0.0.1',
        port: 0,
        fetch(req) {
          if (new URL(req.url).pathname === '/fixture.js')
            return new Response(script, { headers: { 'Content-Type': 'text/javascript' } });
          return new Response(
            '<!doctype html><style>[data-chapter-hidden]{display:none}</style>' +
              '<script type="module" src="/fixture.js"></script>',
            { headers: { 'Content-Type': 'text/html' } },
          );
        },
      });
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
      page.setDefaultTimeout(3000);
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.waitForSelector('#md');
    });

    afterAll(async () => {
      await browser?.close();
      server?.stop(true);
    });

    /** Show one chapter of an article and list the ids still on screen. */
    async function visibleIds(article: string, headingIds: string[], index: number) {
      return page.evaluate(
        ({ article, headingIds, index }) => {
          const { showChapter } = (window as unknown as { chapterReading: ChapterReadingApi })
            .chapterReading;
          const root = document.getElementById(article) as HTMLElement;
          const headings = headingIds.map((id) => document.getElementById(id) as HTMLElement);
          showChapter(root, headings, index);
          return Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, p'))
            .filter((el) => el.getClientRects().length > 0)
            .map((el) => el.id);
        },
        { article, headingIds, index },
      );
    }

    const md = ['ch1', 'ch2', 'ch3'];

    test('the first chapter carries the book title and preamble', async () => {
      expect(await visibleIds('md', md, 0)).toEqual(['book', 'intro', 'ch1', 'p1', 'ch1-a', 'p1a']);
    });

    test('a middle chapter shows only itself', async () => {
      expect(await visibleIds('md', md, 1)).toEqual(['ch2', 'p2']);
    });

    test('the last chapter runs to the end', async () => {
      expect(await visibleIds('md', md, 2)).toEqual(['ch3', 'p3']);
    });

    test('AsciiDoc sections hide whole, containers and all', async () => {
      const adoc = ['s1', 's2'];
      expect(await visibleIds('adoc', adoc, 0)).toEqual(['title', 'a0', 's1', 'a1']);
      expect(await visibleIds('adoc', adoc, 1)).toEqual(['s2', 'a2']);
      const hiddenSections = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#adoc > [data-chapter-hidden]')).map(
          (el) => el.id || el.className,
        ),
      );
      expect(hiddenSections).toEqual(['header', 'preamble', 'sect1']);
    });

    test('a single chapter hides nothing', async () => {
      expect(await visibleIds('md', ['ch1'], 0)).toEqual([
        'book',
        'intro',
        'ch1',
        'p1',
        'ch1-a',
        'p1a',
        'ch2',
        'p2',
        'ch3',
        'p3',
      ]);
    });

    test('every element is placed in the chapter it reads in', async () => {
      const placed = await page.evaluate(() => {
        const { chapterIndexOf } = (window as unknown as { chapterReading: ChapterReadingApi })
          .chapterReading;
        const headings = ['ch1', 'ch2', 'ch3'].map((id) => document.getElementById(id) as Element);
        return ['book', 'intro', 'ch1', 'p1a', 'ch2', 'p2', 'p3'].map((id) =>
          chapterIndexOf(headings, document.getElementById(id) as Element),
        );
      });
      expect(placed).toEqual([0, 0, 0, 0, 1, 1, 2]);
    });

    test('revealing a hidden element asks for its chapter, and a shown one does not', async () => {
      const asked = await page.evaluate(() => {
        const { showChapter, revealChapterOf, REVEAL_CHAPTER_EVENT } = (
          window as unknown as { chapterReading: ChapterReadingApi }
        ).chapterReading;
        const root = document.getElementById('md') as HTMLElement;
        const headings = ['ch1', 'ch2', 'ch3'].map((id) => document.getElementById(id) as Element);
        showChapter(root, headings, 1);
        const targets: string[] = [];
        const listen = (event: Event) => targets.push((event.target as Element).id);
        root.addEventListener(REVEAL_CHAPTER_EVENT, listen);
        revealChapterOf(document.getElementById('p2') as Element);
        revealChapterOf(document.getElementById('p3') as Element);
        root.removeEventListener(REVEAL_CHAPTER_EVENT, listen);
        return targets;
      });
      expect(asked).toEqual(['p3']);
    });
  },
);
