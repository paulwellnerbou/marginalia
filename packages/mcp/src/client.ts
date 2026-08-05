import type { McpConfig } from './config.js';
import { assertHostAllowed, type DocumentRef, parseDocumentRef } from './document-ref.js';
import type { McpState } from './state.js';

const CLIENT_HEADER = 'x-marginalia-client';
const CLIENT_NAME_HEADER = 'x-marginalia-client-name';
const INVITE_HEADER = 'x-marginalia-invite';
const SESSION_COOKIE = 'marginalia_session';

/**
 * An error the server reported, carrying its machine-readable code so
 * tool handlers can turn it into advice the model can act on.
 */
export class MarginaliaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Just the call signature — not `typeof fetch`, whose static extras
 * (`preconnect` and friends) an injected dispatcher has no reason to
 * implement.
 */
export type FetchLike = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
}

export class MarginaliaClient {
  /** Password-session cookies, keyed by `origin|uid`. Never persisted. */
  private readonly sessions = new Map<string, string>();

  constructor(
    private readonly config: McpConfig,
    private readonly state: McpState,
    /**
     * How requests reach Marginalia. Defaults to the global `fetch`, which
     * is what a standalone stdio server wants. The server's own hosted
     * `/mcp` endpoint injects its Hono dispatcher instead, so tool calls
     * are handled in-process rather than looping back out over the
     * network — no port guessing, no proxy round-trip.
     */
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  get displayName(): string {
    return this.config.displayName;
  }

  get clientId(): string {
    return this.state.getClientId();
  }

  get defaultBaseUrl(): string {
    return this.config.baseUrl;
  }

  /**
   * Turn whatever the caller passed into a concrete {origin, uid, token}.
   * A URL wins over anything remembered; a bare uid falls back to the
   * remembered origin/token, then to the configured default instance.
   */
  resolve(documentRef: string): DocumentRef {
    const parsed = parseDocumentRef(documentRef);
    const remembered = this.state.recall(parsed.uid);
    const baseUrl = parsed.baseUrl ?? remembered?.baseUrl ?? this.config.baseUrl;
    assertHostAllowed(baseUrl, this.config.allowedHosts);
    const ref: DocumentRef = {
      baseUrl,
      uid: parsed.uid,
      token: parsed.token ?? remembered?.token ?? null,
    };
    this.state.remember(ref.uid, { baseUrl: ref.baseUrl, token: ref.token });
    return ref;
  }

  async json<T>(ref: DocumentRef, path: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.send(ref, path, options);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async bytes(
    ref: DocumentRef,
    path: string,
    options: RequestOptions = {},
  ): Promise<{ bytes: Uint8Array; filename: string | null; headers: Headers }> {
    const res = await this.send(ref, path, options);
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { bytes, filename: filenameFromDisposition(res.headers), headers: res.headers };
  }

  /**
   * Exchange a password for a session cookie. The cookie is held in
   * memory for the life of the process and replayed on later requests
   * for the same document.
   */
  async authenticate(ref: DocumentRef, password: string): Promise<void> {
    const res = await this.send(
      ref,
      `/api/documents/${encodeURIComponent(ref.uid)}/auth`,
      { method: 'POST', body: { password, remember: true } },
      { skipSessionRetry: true },
    );
    const cookie = readSetCookie(res.headers, SESSION_COOKIE);
    if (!cookie) {
      throw new MarginaliaApiError(
        500,
        'no-session-cookie',
        'The server accepted the password but returned no session cookie.',
      );
    }
    this.sessions.set(sessionKey(ref), cookie);
  }

  /** Creating a document is the one call that has no document to resolve first. */
  createBaseRef(baseUrlOverride?: string): DocumentRef {
    const baseUrl = baseUrlOverride
      ? new URL(
          /^https?:\/\//i.test(baseUrlOverride) ? baseUrlOverride : `https://${baseUrlOverride}`,
        ).origin
      : this.config.baseUrl;
    assertHostAllowed(baseUrl, this.config.allowedHosts);
    return { baseUrl, uid: '', token: null };
  }

  rememberDocument(ref: DocumentRef): void {
    if (!ref.uid) return;
    this.state.remember(ref.uid, { baseUrl: ref.baseUrl, token: ref.token });
  }

  private async send(
    ref: DocumentRef,
    path: string,
    options: RequestOptions,
    internal: { skipSessionRetry?: boolean } = {},
  ): Promise<Response> {
    const url = new URL(path, ref.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers = new Headers();
    headers.set(CLIENT_HEADER, this.clientId);
    headers.set(CLIENT_NAME_HEADER, encodeHeaderValue(this.config.displayName));
    if (ref.token) headers.set(INVITE_HEADER, ref.token);
    const session = this.sessions.get(sessionKey(ref));
    if (session) headers.set('cookie', `${SESSION_COOKIE}=${session}`);

    let body: BodyInit | null = null;
    if (options.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(options.body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        redirect: 'follow',
      });
    } catch (err) {
      throw new MarginaliaApiError(
        0,
        'network-error',
        `Could not reach ${ref.baseUrl}: ${err instanceof Error ? err.message : String(err)}. ` +
          'Check MARGINALIA_BASE_URL, or pass the full document URL.',
      );
    }

    if (res.ok) return res;

    const code = await readErrorCode(res);
    // A configured password is worth spending once, transparently — the
    // alternative is a dead-end error for a document the user can open.
    if (
      res.status === 401 &&
      code === 'password-required' &&
      this.config.password &&
      !internal.skipSessionRetry
    ) {
      await this.authenticate(ref, this.config.password);
      return this.send(ref, path, options, { skipSessionRetry: true });
    }
    throw new MarginaliaApiError(res.status, code, describeApiError(res.status, code, ref));
  }
}

function sessionKey(ref: DocumentRef): string {
  return `${ref.baseUrl}|${ref.uid}`;
}

function encodeHeaderValue(s: string): string {
  // Header values must be latin-1; the server decodes with decodeURIComponent.
  return /^[\x20-\x7e]*$/.test(s) ? s : encodeURIComponent(s);
}

async function readErrorCode(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `http-${res.status}`;
  } catch {
    return `http-${res.status}`;
  }
}

function readSetCookie(headers: Headers, name: string): string | null {
  // `getSetCookie` exists in Bun/Node 20+; fall back to the folded header.
  const raw =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie') ?? ''];
  for (const line of raw) {
    for (const part of line.split(';')) {
      const [key, ...rest] = part.trim().split('=');
      if (key === name) {
        const value = rest.join('=');
        if (value) return value;
      }
    }
  }
  return null;
}

function filenameFromDisposition(headers: Headers): string | null {
  const cd = headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(cd);
  return match?.[1] ?? null;
}

/**
 * Turn a server error code into something a model can act on rather
 * than just report. Every message names the next concrete step.
 */
function describeApiError(status: number, code: string, ref: DocumentRef): string {
  switch (code) {
    case 'not-found':
      return `Document ${ref.uid} does not exist on ${ref.baseUrl} (or the id is wrong).`;
    case 'password-required':
      return `Document ${ref.uid} is password protected. Call authenticate first, or set MARGINALIA_PASSWORD.`;
    case 'wrong-password':
      return 'That password was rejected.';
    case 'forbidden':
      return (
        'Your access level is too low for this action. Marginalia grants rights through invite ' +
        'links: reader (view), collaborator (comment + propose), editor (also edit and accept ' +
        'proposals), admin. Ask the document owner for a link with the role you need, and pass ' +
        'that full URL as the `document` argument.'
      );
    case 'identity-required':
      return 'The server needs a display name. Set MARGINALIA_DISPLAY_NAME.';
    case 'anchor-block-not-found':
      return (
        'The anchor block id is not present in the current document source. Re-read the block ' +
        'list (the document may have changed since) and retry with a current block_id.'
      );
    case 'proposal-orphaned':
      return 'The text this proposal was anchored to no longer exists. Re-create the proposal against the current source.';
    case 'proposal-conflict':
      return 'The document changed underneath this proposal. Re-create it against the current source.';
    case 'proposal-storage-unavailable':
      return 'The server could not write the proposal branch to its git store.';
    case 'not-open':
      return 'That thread is already resolved, accepted, or rejected.';
    case 'not-resolved':
      return 'That thread is still open, so there is nothing to reopen.';
    case 'proposal-required':
      return 'That action only applies to edit proposals, and this thread is a plain comment.';
    case 'proposal-forbidden':
      return 'Use accept or reject on an edit proposal; resolve only applies to comment threads.';
    case 'body-required':
      return 'A comment needs a non-empty body.';
    case 'anchor-required':
      return 'The anchor is missing a block_id or quote.';
    case 'export-engine-missing':
      return 'PDF export needs Chromium on the server: `bunx playwright install chromium-headless-shell`.';
    case 'export-busy':
      return 'The server is already running the maximum number of exports. Retry in a moment.';
    case 'export-timeout':
      return 'The export took too long and was cancelled by the server.';
    default:
      return `Marginalia returned ${status} ${code}.`;
  }
}
