import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = new URL('../src/bin.ts', import.meta.url).pathname;

async function runCli(
  args: string[],
  opts: { stdin?: string } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', BIN, ...args], {
    stdin: opts.stdin !== undefined ? 'pipe' : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (opts.stdin !== undefined && proc.stdin) {
    proc.stdin.write(opts.stdin);
    proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('marginalia CLI', () => {
  test('renders a file to a full HTML document with theme CSS inlined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mdn-cli-'));
    try {
      const input = join(dir, 'doc.md');
      const output = join(dir, 'doc.html');
      writeFileSync(input, '# Hello\n\nA paragraph.\n');

      const r = await runCli(['render', input, '--out', output]);
      expect(r.code).toBe(0);

      const html = readFileSync(output, 'utf8');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<article class="marginalia">');
      expect(html).toContain('<h1 id="hello"');
      expect(html).toContain('--md-color-fg');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('renders from stdin with --fragment', async () => {
    const r = await runCli(['render', '--stdin', '--fragment'], {
      stdin: '# Title\n\nBody.\n',
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('<h1 id="title"');
    expect(r.stdout).not.toContain('<!DOCTYPE');
  });

  test('themes list prints the built-in themes', async () => {
    const r = await runCli(['themes', 'list']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('default');
    expect(r.stdout).toContain('handbook');
    expect(r.stdout).toContain('asciidoc-article');
    expect(r.stdout).toContain('beautiful');
    expect(r.stdout).toContain('serif-print');
  });

  test('themes show prints CSS', async () => {
    const r = await runCli(['themes', 'show', 'default']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('--md-max-width');
  });

  test('themes show on unknown theme exits 1', async () => {
    const r = await runCli(['themes', 'show', 'no-such-theme']);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('theme not found');
  });

  test('missing input is a usage error', async () => {
    const r = await runCli(['render']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('missing input file');
  });

  test('unknown command is a usage error', async () => {
    const r = await runCli(['nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command');
  });

  test('serif-print theme @import inlining produces a single CSS blob', async () => {
    const r = await runCli(['themes', 'show', 'serif-print']);
    expect(r.code).toBe(0);
    // serif-print @imports default; after inlining there should be no
    // @import left in the output.
    expect(r.stdout).not.toContain('@import');
    // and the imported file's content is present
    expect(r.stdout).toContain('--md-max-width');
  });

  test('handbook theme inlines its imports and exposes its accent palette', async () => {
    const r = await runCli(['themes', 'show', 'handbook']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/@import\s+["'][^"']*default\.css["']/);
    expect(r.stdout).toContain('Open Sans');
    expect(r.stdout).toContain('--md-color-accent: #1c6a72;');
  });

  test('asciidoc-article theme exposes the academy font stack and toc styling', async () => {
    const r = await runCli(['themes', 'show', 'asciidoc-article']);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/@import\s+["'][^"']*default\.css["']/);
    expect(r.stdout).toContain('Noto Serif');
    expect(r.stdout).toContain('#toc > .sectlevel1 > li');
  });
});
