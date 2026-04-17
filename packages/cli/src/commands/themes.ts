import { BUILT_IN_THEMES, loadThemeCss } from '../themes.js';

const THEMES_USAGE = `Usage:
  marginalia themes list
  marginalia themes show <name>
`;

export async function themesCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;

  switch (sub) {
    case 'list':
      for (const name of BUILT_IN_THEMES) {
        console.log(name);
      }
      return 0;

    case 'show': {
      const name = rest[0];
      if (!name) {
        console.error('themes show: missing theme name');
        console.error(THEMES_USAGE);
        return 2;
      }
      try {
        process.stdout.write(loadThemeCss(name));
        return 0;
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        return 1;
      }
    }

    default:
      console.error(`unknown themes subcommand: ${sub ?? '(none)'}`);
      console.error(THEMES_USAGE);
      return 2;
  }
}
