/**
 * How to connect an MCP client to this instance's `/mcp` URL.
 *
 * Every client takes the same Streamable HTTP URL; only the way it is
 * handed over differs — a CLI command, a config entry, or a field in a
 * web app's connector form.
 */

export type McpClient = 'claude' | 'codex' | 'gemini' | 'vibe' | 'web' | 'json';

export const MCP_CLIENTS: { value: McpClient; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'vibe', label: 'Mistral Vibe' },
  { value: 'web', label: 'Le Chat, other web apps' },
  { value: 'json', label: 'Other (JSON config)' },
];

export interface ConnectionSnippet {
  /** What to do with `text`. */
  instruction: string;
  text: string;
}

export function connectionSnippet(client: McpClient, url: string): ConnectionSnippet {
  // Shell commands quote the URL: it carries `&token=`, and an unquoted
  // `&` backgrounds everything before it and runs the rest as a separate
  // command, so the token would silently go missing.
  switch (client) {
    case 'claude':
      return {
        instruction: 'Run:',
        text: `claude mcp add --transport http marginalia '${url}'`,
      };
    case 'codex':
      return { instruction: 'Run:', text: `codex mcp add marginalia --url '${url}'` };
    case 'gemini':
      return {
        instruction: 'Run:',
        text: `gemini mcp add --transport http marginalia '${url}'`,
      };
    case 'vibe':
      // Vibe has no `mcp add`; servers are tables in its config.
      return {
        instruction: 'Add to ~/.vibe/config.toml:',
        text: `[[mcp_servers]]
name = "marginalia"
transport = "streamable-http"
url = "${url}"`,
      };
    case 'web':
      return {
        instruction: 'Add a custom MCP connector named “marginalia” with this server URL:',
        text: url,
      };
    case 'json':
      return {
        instruction: 'Add to your client’s MCP settings:',
        text: `{
  "mcpServers": {
    "marginalia": {
      "type": "http",
      "url": "${url}"
    }
  }
}`,
      };
  }
}

/**
 * The client an agent's name most likely refers to, so an agent named
 * "Mistral" isn't handed a Claude Code command. Only a starting point:
 * the name is a label, and the user can pick another client.
 */
export function guessClient(agentName: string): McpClient {
  const name = agentName.toLowerCase();
  if (/le ?chat/.test(name)) return 'web';
  if (/mistral|vibe|devstral/.test(name)) return 'vibe';
  if (/codex|gpt|openai/.test(name)) return 'codex';
  if (/gemini/.test(name)) return 'gemini';
  if (/claude/.test(name)) return 'claude';
  return 'json';
}
