import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Runtime configuration, entirely from the environment — an MCP server
 * started over stdio has no CLI surface the user reliably controls, so
 * env vars are the only configuration channel that survives every host
 * (Claude Code, Claude Desktop, Codex, …).
 */
export interface McpConfig {
  /** Instance used when a tool is handed a bare document uid. */
  baseUrl: string;
  /** Name every comment and proposal is authored under. */
  displayName: string;
  /** Explicit client id override; otherwise one is persisted per install. */
  clientId: string | null;
  /**
   * When non-empty, only these hosts may be contacted — even if a tool
   * argument carries an absolute URL somewhere else. Unset means any
   * host the user names in a document URL is allowed.
   */
  allowedHosts: string[];
  /** Password for password-protected documents, so it never has to be typed into a chat. */
  password: string | null;
  /** Where the client id + per-document invite tokens are cached. Null disables persistence. */
  stateDir: string | null;
  /** Default destination for `export_document`. */
  downloadDir: string;
}

const DEFAULT_BASE_URL = 'http://localhost:3434';

/**
 * Clean a value that becomes an identity header.
 *
 * Control characters have to go before the value is used, not after.
 * `x-marginalia-client-name` is percent-encoded on the way out, so a
 * newline survives the trip and lands in the database as a raw CR/LF —
 * harmless to render, but it corrupts the line-oriented text the tools
 * emit and reads as a broken name in the viewer. `x-marginalia-client`
 * is sent verbatim, where `Headers.set` rejects the same characters and
 * takes the whole tool call down with it.
 *
 * Shared so the stdio and hosted entry points cannot drift: the hosted
 * one also hashes the name into a client id, and a value that hashed
 * differently from the one it sent would split an agent's identity.
 */
export function sanitizeIdentityValue(raw: string | null | undefined, maxLength: number): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the intent
  return (raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength);
}

export const MAX_DISPLAY_NAME_LENGTH = 80;
export const MAX_CLIENT_ID_LENGTH = 200;

export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  return {
    baseUrl: normalizeBaseUrl(env.MARGINALIA_BASE_URL ?? DEFAULT_BASE_URL),
    displayName:
      sanitizeIdentityValue(env.MARGINALIA_DISPLAY_NAME, MAX_DISPLAY_NAME_LENGTH) || 'Claude',
    clientId: nonEmpty(sanitizeIdentityValue(env.MARGINALIA_CLIENT_ID, MAX_CLIENT_ID_LENGTH)),
    allowedHosts: (env.MARGINALIA_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
    password: nonEmpty(env.MARGINALIA_PASSWORD),
    stateDir: isTruthy(env.MARGINALIA_MCP_NO_PERSIST)
      ? null
      : (nonEmpty(env.MARGINALIA_MCP_STATE_DIR) ?? join(homedir(), '.config', 'marginalia-mcp')),
    downloadDir: nonEmpty(env.MARGINALIA_DOWNLOAD_DIR) ?? process.cwd(),
  };
}

/** Strip a trailing slash and any path so the result can be concatenated with `/api/...`. */
export function normalizeBaseUrl(raw: string): string {
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withScheme);
  return url.origin;
}

function nonEmpty(v: string | undefined): string | null {
  const trimmed = v?.trim();
  return trimmed ? trimmed : null;
}

function isTruthy(v: string | undefined): boolean {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}
