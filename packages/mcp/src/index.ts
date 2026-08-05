/**
 * Public surface of the Marginalia MCP server.
 *
 * Two ways in, one implementation: `bin.ts` runs it over stdio as a
 * local process, and `apps/server` mounts the same `createMarginaliaMcpServer`
 * behind an HTTP endpoint. Anything either entry point needs is exported
 * here.
 */
export type { FetchLike } from './client.js';
export type { McpConfig } from './config.js';
export {
  loadMcpConfig,
  MAX_CLIENT_ID_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  sanitizeIdentityValue,
} from './config.js';
export type { McpServerDeps } from './main.js';
export { createMarginaliaMcpServer, SERVER_NAME, SERVER_VERSION } from './main.js';
