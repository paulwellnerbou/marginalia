import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';

type Hooked = Window & { replyDraft: { replyOutcome: boolean; replies: string[] } };

// A real browser because the draft lives in React state behind a
// textarea and a click; static markup cannot exercise the submit round trip.
describe.if(process.env.MARGINALIA_TEST_PROFILE === 'chromium')(
  'reply draft in the browser',
  () => {
    let browser: Browser;
    let server: ReturnType<typeof Bun.serve>;
    let page: Page;
    const errors: Error[] = [];

    beforeAll(async () => {
      const dir = mkdtempSync(join(tmpdir(), 'marginalia-reply-draft-test-'));
      let script: string;
      try {
        // Build in a separate process so Bun's test-module resolver does not
        // interfere with .js imports that resolve to TypeScript sources.
        const result = Bun.spawnSync([
          process.execPath,
          'build',
          `${import.meta.dir}/fixtures/reply-draft.tsx`,
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
          return new Response(
            '<!doctype html><div id="app"></div><script type="module" src="/fixture.js"></script>',
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

    async function setOutcome(ok: boolean) {
      await page.evaluate((ok) => {
        (window as unknown as Hooked).replyDraft.replyOutcome = ok;
      }, ok);
    }

    async function waitForReplies(count: number) {
      await page.waitForFunction(
        (count) => (window as unknown as Hooked).replyDraft.replies.length === count,
        count,
      );
    }

    test('keeps the text when the post fails and clears it once it lands', async () => {
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.click('.ic-card-reply-open');
      const draft = 'A long reply nobody wants to type twice.';
      const box = page.locator('.ic-composer-body');
      await box.fill(draft);
      const post = page.locator('.ic-composer-actions .ic-btn-primary');

      await setOutcome(false);
      await post.click();
      await waitForReplies(1);
      await page.waitForFunction(
        () =>
          !document.querySelector<HTMLButtonElement>('.ic-composer-actions .ic-btn-primary')
            ?.disabled,
      );
      expect(await box.inputValue()).toBe(draft);

      await setOutcome(true);
      await post.click();
      await waitForReplies(2);
      await page.waitForFunction(() => !document.querySelector('.ic-composer-body'));
      expect(await page.evaluate(() => (window as unknown as Hooked).replyDraft.replies)).toEqual([
        draft,
        draft,
      ]);
    });
  },
);
