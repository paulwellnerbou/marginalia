#!/usr/bin/env bun
/**
 * End-to-end check: upload the Köln Zoo document, navigate to its URL in
 * a real Chromium, and confirm the mermaid block renders an <svg>.
 *
 * Assumes the dev servers are already running:
 *   - server: http://localhost:3434
 *   - web:    http://localhost:5173
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const SERVER = 'http://localhost:3434';
const WEB = 'http://localhost:5173';
const MD_PATH =
  '/Users/paul/Documents/Claude/Projects/Ausschreibung Kölner Zoo/Arbeitspakete_Epics_Aufwand.md';

async function upload(): Promise<string> {
  const markdown = readFileSync(MD_PATH, 'utf8');
  const res = await fetch(`${SERVER}/api/documents`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-marginalia-client': 'e2e-mermaid-client-000000',
      'x-marginalia-client-name': 'E2E',
    },
    body: JSON.stringify({ markdown }),
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const j = (await res.json()) as { uid: string };
  return j.uid;
}

async function main() {
  const uid = await upload();
  console.log(`[e2e] uploaded uid=${uid}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const logs: string[] = [];
  page.on('console', (msg) => {
    const txt = msg.text();
    if (txt.includes('[marginalia')) logs.push(`${msg.type()}: ${txt}`);
  });
  page.on('pageerror', (err) => logs.push(`pageerror: ${err.message}`));

  await page.goto(`${WEB}/d/${uid}`, { waitUntil: 'networkidle' });

  async function svgCount() {
    return page.locator('article.marginalia div.mermaid svg').count();
  }

  // Give mermaid up to 10s to finish rendering.
  let initialSvg = 0;
  for (let i = 0; i < 20; i++) {
    initialSvg = await svgCount();
    if (initialSvg > 0) break;
    await page.waitForTimeout(500);
  }
  console.log(`[e2e] initial svg count = ${initialSvg}`);

  // --- resize the TOC pane ---
  const handle = page.locator('.pane-toc .resize-handle').first();
  const box = await handle.boundingBox();
  if (!box) throw new Error('no resize handle');
  console.log(`[e2e] dragging TOC handle from x=${box.x}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Drag to narrow the TOC
  for (let x = box.x; x > box.x - 120; x -= 10) {
    await page.mouse.move(x, box.y + box.height / 2);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(500);

  const afterResizeSvg = await svgCount();
  console.log(`[e2e] svg count after TOC resize = ${afterResizeSvg}`);

  // --- nudge the Radix Slider to a new value via keyboard ---
  // Radix Slider uses role=slider + aria-valuenow; press ArrowLeft 10 times
  // to drop the width by ~10ch, which is enough to force the doc layout to
  // recompute.
  const slider = page.locator('[role=slider]').first();
  await slider.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  const afterSliderSvg = await svgCount();
  console.log(`[e2e] svg count after slider = ${afterSliderSvg}`);

  const finalHtmlSnippet = await page
    .locator('article.marginalia div.mermaid')
    .first()
    .evaluate((el) => el.outerHTML.slice(0, 300))
    .catch(() => '(no .mermaid found)');

  console.log('\n--- collected console logs ---');
  for (const l of logs) console.log(l);

  console.log('\n--- result ---');
  console.log('initialSvg:', initialSvg);
  console.log('afterResizeSvg:', afterResizeSvg);
  console.log('afterSliderSvg:', afterSliderSvg);
  console.log('final div.mermaid outerHTML start:', finalHtmlSnippet);

  await browser.close();
  const ok = initialSvg > 0 && afterResizeSvg > 0 && afterSliderSvg > 0;
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
