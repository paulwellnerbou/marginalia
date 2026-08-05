import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_CLIENT_ID_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  normalizeAgentName,
  sanitizeIdentityValue,
} from './identity.js';

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
  /**
   * Invite token applied to a document reference that carries none of
   * its own — so a bare uid, or a link the viewer stripped the token
   * from, still arrives with the agent's access. A token names one
   * document, so using it on another simply resolves to nothing and
   * the caller falls back to reader; it cannot leak sideways.
   */
  defaultToken: string | null;
  /** Where the client id + per-document invite tokens are cached. Null disables persistence. */
  stateDir: string | null;
  /** Default destination for `export_document`. */
  downloadDir: string;
}

const DEFAULT_BASE_URL = 'http://localhost:3434';

export function loadMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  return {
    baseUrl: normalizeBaseUrl(env.MARGINALIA_BASE_URL ?? DEFAULT_BASE_URL),
    displayName: normalizeAgentName(env.MARGINALIA_DISPLAY_NAME),
    clientId: nonEmpty(sanitizeIdentityValue(env.MARGINALIA_CLIENT_ID, MAX_CLIENT_ID_LENGTH)),
    allowedHosts: (env.MARGINALIA_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0),
    password: nonEmpty(env.MARGINALIA_PASSWORD),
    defaultToken: nonEmpty(
      sanitizeIdentityValue(env.MARGINALIA_INVITE_TOKEN, MAX_CLIENT_ID_LENGTH),
    ),
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
