/**
 * Integration tests for `GET /api/documents/:uid/export.pdf`.
 *
 * These tests actually spin up headless Chromium via Playwright, so
 * they're an order of magnitude slower than the DOCX tests (seconds
 * per case, not milliseconds). Kept in a dedicated file so they can
 * be skipped easily (`bun test apps/server/test/export-pdf.test.ts`
 * in isolation, or excluded from `test:ci` if CI ever needs faster
 * PRs).
 *
 * Pre-requisite: `bunx playwright install chromium`. Without it,
 * every case fails with `export-engine-missing`. That's deliberate —
 * the server should advertise the missing dep rather than silently
 * skip tests.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type App, createApp } from '../src/app.js';
import { CLIENT_HEADER, CLIENT_NAME_HEADER, INVITE_HEADER } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { closeExportBrowser, configureExport } from '../src/export/pdf.js';

const CLIENT_A = { id: 'aaaaaaaaaaaaaaaaaaaa', name: 'Alice' };
const CLIENT_B = { id: 'bbbbbbbbbbbbbbbbbbbb', name: 'Bob' };

function headersFor(client: { id: string; name: string }): Headers {
  return new Headers({
    'content-type': 'application/json',
    [CLIENT_HEADER]: client.id,
    [CLIENT_NAME_HEADER]: client.name,
  });
}

function withInvite(h: Headers, token: string): Headers {
  const n = new Headers(h);
  n.set(INVITE_HEADER, token);
  return n;
}

interface CreateResponse {
  uid: string;
  admin_invite: { token: string; url: string; display_name: string };
}

describe('PDF export', () => {
  let dir: string;
  let webDir: string;
  let app: App;

  // Shorter budgets than production so a regression that hangs the
  // browser surfaces as a failed test rather than a timeout at the
  // bun test level. Mermaid is the slowest phase.
  configureExport({ timeoutMs: 20_000, mermaidWaitMs: 10_000 });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-pdf-'));
    webDir = mkdtempSync(join(tmpdir(), 'mdn-pdf-web-'));
    writeFileSync(
      join(webDir, 'index.html'),
      '<!doctype html><title>Marginalia</title><div id="root"></div>',
    );
    app = await createApp(loadConfig({ dataDir: dir, port: 0, webDir }));
  });

  afterEach(async () => {
    // Fully await App.close(), which in turn awaits the shared browser
    // teardown. Tearing down between tests costs ~500 ms per case but
    // eliminates a cross-test flakiness: when bun's per-test timeout
    // fires, our in-flight `exportPdf()` promise keeps running in the
    // background, still holding a semaphore slot and an open context.
    // The next test then starts with a polluted singleton and behaves
    // unpredictably (hangs, 503s). A clean slate per test is worth the
    // extra second of total suite time.
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(webDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    // Belt-and-braces: should already be closed by the final afterEach,
    // but call here too in case a test threw before reaching it.
    await closeExportBrowser();
  });

  async function upload(
    client: typeof CLIENT_A,
    body: Record<string, unknown> = { markdown: '# Hi' },
  ): Promise<CreateResponse> {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents', {
        method: 'POST',
        headers: headersFor(client),
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(201);
    return (await res.json()) as CreateResponse;
  }

  test('GET /:uid/export.pdf returns a PDF with the expected headers', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Export me\n\nA paragraph with **bold** text.\n',
      name: 'PDF fixture',
      default_theme: 'default',
    });

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toMatch(/filename="PDF_fixture\.pdf"/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    const buf = Buffer.from(await res.arrayBuffer());
    // PDF magic: %PDF-
    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    // A minimum-sized bolded-paragraph doc is well under a KB of text
    // but the PDF structure (xref table, catalog, fonts) brings the
    // smallest real exports above ~1 KB. Sanity lower bound.
    expect(buf.length).toBeGreaterThan(1000);
  }, 30_000);

  test('GET /:uid/export.pdf filename derives from the document title when name is unset', async () => {
    // Mirrors the DOCX test of the same name — the two downloads must
    // agree on the filename for the same doc.
    const created = await upload(CLIENT_A, {
      markdown: '---\ntitle: My Great Doc\n---\n\n# A Body Heading\n\nBody.\n',
    });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/filename="My_Great_Doc\.pdf"/);
  }, 30_000);

  test('GET /:uid/export.pdf falls back to uid when no title is derivable', async () => {
    const created = await upload(CLIENT_A, {
      markdown: 'Just a paragraph, no heading, no frontmatter.\n',
    });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`filename="${created.uid}.pdf"`);
  }, 30_000);

  test('GET /:uid/export.pdf rejects unknown UID with 404', async () => {
    const res = await app.hono.fetch(
      new Request('http://test/api/documents/does-not-exist/export.pdf', {
        headers: headersFor(CLIENT_A),
      }),
    );
    expect(res.status).toBe(404);
  });

  test('GET /:uid/export.pdf rejects a non-invited client with 401', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Secret\n\nBody.\n',
      name: 'Private doc',
      password_protected: true,
    });
    // Bob has no invite, no password, no session.
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf`, {
        headers: headersFor(CLIENT_B),
      }),
    );
    expect(res.status).toBe(401);
  });

  test('GET /:uid/export.pdf respects ?theme= and produces different bytes per theme', async () => {
    // Two very different themes (default vs. serif-print) should not
    // produce byte-identical PDFs. Ensures the theme CSS actually
    // threads through to `page.pdf()`.
    const created = await upload(CLIENT_A, {
      markdown: '# Theme check\n\nParagraph for theme sanity.\n',
      name: 'Theme test',
    });
    const common = withInvite(headersFor(CLIENT_A), created.admin_invite.token);
    // Sequential on purpose: the test is about bytes differing per
    // theme, not about concurrent export behavior. Running in
    // parallel would add flakiness from the 2-slot semaphore if a
    // previous test left an in-flight slot dangling for any reason.
    const resA = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf?theme=default`, {
        headers: common,
      }),
    );
    const resB = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf?theme=serif-print`, {
        headers: common,
      }),
    );
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const a = Buffer.from(await resA.arrayBuffer());
    const b = Buffer.from(await resB.arrayBuffer());
    expect(a.equals(b)).toBe(false);
  }, 60_000);

  test('GET /:uid/export.pdf embeds attached image assets as data URLs', async () => {
    const created = await upload(CLIENT_A, {
      markdown: '# Doc\n\n![logo](logo.png)\n',
      name: 'With logo',
    });

    // Same 1x1 PNG used by the DOCX embedding test.
    const PNG_BYTES = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    );
    const form = new FormData();
    form.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'logo.png');
    form.append('ref_name', 'logo.png');
    const uploadRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/assets`, {
        method: 'POST',
        headers: withInvite(
          new Headers({
            [CLIENT_HEADER]: CLIENT_A.id,
            [CLIENT_NAME_HEADER]: CLIENT_A.name,
          }),
          created.admin_invite.token,
        ),
        body: form,
      }),
    );
    expect(uploadRes.status).toBe(201);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    // The PNG's header bytes, in hex, appear verbatim inside the PDF
    // stream when Chromium embeds a raster image. Checking for the
    // specific 1x1 PNG's magic (`\x89PNG\r\n\x1a\n`) inside the PDF
    // text is brittle across Chromium versions, so instead just
    // assert that a PDF image object (`/Image` / `/DCTDecode` /
    // `/FlateDecode`) is present — signals the inliner fed bytes
    // through.
    const body = buf.toString('latin1');
    expect(body).toMatch(/\/Subtype\s*\/Image/);
  }, 30_000);

  test('GET /:uid/export.pdf renders a mermaid diagram to SVG on the page', async () => {
    // Document with one mermaid block → hasMermaid is true → the
    // envelope inlines the mermaid runtime → the export page runs
    // `mermaid.run()` before `page.pdf()`. We can't easily verify the
    // SVG inside the PDF binary, but we CAN verify that:
    //   - the response is a PDF (engine didn't blow up on the runtime),
    //   - it's materially larger than a no-mermaid export of the same
    //     surrounding text (the embedded SVG + fonts add bytes).
    const mermaidMd = [
      '# Diagram',
      '',
      '```mermaid',
      'graph TD',
      '  A[Start] --> B[End]',
      '```',
      '',
      'Aftermath paragraph.',
      '',
    ].join('\n');
    const plainMd = [
      '# Diagram',
      '',
      'graph TD  A[Start] --> B[End]',
      '',
      'Aftermath paragraph.',
      '',
    ].join('\n');

    const withDiagram = await upload(CLIENT_A, {
      markdown: mermaidMd,
      name: 'With mermaid',
    });
    const withoutDiagram = await upload(CLIENT_A, {
      markdown: plainMd,
      name: 'Without mermaid',
    });

    const fetchPdf = (uid: string, token: string) =>
      app.hono.fetch(
        new Request(`http://test/api/documents/${uid}/export.pdf`, {
          headers: withInvite(headersFor(CLIENT_A), token),
        }),
      );
    const resDiagram = await fetchPdf(withDiagram.uid, withDiagram.admin_invite.token);
    const resPlain = await fetchPdf(withoutDiagram.uid, withoutDiagram.admin_invite.token);
    expect(resDiagram.status).toBe(200);
    expect(resPlain.status).toBe(200);
    const diagram = Buffer.from(await resDiagram.arrayBuffer());
    const plain = Buffer.from(await resPlain.arrayBuffer());
    expect(diagram.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    // Exact size gap varies by Chromium version, but a rendered
    // mermaid SVG is always at least a few KB heavier than a plain
    // paragraph. 2 KB is a conservative lower bound.
    expect(diagram.length - plain.length).toBeGreaterThan(2000);
  }, 45_000);

  test('GET /:uid/export.pdf rejects path-traversal-shaped theme names cleanly', async () => {
    // An unknown theme name should fall back to default, not 500. The
    // CSS loader's `isValidThemeName` plus the ENOENT fallback cover
    // both "looks fine but doesn't exist" and "obvious attack".
    const created = await upload(CLIENT_A, {
      markdown: '# Safe\n\nBody.\n',
      name: 'Safe doc',
    });
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf?theme=../../etc/passwd`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
  }, 30_000);

  test('GET /:uid/export.pdf blocks outbound requests to disallowed hosts (SSRF)', async () => {
    // A doc authored with an absolute `<img src="http://…">` pointed
    // at an unroutable host. Without the request-routing firewall,
    // Chromium would try to fetch this during export and either hang
    // for 30 s (timeout) or potentially probe the server's internal
    // network. With the firewall, the request is aborted at
    // route.abort() and the export completes in <1 s.
    const created = await upload(CLIENT_A, {
      // 192.0.2.0/24 is RFC 5737 TEST-NET-1 — guaranteed unroutable.
      // Using it means the test proves request abort (not DNS or
      // connection refusal) is what lets the export finish quickly.
      markdown: '# SSRF smoke\n\n![external](http://192.0.2.1/internal.png)\n\nBody.\n',
      name: 'SSRF fixture',
    });
    const started = Date.now();
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    // If the firewall were off, this would be at or near the 20 s
    // test-level timeout waiting for 192.0.2.1 to fail. Cap at 10 s
    // to leave generous headroom for a loaded CI box while still
    // catching regressions that remove the block.
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  test('firewall blocks http:// even to an allowlisted host', async () => {
    // Defense-in-depth: the firewall only lets `https:` through,
    // even for names on ALLOWED_EXPORT_HOSTS. Proves the policy
    // isn't just hostname-based — a user-authored
    // `<img src="http://fonts.googleapis.com/…">` can't ride the
    // Google Fonts allowance to trigger cleartext traffic from
    // the worker's network position.
    //
    // We point at fonts.googleapis.com over http so the hostname
    // match would succeed under a naïve allowlist; only the
    // protocol check stops the request. No actual network traffic
    // reaches Google — Playwright aborts at route.abort() first.
    const created = await upload(CLIENT_A, {
      markdown:
        '# Downgrade attempt\n\n![font](http://fonts.googleapis.com/evil.png)\n\nBody.\n',
      name: 'Downgrade fixture',
    });
    const started = Date.now();
    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(0, 5).toString('utf8')).toBe('%PDF-');
    expect(elapsed).toBeLessThan(10_000);
  }, 30_000);

  test('inlineImageAssets targets the src attribute even when alt text shares the ref name', async () => {
    // Regression test for the pre-`d`-flag indexOf-based inliner,
    // which would have targeted the FIRST occurrence of "logo.png"
    // in the `<img>` tag — i.e. the alt text — leaving the real
    // `src` intact. Result: the blob was never inlined, and
    // Chromium saw an unresolved relative path.
    //
    // The renderer produces `<img src="REF" alt="ALT">` in that
    // attribute order (verified by rehype-stringify), so we exploit
    // alt text containing the ref name to hit the collision path.
    const created = await upload(CLIENT_A, {
      markdown: '# Alt collision\n\n![logo.png has a preview](logo.png)\n',
      name: 'Alt collision',
    });
    const PNG_BYTES = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkAAIAAAoAAv/lxKUAAAAASUVORK5CYII=',
      ),
      (c) => c.charCodeAt(0),
    );
    const form = new FormData();
    form.append('file', new Blob([PNG_BYTES], { type: 'image/png' }), 'logo.png');
    form.append('ref_name', 'logo.png');
    const uploadRes = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/assets`, {
        method: 'POST',
        headers: withInvite(
          new Headers({
            [CLIENT_HEADER]: CLIENT_A.id,
            [CLIENT_NAME_HEADER]: CLIENT_A.name,
          }),
          created.admin_invite.token,
        ),
        body: form,
      }),
    );
    expect(uploadRes.status).toBe(201);

    const res = await app.hono.fetch(
      new Request(`http://test/api/documents/${created.uid}/export.pdf`, {
        headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
      }),
    );
    expect(res.status).toBe(200);
    const buf = Buffer.from(await res.arrayBuffer());
    // PNG actually landed as a PDF image object — same assertion as
    // the plain embedded-asset test.
    expect(buf.toString('latin1')).toMatch(/\/Subtype\s*\/Image/);
  }, 30_000);

  test('mermaid-wait timeout is reported as 504 export-timeout, not 500', async () => {
    // Regression: before pdf.ts distinguished Playwright's own
    // `TimeoutError` from unexpected errors, a mermaid bootstrap that
    // never resolved `__marginaliaMermaidReady` within `mermaidWaitMs`
    // would surface to the client as a generic 500 instead of the
    // documented 504 export-timeout contract.
    //
    // We force the condition by configuring a hilariously-short
    // mermaid budget (1 ms) — mermaid.initialize() alone takes
    // several ms on any hardware, so Playwright's `waitForFunction`
    // always hits its timeout before the sentinel flips. Other
    // budgets stay at the test defaults so the failure is localised
    // to the mermaid path.
    configureExport({ mermaidWaitMs: 1 });
    try {
      const created = await upload(CLIENT_A, {
        markdown:
          '# Timeout fixture\n\n```mermaid\ngraph TD\n  A --> B\n```\n',
        name: 'Timeout fixture',
      });
      const res = await app.hono.fetch(
        new Request(`http://test/api/documents/${created.uid}/export.pdf`, {
          headers: withInvite(headersFor(CLIENT_A), created.admin_invite.token),
        }),
      );
      expect(res.status).toBe(504);
      const body = (await res.json()) as { error: string; elapsed_ms?: number };
      expect(body.error).toBe('export-timeout');
      expect(typeof body.elapsed_ms).toBe('number');
    } finally {
      // Restore the suite-level defaults so downstream tests aren't
      // starved. configureExport() validates positive integers now
      // (see export-config.test.ts).
      configureExport({ mermaidWaitMs: 10_000 });
    }
  }, 30_000);
});
