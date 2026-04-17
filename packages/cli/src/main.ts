import { renderCommand } from './commands/render.js';
import { themesCommand } from './commands/themes.js';

const USAGE = `markdowner — Markdown to beautiful themed HTML

Usage:
  markdowner render <file.md> [options]
  markdowner render --stdin [options]
  markdowner themes list
  markdowner themes show <name>

Render options:
  --theme=<name>      Theme to embed (default: default-light)
  --out=<file>        Write output to file (default: stdout)
  --fragment          Emit HTML fragment only (no <html>/<head>/<body>)
  --strict-refs       Exit non-zero on broken in-document references
  --mermaid=<mode>    client | svg (default: client)

Exit codes:
  0  success
  1  document had a warning/error that was requested to fail (strict modes)
  2  usage error
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return cmd ? 0 : 2;
  }

  switch (cmd) {
    case 'render':
      return renderCommand(rest);
    case 'themes':
      return themesCommand(rest);
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(USAGE);
      return 2;
  }
}
