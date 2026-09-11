import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import type {
  AnchorSection,
  findAnchorBlock,
  resolveAnchorElement,
} from '../src/lib/anchor-target.js';
import type { collectTopLevelBlocks, sectionContextsOf } from '../src/lib/selection.js';

/** What the fixture hangs on `window` for the page to call. */
interface AnchorTargetApi {
  findAnchorBlock: typeof findAnchorBlock;
  resolveAnchorElement: typeof resolveAnchorElement;
  collectTopLevelBlocks: typeof collectTopLevelBlocks;
  sectionContextsOf: typeof sectionContextsOf;
}

// Which element an anchor lands on is decided by walking the live DOM —
// the fold wrappers, the permalink chrome in headings, document order —
// which no stub of it exercises.
describe.if(process.env.MARGINALIA_TEST_PROFILE === 'chromium')(
  'anchor elements in the browser',
  () => {
    let browser: Browser;
    let server: ReturnType<typeof Bun.serve>;
    let page: Page;

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'marginalia-anchor-test-'));
      let script: string;
      try {
        // Built in a separate process so Bun's test-module resolver does not
        // interfere with .js imports that resolve to TypeScript sources.
        const result = Bun.spawnSync([
          process.execPath,
          'build',
          `${import.meta.dir}/fixtures/anchor-target.ts`,
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
          return new Response('<!doctype html><script type="module" src="/fixture.js"></script>', {
            headers: { 'Content-Type': 'text/html' },
          });
        },
      });
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
      page.setDefaultTimeout(3000);
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.waitForSelector('#doc');
    });

    afterAll(async () => {
      await browser?.close();
      server?.stop(true);
    });

    /** Which of the elements carrying `blockId` the lookup answers with. */
    async function indexOfChoice(
      blockId: string,
      section: AnchorSection | null,
      afterEliasCopy?: number,
    ): Promise<number> {
      return page.evaluate(
        ({ blockId, section, afterEliasCopy }) => {
          const { findAnchorBlock } = (window as unknown as { anchorTarget: AnchorTargetApi })
            .anchorTarget;
          const root = document.getElementById('doc') as HTMLElement;
          const after =
            afterEliasCopy === undefined
              ? null
              : document.querySelectorAll('[data-block="h-elias"]')[afterEliasCopy];
          const chosen = findAnchorBlock(root, blockId, section, after);
          return Array.from(document.querySelectorAll(`[data-block="${blockId}"]`)).indexOf(chosen);
        },
        { blockId, section, afterEliasCopy },
      );
    }

    test("the section walk reads every block as the server's block map does", async () => {
      const contexts = await page.evaluate(() => {
        const { collectTopLevelBlocks, sectionContextsOf } = (
          window as unknown as { anchorTarget: AnchorTargetApi }
        ).anchorTarget;
        const root = document.getElementById('doc') as HTMLElement;
        const blocks: HTMLElement[] = collectTopLevelBlocks(root);
        const found = sectionContextsOf(root, new Set(blocks));
        return blocks.map((el) => [el.dataset.block, found.get(el)]);
      });
      expect(contexts).toEqual([
        ['h-book', { headingPath: ['Crestwood'], sectionIndex: 0, sectionIndexPath: [0, 0] }],
        [
          'h-ch1',
          { headingPath: ['Crestwood', 'Chapter 1'], sectionIndex: 0, sectionIndexPath: [1, 1, 0] },
        ],
        [
          'h-elias',
          {
            headingPath: ['Crestwood', 'Chapter 1', 'Elias'],
            sectionIndex: 0,
            sectionIndexPath: [2, 2, 1, 0],
          },
        ],
        [
          'p-1',
          {
            headingPath: ['Crestwood', 'Chapter 1', 'Elias'],
            sectionIndex: 1,
            sectionIndexPath: [3, 3, 2, 1],
          },
        ],
        [
          'p-mm',
          {
            headingPath: ['Crestwood', 'Chapter 1', 'Elias'],
            sectionIndex: 2,
            sectionIndexPath: [4, 4, 3, 2],
          },
        ],
        [
          'h-elias',
          {
            headingPath: ['Crestwood', 'Chapter 1', 'Elias'],
            sectionIndex: 3,
            sectionIndexPath: [5, 5, 4, 3],
          },
        ],
        [
          'p-2',
          {
            headingPath: ['Crestwood', 'Chapter 1', 'Elias'],
            sectionIndex: 4,
            sectionIndexPath: [6, 6, 5, 4],
          },
        ],
        [
          'h-ch2',
          { headingPath: ['Crestwood', 'Chapter 2'], sectionIndex: 0, sectionIndexPath: [7, 7, 0] },
        ],
        [
          'h-elias',
          {
            headingPath: ['Crestwood', 'Chapter 2', 'Elias'],
            sectionIndex: 0,
            sectionIndexPath: [8, 8, 1, 0],
          },
        ],
        [
          'p-3',
          {
            headingPath: ['Crestwood', 'Chapter 2', 'Elias'],
            sectionIndex: 1,
            sectionIndexPath: [9, 9, 2, 1],
          },
        ],
        [
          'p-mm',
          {
            headingPath: ['Crestwood', 'Chapter 2', 'Elias'],
            sectionIndex: 2,
            sectionIndexPath: [10, 10, 3, 2],
          },
        ],
        [
          'list-1',
          {
            headingPath: ['Crestwood', 'Chapter 2', 'Elias'],
            sectionIndex: 3,
            sectionIndexPath: [11, 11, 4, 3],
          },
        ],
      ]);
    });

    test('a repeated heading resolves to the copy the stored section names', async () => {
      const stored: AnchorSection[] = [
        {
          heading_path: ['Crestwood', 'Chapter 1', 'Elias'],
          section_index: 0,
          section_index_path: [2, 2, 1, 0],
        },
        {
          heading_path: ['Crestwood', 'Chapter 1', 'Elias'],
          section_index: 3,
          section_index_path: [5, 5, 4, 3],
        },
        {
          heading_path: ['Crestwood', 'Chapter 2', 'Elias'],
          section_index: 0,
          section_index_path: [8, 8, 1, 0],
        },
      ];
      for (const [copy, section] of stored.entries()) {
        expect(await indexOfChoice('h-elias', section)).toBe(copy);
      }
      // As the browser captured before the title was part of the walk, with
      // the permalink sigil on every segment.
      expect(
        await indexOfChoice('h-elias', {
          heading_path: ['#Chapter 2', '#Elias'],
          section_index: 0,
          section_index_path: [8, 1, 0],
        }),
      ).toBe(2);
    });

    test('without a stored section, a repeated id means its first element', async () => {
      expect(await indexOfChoice('h-elias', null)).toBe(0);
      expect(await indexOfChoice('h-elias', { heading_path: null })).toBe(0);
      expect(await indexOfChoice('p-2', null)).toBe(0);
    });

    test('a span ends at the first block of its id after the start', async () => {
      expect(await indexOfChoice('p-mm', null)).toBe(0);
      expect(await indexOfChoice('p-mm', null, 2)).toBe(1);
      // Nothing of that id after the last heading.
      expect(await indexOfChoice('p-1', null, 2)).toBe(-1);
    });

    test('a quote still narrows a block-level anchor to the one sub-block holding it', async () => {
      const chosen = await page.evaluate(() => {
        const { resolveAnchorElement } = (window as unknown as { anchorTarget: AnchorTargetApi })
          .anchorTarget;
        const root = document.getElementById('doc') as HTMLElement;
        return resolveAnchorElement(root, 'list-1', 'beta', null)?.dataset.subblock ?? null;
      });
      expect(chosen).toBe('li-b');
    });
  },
);
