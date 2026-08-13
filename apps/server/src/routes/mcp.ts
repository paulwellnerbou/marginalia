import { createHash, randomUUID } from 'node:crypto';
import {
  createMarginaliaMcpServer,
  MAX_CLIENT_ID_LENGTH,
  normalizeAgentName,
  sanitizeIdentityValue,
} from '@marginalia/mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
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
 * Tool calls run against the same Hono app in-process rather than
 * looping back over the network: no port to guess, no proxy round-trip,
 * and no risk of the instance failing to resolve its own public name.
 *
 * Sessions exist for one reason: an invite token belongs to a single
 * document, so an agent working across several has to be told each one's
 * link. Without somewhere to put that, every request starts blind and a
 * link that carries no token of its own — a comment link, which the
 * viewer strips the token from — is only ever read-only. A session gives
 * the tools the same `uid → token` memory the stdio server keeps on
 * disk, so a document's link has to be handed over once rather than
 * every time.
 *
 * The memory is per session and never shared. Session ids are generated
 * here and unguessable, so one caller cannot address another's, which
 * makes a session as isolated as a separate stdio process.
 */
export function mcpRouter(deps: { hono: Hono }): Hono {
  const r = new Hono();
  const sessions = new SessionStore();
  r.all('/', async (c) => handleMcp(c, deps.hono, sessions));
  return r;
}

const SESSION_HEADER = 'mcp-session-id';

/**
 * Bun closes an HTTP request after 10 seconds without body activity by
 * default. The SDK's default SSE keep-alive interval is 15 seconds, so a
 * quiet GET stream is otherwise closed by Bun before its first keep-alive;
 * a reverse proxy then surfaces the truncated upstream response as a 502.
 * Keep this comfortably below Bun's default while leaving the timeout in
 * place for every other request.
 */
const SSE_KEEP_ALIVE_MS = 5_000;
const SSE_CONNECTED_FRAME = new TextEncoder().encode(': connected\n\n');

/**
 * How long a session may sit unused, and how many may exist at once.
 *
 * Each holds an MCP server with its tool schemas plus the tokens it has
 * been told, so they are small but not free, and nothing obliges a
 * client to send the DELETE that would close one. The idle sweep is what
 * actually bounds this; the cap is a backstop against a burst of
 * initializations, and evicts whatever has gone longest untouched.
 */
const SESSION_IDLE_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 200;

interface Session {
  server: McpServer;
  transport: WebStandardStreamableHTTPServerTransport;
  lastUsed: number;
  activeGet: ActiveSseResponse | null;
}

interface ActiveSseResponse {
  response: Response;
  cancel(reason?: unknown): Promise<void>;
}

class SessionStore {
  private readonly sessions = new Map<string, Session>();

  get(id: string): Session | null {
    this.sweep();
    const session = this.sessions.get(id);
    if (!session) return null;
    session.lastUsed = Date.now();
    return session;
  }

  add(id: string, session: Session): void {
    this.sessions.set(id, session);
    this.sweep();
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].reduce((a, b) =>
        a[1].lastUsed <= b[1].lastUsed ? a : b,
      );
      this.drop(oldest[0]);
    }
  }

  drop(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    void session.activeGet?.cancel().catch(() => undefined);
    void session.transport.close().catch(() => undefined);
    void session.server.close().catch(() => undefined);
  }

  private sweep(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of this.sessions) {
      if (session.lastUsed < cutoff) this.drop(id);
    }
  }
}

async function handleMcp(c: Context, app: Hono, sessions: SessionStore): Promise<Response> {
  const existingId = c.req.header(SESSION_HEADER);
  if (existingId) {
    const session = sessions.get(existingId);
    // Unknown or expired: let the transport answer, which is a 404 the
    // client handles by initializing again.
    if (!session) return notFoundSession();
    try {
      if (c.req.method === 'GET') {
        // Bun does not reliably cancel a server-side ReadableStream as soon
        // as its HTTP client disconnects. Clear the previous GET explicitly
        // or the SDK's single-active-stream guard rejects this reconnect.
        const previous = session.activeGet;
        if (previous) {
          session.activeGet = null;
          await previous.cancel('Replaced by a reconnect.').catch(() => undefined);
        }
      }

      const response = await session.transport.handleRequest(c.req.raw);
      if (c.req.method !== 'GET') return response;

      const active = primeSseResponse(response, () => {
        if (session.activeGet === active) session.activeGet = null;
      });
      if (!active) return response;
      session.activeGet = active;
      return active.response;
    } finally {
      // A DELETE means the client is done with this session whether or
      // not the transport managed to answer, so drop it either way —
      // otherwise a failed close leaves the session resident until the
      // idle sweep catches it.
      if (c.req.method === 'DELETE') sessions.drop(existingId);
    }
  }

  // No session id: an initialize request, or a malformed one the
  // transport will reject on its own.
  const { server, transport } = buildSession(new URL(c.req.url), app);
  let keep = false;
  try {
    await server.connect(transport);
    const response = await transport.handleRequest(c.req.raw);
    // A session id only exists once initialize succeeded. Anything else
    // — a malformed body, a request the transport rejects — leaves
    // nothing worth keeping, and holding it would strand an MCP server
    // per bad request with no session id to reach it by.
    const id = transport.sessionId;
    if (id) {
      keep = true;
      sessions.add(id, { server, transport, lastUsed: Date.now(), activeGet: null });
    }
    return response;
  } finally {
    // Covers the throwing path too: `handleRequest` can reject, and
    // unwinding without this would leak the pair just as silently.
    if (!keep) {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }
}

/**
 * Send one harmless SSE comment as soon as a long-lived GET stream opens.
 *
 * Bun does not flush the response headers until the body produces bytes. A
 * client with a five-second connection deadline would therefore race the
 * first periodic keep-alive and reconnect even though the stream was healthy.
 * Comments are ignored by SSE parsers, while cancellation of this wrapper is
 * forwarded to the SDK stream so it can remove its active-stream mapping.
 */
function primeSseResponse(response: Response, onClosed: () => void): ActiveSseResponse | null {
  const source = response.body;
  if (!source || !response.headers.get('content-type')?.includes('text/event-stream')) {
    return null;
  }

  const reader = source.getReader();
  let closed = false;
  const finish = () => {
    if (closed) return;
    closed = true;
    onClosed();
  };
  const cancel = async (reason?: unknown) => {
    try {
      await reader.cancel(reason);
    } finally {
      finish();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(SSE_CONNECTED_FRAME);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          finish();
        } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        finish();
      }
    },
    async cancel(reason) {
      await cancel(reason);
    },
  });

  return {
    response: new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    cancel,
  };
}

function notFoundSession(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found. Initialize a new one.' },
      id: null,
    }),
    { status: 404, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * One MCP server per session, configured from the connection URL. The
 * identity and default token are fixed at initialize: later requests
 * carry only the session id, so there is nothing else they could come
 * from, and letting them change mid-session would mean an agent's
 * authorship shifting under it.
 */
function buildSession(
  url: URL,
  app: Hono,
): { server: McpServer; transport: WebStandardStreamableHTTPServerTransport } {
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
      // viewer stripped the token from — still arrives with it. Only
      // covers the one document it names; anything else is learned
      // during the session from the links the agent is handed.
      defaultToken: readToken(url),
      // In-memory for the life of the session. Nothing may be written to
      // the server's disk on behalf of a caller, and a token learned
      // here must not outlive the connection that supplied it.
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
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    keepAliveMs: SSE_KEEP_ALIVE_MS,
  });

  return { server, transport };
}

function readDisplayName(url: URL): string {
  return normalizeAgentName(url.searchParams.get('name'));
}

/**
 * Optional `?token=` on the connection URL: the agent's invite for the
 * document it was connected for. Not a secret this endpoint holds — it
 * comes from the caller and is only replayed back to Marginalia on
 * their behalf, exactly as if they had pasted it in the document URL.
 *
 * Scoped to the instance it names: `MarginaliaClient` only replays it
 * for a reference that resolves back to this origin.
 */
function readToken(url: URL): string | null {
  const raw = sanitizeIdentityValue(url.searchParams.get('token'), MAX_CLIENT_ID_LENGTH);
  return raw.length > 0 ? raw : null;
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
function readClientId(url: URL, displayName: string): string {
  const explicit = sanitizeIdentityValue(url.searchParams.get('client_id'), MAX_CLIENT_ID_LENGTH);
  if (explicit.length >= 8) return explicit;
  return `mcp-${createHash('sha256').update(displayName).digest('hex').slice(0, 28)}`;
}
