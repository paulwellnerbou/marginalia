import { readFileSync, writeFileSync } from 'node:fs';
import { render, type RenderOptions } from '@markdowner/renderer';
import { parseArgs } from '../args.js';
import { loadThemeCss } from '../themes.js';
import { wrapFullHtml } from '../html-wrapper.js';

const RENDER_USAGE = `Usage:
  markdowner render <file.md> [options]
  markdowner render --stdin       [options]

Options:
  --theme=<name>      Theme to embed (default: default-light)
  --out=<file>        Write output to file (default: stdout)
  --fragment          Emit HTML fragment only (no <html>/<head>/<body>)
  --strict-refs       Exit non-zero on broken in-document references
  --mermaid=<mode>    client | svg (default: client)
`;

export async function renderCommand(argv: string[]): Promise<number> {
  const { flags, positional } = parseArgs(argv);
  const useStdin = flags.stdin === true;
  const file = useStdin ? undefined : positional[0];

  if (!useStdin && !file) {
    console.error('render: missing input file (pass a path, or use --stdin)');
    console.error(RENDER_USAGE);
    return 2;
  }

  const theme = typeof flags.theme === 'string' ? flags.theme : 'default-light';
  const out = typeof flags.out === 'string' ? flags.out : undefined;
  const fragment = flags.fragment === true;
  const strictRefs = flags['strict-refs'] === true;
  const mermaidMode = flags.mermaid === 'svg' ? 'svg' : 'client';

  const source = useStdin ? await readAllStdin() : readFileSync(file!, 'utf8');

  const renderOpts: RenderOptions = {
    mermaid: mermaidMode,
    strictRefs,
  };
  const result = await render(source, renderOpts);

  let output: string;
  if (fragment) {
    output = result.html;
  } else {
    const css = loadThemeCss(theme);
    output = wrapFullHtml(result, { css });
  }

  if (out) {
    writeFileSync(out, output, 'utf8');
  } else {
    process.stdout.write(output);
  }

  // Surface warnings to stderr so they don't corrupt stdout output.
  for (const w of result.warnings) {
    const at = w.line !== undefined ? `:${w.line}` : '';
    process.stderr.write(`warning [${w.kind}]${at}: ${w.message}\n`);
  }

  if (strictRefs && result.warnings.some((w) => w.kind === 'broken-ref')) {
    return 1;
  }
  return 0;
}

async function readAllStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}
