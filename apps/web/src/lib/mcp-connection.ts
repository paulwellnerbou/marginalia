/**
 * How to connect an MCP client to this instance's `/mcp` URL.
 *
 * Every client takes the same Streamable HTTP URL; only the way it is
 * handed over differs — a CLI command, the client's own config file, or
 * a field in a web app's connector form.
 */

export type McpClient = 'claude' | 'codex' | 'gemini' | 'vibe' | 'vibe-web' | 'web';

export const MCP_CLIENTS: { value: McpClient; label: string }[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex CLI' },
  { value: 'gemini', label: 'Gemini CLI' },
  { value: 'vibe', label: 'Mistral Vibe CLI' },
  { value: 'vibe-web', label: 'Mistral Vibe (web)' },
  { value: 'web', label: 'Other web apps' },
];

export type Setup = 'cli' | 'config' | 'connector';

export const SETUP_LABELS: Record<Setup, string> = {
  cli: 'Command line',
  config: 'Config file',
  connector: 'Connector',
};

/** Where `claude mcp add` stores the server. */
export type ClaudeScope = 'local' | 'project' | 'user';

export const CLAUDE_SCOPES: { value: ClaudeScope; label: string; description: string }[] = [
  { value: 'local', label: 'Local', description: 'Only you, only this project.' },
  {
    value: 'project',
    label: 'Project',
    description: 'Everyone who clones the project, through its .mcp.json.',
  },
  { value: 'user', label: 'User', description: 'Only you, in all your projects.' },
];

// The URL carries the agent's access token, so a file meant to be
// committed hands that access to everyone who can read the repository.
const SHARED_FILE_NOTE =
  '.mcp.json is usually committed, and this URL carries the agent’s access — everyone with the repository gets it.';

export interface ConnectionSnippet {
  setup: Setup;
  /** What to do with `text`. */
  instruction: string;
  text: string;
  /** A caveat shown under `text`. */
  note?: string;
}

/** The ways `client` can be set up, in the order the tabs show them. */
export function connectionSetups(
  client: McpClient,
  url: string,
  claudeScope: ClaudeScope = 'local',
  name = 'marginalia',
): [ConnectionSnippet, ...ConnectionSnippet[]] {
  // Shell commands quote the URL: it carries `&token=`, and an unquoted
  // `&` backgrounds everything before it and runs the rest as a separate
  // command, so the token would silently go missing.
  switch (client) {
    case 'claude':
      return [
        {
          setup: 'cli',
          instruction: claudeScope === 'user' ? 'Run:' : 'Run in your project:',
          text: `claude mcp add --transport http --scope ${claudeScope} ${name} '${url}'`,
          ...(claudeScope === 'project' && { note: SHARED_FILE_NOTE }),
        },
        {
          setup: 'config',
          instruction: 'Add to .mcp.json in your project:',
          text: `{
  "mcpServers": {
    "${name}": {
      "type": "http",
      "url": "${url}"
    }
  }
}`,
          note: SHARED_FILE_NOTE,
        },
      ];
    case 'codex':
      return [
        { setup: 'cli', instruction: 'Run:', text: `codex mcp add ${name} --url '${url}'` },
        {
          setup: 'config',
          instruction: 'Add to ~/.codex/config.toml:',
          text: `[mcp_servers.${name}]
url = "${url}"`,
        },
      ];
    case 'gemini':
      return [
        {
          setup: 'cli',
          instruction: 'Run:',
          text: `gemini mcp add --transport http ${name} '${url}'`,
        },
        {
          setup: 'config',
          // `httpUrl`, not `url`: Gemini reads `url` as an SSE endpoint.
          instruction: 'Add to ~/.gemini/settings.json:',
          text: `{
  "mcpServers": {
    "${name}": {
      "httpUrl": "${url}"
    }
  }
}`,
        },
      ];
    case 'vibe':
      // Vibe has no `mcp add`; servers are tables in its config.
      return [
        {
          setup: 'config',
          instruction: 'Add to ~/.vibe/config.toml:',
          text: `[[mcp_servers]]
name = "${name}"
transport = "streamable-http"
url = "${url}"`,
        },
      ];
    case 'vibe-web':
      return [
        {
          setup: 'connector',
          instruction: `In Vibe, open Context → Connectors → Add Connector → Custom MCP Connector, name it “${name}” and use this server URL:`,
          text: url,
        },
      ];
    case 'web':
      return [
        {
          setup: 'connector',
          instruction: `Add a custom MCP connector named “${name}” with this server URL:`,
          text: url,
        },
      ];
  }
}

/**
 * The client an agent's name most likely refers to, so an agent named
 * "Mistral" isn't handed a Claude Code command. Only a starting point:
 * the name is a label, and the user can pick another client.
 */
export function guessClient(agentName: string): McpClient {
  const name = agentName.toLowerCase();
  if (/mistral|vibe|devstral/.test(name)) return 'vibe';
  if (/codex|gpt|openai/.test(name)) return 'codex';
  if (/gemini/.test(name)) return 'gemini';
  return 'claude';
}

interface McpProject {
  id: string;
  label: string | null;
}

/**
 * The server name to register a keyring's agent under. One per project,
 * so that connecting a second client's keyring adds a server instead of
 * replacing the first. A label that leaves no slug, or the same slug as
 * another project's, takes a piece of the project's id as well.
 */
export function mcpServerName(
  project: McpProject | null,
  others: readonly McpProject[] = [],
): string {
  if (!project) return 'marginalia';
  const slug = projectSlug(project.label);
  const clash = !slug || others.some((o) => o.id !== project.id && projectSlug(o.label) === slug);
  return ['marginalia', slug, clash ? project.id.slice(-4) : '']
    .filter((part) => part !== '')
    .join('-');
}

function projectSlug(label: string | null): string {
  return (label ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
