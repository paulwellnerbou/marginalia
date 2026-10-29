import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

// Uses a real layout engine: DOM stubs cannot exercise scroll clamping,
// ResizeObserver, or the spacers' relationship to actual card positions.
describe.if(process.env.MARGINALIA_TEST_PROFILE === 'chromium')(
  'windowed threads in the browser',
  () => {
    let browser: Browser;
    let server: ReturnType<typeof Bun.serve>;
    let page: Page;
    const errors: Error[] = [];

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'marginalia-thread-test-'));
      let script: string;
      try {
        // Build in a separate process so Bun's test-module resolver does not
        // interfere with .js imports that resolve to TypeScript sources.
        const result = Bun.spawnSync([
          process.execPath,
          'build',
          `${import.meta.dir}/fixtures/windowed-threads.tsx`,
          '--target',
          'browser',
          '--define',
          'process.env.NODE_ENV="development"',
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
          const path = new URL(req.url).pathname;
          if (path === '/fixture.js')
            return new Response(script, { headers: { 'Content-Type': 'text/javascript' } });
          if (path === '/app.css')
            return new Response(Bun.file(`${import.meta.dir}/../src/styles/app.css`));
          if (path === '/radix.css')
            return new Response(
              Bun.file(Bun.resolveSync('@radix-ui/themes/styles.css', import.meta.dir)),
            );
          return new Response(
            '<!doctype html><link rel="stylesheet" href="/radix.css"><link rel="stylesheet" href="/app.css"><div id="app"></div><script type="module" src="/fixture.js"></script>',
            { headers: { 'Content-Type': 'text/html' } },
          );
        },
      });
      browser = await chromium.launch({ headless: true });
      page = await browser.newPage();
      page.setDefaultTimeout(3000);
      page.on('pageerror', (err) => errors.push(err));
    });

    afterEach(() => {
      expect(errors.splice(0)).toEqual([]);
    });

    afterAll(async () => {
      await browser?.close();
      server?.stop(true);
    });

    async function open(query = '') {
      await page.goto(`http://127.0.0.1:${server.port}/${query}`);
      await page.waitForSelector('#scroller');
    }

    async function update(kind: string, id?: string) {
      await page.evaluate(
        ({ kind, id }) => {
          (window as Window & { updateThreads: (kind: string, id?: string) => void }).updateThreads(
            kind,
            id,
          );
        },
        { kind, id },
      );
    }

    async function expectVisibleCard() {
      await page.waitForFunction(
        () => {
          const scroller = document.querySelector('#scroller')?.getBoundingClientRect();
          if (!scroller) return false;
          return [...document.querySelectorAll('.ic-list [data-comment-thread-id]')].some((el) => {
            const rect = el.getBoundingClientRect();
            return rect.top < scroller.bottom && rect.bottom > scroller.top + 150;
          });
        },
        undefined,
        { timeout: 3000 },
      );
    }

    async function scrollTo(fraction: number) {
      await page.evaluate((fraction) => {
        const el = document.querySelector('#scroller');
        if (!el) throw new Error('Missing scroller');
        el.scrollTop = (el.scrollHeight - el.clientHeight) * fraction;
      }, fraction);
      await expectVisibleCard();
    }

    test('updates cached geometry when a mounted row resizes without a parent render', async () => {
      await open('?hook');
      await page.waitForSelector('[data-row="t0"]');
      // Let the initial ResizeObserver notifications settle before the mutation.
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const beforeHeight = await page.locator('#rows').evaluate((el) => el.scrollHeight);
      await page.evaluate(() => {
        (document.querySelector('[data-row="t0"]') as HTMLElement).style.height = '4000px';
      });
      await page.waitForFunction(
        () => document.querySelectorAll('[data-row]').length === 1,
        undefined,
        { timeout: 3000 },
      );
      expect(await page.locator('#rows').evaluate((el) => el.scrollHeight)).toBe(
        beforeHeight + 3900,
      );
    });

    test('a focus jump releases its pin so scrolling and background updates stay visible', async () => {
      await open();
      await update('focus');
      await page.waitForSelector('[data-comment-thread-id="t90"]');
      await expectVisibleCard();
      await scrollTo(0);
      await page.waitForSelector('[data-comment-thread-id="t119"]', { timeout: 2500 });
      await update('reply');
      await update('append');
      await expectVisibleCard();
      for (const fraction of [0.25, 0.5, 1, 0]) await scrollTo(fraction);
      expect(await page.locator('.ic-list [data-comment-thread-id]').count()).toBeLessThan(60);
    });

    test('new nested proposals can be focused and then scrolled away from', async () => {
      await open();
      await update('proposal');
      await update('focus', 't1000');
      await page.waitForSelector('[data-comment-thread-id="t90"] [data-comment-thread-id="t1000"]');
      await expectVisibleCard();
      await update('reply');
      await scrollTo(1);
      await scrollTo(0);
      await page.waitForSelector('[data-comment-thread-id="t119"]');
    });

    /** Heights of `selector`'s first match, one per frame, for `ms`. */
    async function sampleHeights(selector: string, ms: number): Promise<number[]> {
      return page.evaluate(
        ({ selector, ms }) =>
          new Promise<number[]>((resolve) => {
            const heights: number[] = [];
            const start = performance.now();
            const frame = () => {
              const el = document.querySelector(selector);
              heights.push(el ? el.getBoundingClientRect().height : 0);
              if (performance.now() - start < ms) requestAnimationFrame(frame);
              else resolve(heights);
            };
            requestAnimationFrame(frame);
          }),
        { selector, ms },
      );
    }

    for (const count of [10, 120]) {
      test(`a removed thread shrinks out of the list (${count} threads)`, async () => {
        await open(`?count=${count}`);
        // Latest first: the second row from the top, and the one below it.
        const [gone, below] = [`t${count - 2}`, `t${count - 3}`];
        const row = `.ic-list-presence:has([data-comment-thread-id="${gone}"])`;
        const topOf = (id: string) =>
          page
            .locator(`[data-comment-thread-id="${id}"]`)
            .evaluate((el) => el.getBoundingClientRect().top);
        const full = await page.locator(row).evaluate((el) => el.getBoundingClientRect().height);
        const belowTop = await topOf(below);
        await update('remove', gone);
        expect(await page.locator(row).getAttribute('data-presence')).toBe('exit');
        const heights = await sampleHeights(row, 500);
        // Shrinks through the heights in between rather than jumping.
        expect(heights.some((h) => h > 5 && h < full - 5)).toBe(true);
        for (let i = 1; i < heights.length; i++) {
          expect(heights[i]).toBeLessThanOrEqual((heights[i - 1] ?? 0) + 0.5);
        }
        await page.waitForSelector(`[data-comment-thread-id="${gone}"]`, { state: 'detached' });
        // The row below took its place, gap included.
        expect(Math.abs(belowTop - full - (await topOf(below)))).toBeLessThan(1);
      });
    }

    test('a removed orphan shrinks out of its section', async () => {
      await open('?count=10&orphans=3');
      const row = '.ic-list-orphans > .ic-list-presence:has([data-comment-thread-id="t1"])';
      const rowsTop = () =>
        page.locator('.ic-list-rows').evaluate((el) => el.getBoundingClientRect().top);
      const full = await page.locator(row).evaluate((el) => el.getBoundingClientRect().height);
      const before = await rowsTop();
      await update('remove', 't1');
      expect(await page.locator(row).getAttribute('data-presence')).toBe('exit');
      const heights = await sampleHeights(row, 500);
      expect(heights.some((h) => h > 5 && h < full - 5)).toBe(true);
      await page.waitForSelector('[data-comment-thread-id="t1"]', { state: 'detached' });
      // The card's share of the section's spacing went with it.
      expect(Math.abs(before - full - (await rowsTop()))).toBeLessThan(1);
    });

    test('the empty state waits for the last card to leave', async () => {
      await open('?count=1');
      await update('remove', 't0');
      expect(await page.locator('.ic-list-presence[data-presence="exit"]').count()).toBe(1);
      expect(await page.locator('.ic-list-empty').count()).toBe(0);
      await page.waitForSelector('[data-comment-thread-id="t0"]', { state: 'detached' });
      await page.waitForSelector('.ic-list-empty');
    });

    test('a new thread grows into the list', async () => {
      await open('?count=10');
      await update('insert', 'new');
      const row = '.ic-list-presence:has([data-comment-thread-id="new"])';
      expect(await page.locator(row).getAttribute('data-presence')).toBe('enter');
      const heights = await sampleHeights(row, 500);
      const full = heights.at(-1) ?? 0;
      expect(full).toBeGreaterThan(50);
      expect(heights.some((h) => h > 5 && h < full - 5)).toBe(true);
      expect(await page.locator(row).getAttribute('data-presence')).toBeNull();
    });

    test('a bulk removal swaps the list without animating', async () => {
      await open('?count=120');
      await update('shrink');
      expect(await page.locator('.ic-list-presence[data-presence]').count()).toBe(0);
    });

    test('crosses the windowing threshold as threads arrive, and clamps after removal', async () => {
      await open('?count=50');
      await scrollTo(1);
      await update('append');
      await expectVisibleCard();
      await scrollTo(1);
      await update('shrink');
      await expectVisibleCard();
      await scrollTo(0);
      await page.waitForSelector('[data-comment-thread-id="t64"]', { timeout: 2500 });
    });
  },
);
