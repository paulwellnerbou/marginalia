import { createHash } from 'node:crypto';
import {
  createMarginaliaMcpServer,
  MAX_CLIENT_ID_LENGTH,
  normalizeAgentName,
  sanitizeIdentityValue,
} from '@marginalia/mcp';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Context } from 'hono';
import { Hono } from 'hono';

/**
 * Marginalia's own MCP endpoint.
 *
 * The same tools `packages/mcp` exposes over stdio, served over HTTP by
 * the instance that already holds the documents. An agent connects with
 * a URL and nothing else — no checkout, no runtime, no local process —
 * which is the difference between "install this repo" and "point at my
 * server".
 *
 * Stateless: every request builds a fresh server and transport, handles
 * one JSON-RPC message, and throws both away. The tools keep no state
 * between calls (access travels in the document URL the agent is given),
 * so there is nothing a session would preserve, and nothing to leak
 * between the strangers who may share this endpoint.
 *
 * Tool calls run against the same Hono app in-process rather than
 * looping back over the network: no port to guess, no proxy round-trip,
 * and no risk of the instance failing to resolve its own public name.
 */
export function mcpRouter(deps: { hono: Hono }): Hono {
  const r = new Hono();
  r.all('/', async (c) => handleMcp(c, deps.hono));
  return r;
}

async function handleMcp(c: Context, app: Hono): Promise<Response> {
  const url = new URL(c.req.url);
  const displayName = readDisplayName(url);

  const { server } = createMarginaliaMcpServer(
    {
      // Document URLs the agent passes carry their own origin; this is
      // only the fallback for a bare uid, and this instance is the one
      // sensible answer.
      baseUrl: url.origin,
      displayName,
      clientId: readClientId(url, displayName),
      // A hosted endpoint must not reach other instances on behalf of
      // whoever connects to it.
      allowedHosts: [url.hostname],
      password: null,
      // Lets the connection carry the agent's access, so a reference
      // without a token of its own — a bare uid, or a comment link the
      // viewer stripped the token from — still arrives with it.
      defaultToken: readToken(url),
      // A stateless endpoint has nothing to remember, and nothing may be
      // written to the server's disk on behalf of a caller.
      stateDir: null,
      // Unused: `allowLocalFiles: false` keeps the filesystem tools off.
      downloadDir: '',
    },
    {
      fetchImpl: async (input, init) => app.fetch(new Request(input as URL | string, init)),
      // The filesystem here is the Marginalia host's, not the caller's.
      // Creating a document needs no invite, so leaving these on would
      // let anyone who can reach this endpoint read the server's files
      // out through `source_path` and write chosen bytes to a chosen
      // path through `export_document`. They would also produce results
      // the caller cannot reach, so there is nothing to trade away.
      allowLocalFiles: false,
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    // No sessionIdGenerator → stateless mode.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(c.req.raw);
  } finally {
    // Both are per-request; dropping them here keeps a long-lived
    // instance from accumulating one server per tool call.
    await transport.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
}

function readDisplayName(url: URL): string {
  return normalizeAgentName(url.searchParams.get('name'));
}

/**
 * The marker Marginalia uses to decide who may edit or delete a comment.
 *
 * An agent needs it stable across reconnects or it loses ownership of
 * what it wrote last session, so it is derived from the display name
 * rather than minted per connection. That means two agents connecting
 * under the same name share an identity — the same trade the browser
 * makes, where `clientId` is an unverified header a caller supplies.
 * Pass `client_id` explicitly to keep separate agents apart.
 */
/**
 * Optional `?token=` on the connection URL: the agent's invite for the
 * document it was connected for. Not a secret this endpoint holds — it
 * comes from the caller and is only replayed back to Marginalia on
 * their behalf, exactly as if they had pasted it in the document URL.
 */
function readToken(url: URL): string | null {
  const raw = sanitizeIdentityValue(url.searchParams.get('token'), MAX_CLIENT_ID_LENGTH);
  return raw.length > 0 ? raw : null;
}

function readClientId(url: URL, displayName: string): string {
  const explicit = sanitizeIdentityValue(url.searchParams.get('client_id'), MAX_CLIENT_ID_LENGTH);
  if (explicit.length >= 8) return explicit;
  return `mcp-${createHash('sha256').update(displayName).digest('hex').slice(0, 28)}`;
}
