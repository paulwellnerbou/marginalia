import { describe, expect, test } from 'bun:test';

/**
 * The MCP tab hands out a command to paste into a shell, and the URL it
 * carries contains `&token=`. Unquoted, a shell splits on the `&`:
 * everything before it is backgrounded and the rest runs as a separate
 * command, so the token vanishes with no error. These pin the quoting by
 * asking a real shell what the argument list comes out as.
 */
describe('generated CLI command', () => {
  const url = 'https://marginalia.example.com/mcp?name=Codex&token=06qZ_dujFc1piqrGJFcIfg';

  async function argsOf(command: string): Promise<string[]> {
    const proc = Bun.spawn(['bash', '-c', `set -- ${command}; printf '%s\\n' "$@"`], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const out = await new Response(proc.stdout).text();
    return out.trim().split('\n').filter(Boolean);
  }

  test('quoted, the URL arrives as one intact argument', async () => {
    const args = await argsOf(`claude mcp add --transport http marginalia '${url}'`);
    expect(args[args.length - 1]).toBe(url);
  });

  test('unquoted, the shell breaks the command apart', async () => {
    // Not merely a truncated URL: the `&` backgrounds everything before
    // it, so the command never takes effect in the shell at all.
    expect(await argsOf(`claude mcp add --transport http marginalia ${url}`)).toEqual([]);
  });
});
