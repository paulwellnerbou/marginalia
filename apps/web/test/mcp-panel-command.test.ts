import { describe, expect, test } from 'bun:test';
import { connectionSnippet, guessClient, type McpClient } from '../src/lib/mcp-connection.js';

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

  for (const client of ['claude', 'codex', 'gemini'] satisfies McpClient[]) {
    test(`${client}: the URL arrives as one intact argument`, async () => {
      const args = await argsOf(connectionSnippet(client, url).text);
      expect(args[0]).toBe(client);
      expect(args).toContain(url);
    });
  }

  test('unquoted, the shell breaks the command apart', async () => {
    // Not merely a truncated URL: the `&` backgrounds everything before
    // it, so the command never takes effect in the shell at all.
    expect(await argsOf(`claude mcp add --transport http marginalia ${url}`)).toEqual([]);
  });
});

describe('guessClient', () => {
  test('an agent named after a model gets that vendor’s client', () => {
    expect(guessClient('Mistral')).toBe('vibe');
    expect(guessClient('Le Chat')).toBe('web');
    expect(guessClient('Codex')).toBe('codex');
    expect(guessClient('Gemini')).toBe('gemini');
    expect(guessClient('Claude')).toBe('claude');
  });

  test('an unrecognised name gets the client-neutral config', () => {
    expect(guessClient('Reviewer')).toBe('json');
  });
});
