import { AGENT_KEY_HEADER } from './agent-key.js';
import type { McpConfig } from './config.js';
import { assertHostAllowed, type DocumentRef, parseDocumentRef } from './document-ref.js';
import type { McpState } from './state.js';

const CLIENT_HEADER = 'x-marginalia-client';
const CLIENT_NAME_HEADER = 'x-marginalia-client-name';
const INVITE_HEADER = 'x-marginalia-invite';
const SESSION_COOKIE = 'marginalia_session';

/**
 * How long an agent-key answer is believed before asking again: a refusal,
 * or that the key's invite on a document is still the current one.
 */
const AGENT_ANSWER_TTL_MS = 60_000;

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
  /** Sent as multipart instead of `body`; fetch sets the boundary. */
  form?: FormData;
  /**
   * Also send the agent key, so the server can tie what it mints here to
   * the key and end it when the key is revoked. Only to this instance.
   */
  withAgentKey?: boolean;
  query?: Record<string, string | undefined>;
}

export class MarginaliaClient {
  /** Password-session cookies, keyed by `origin|uid`. Never persisted. */
  private readonly sessions = new Map<string, string>();
  /** Why the agent key could not open a document, keyed by uid. */
  private readonly agentRefusals = new Map<string, { code: string; at: number }>();
  /**
   * The key's own invite per uid. Kept here rather than in `McpState`, so
   * it never takes the place of a link the user handed over, and so a
   * failure with it is known to be the key's to repair.
   */
  private readonly agentInvites = new Map<string, { token: string; at: number }>();

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

  get hasAgentKey(): boolean {
    return !!this.config.agentKey;
  }

  /**
   * A request made with the agent key itself, against the configured
   * instance only: the key belongs to that instance's keyring and is never
   * sent anywhere a document reference could point.
   */
  async agentJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const key = this.config.agentKey;
    if (!key) {
      throw new MarginaliaApiError(
        400,
        'no-agent-key',
        'This connection has no agent key. Create one under "Your devices" on the Marginalia home page.',
      );
    }
    const headers = this.identityHeaders();
    headers.set(AGENT_KEY_HEADER, key);
    const res = await this.dispatch(new URL(path, this.config.baseUrl), headers, options);
    if (!res.ok) {
      const code = await readErrorCode(res);
      throw new MarginaliaApiError(res.status, code, describeAgentError(res.status, code));
    }
    return (await res.json()) as T;
  }

  /**
   * File a document this agent created in the user's keyring, then drop
   * its admin link: the user chose the key's role, and the creator's link
   * would otherwise sit above it for as long as it is remembered. From
   * then on the key's own invite is used.
   */
  async fileInKeyring(ref: DocumentRef, title: string | null): Promise<void> {
    await this.agentJson(`/api/agent/documents/${encodeURIComponent(ref.uid)}`, {
      method: 'PUT',
      body: { invite_token: ref.token, ...(title ? { title } : {}) },
    });
    this.state.forget(ref.uid);
    this.state.remember(ref.uid, { baseUrl: ref.baseUrl, token: null });
  }

  /**
   * The key's own invite on `ref`'s document, minted by the server on
   * first use. Null when there is no key, the reference is for another
   * instance, or the ring cannot open it: the request then goes out as it
   * would have without a key, and its error says why. `renew` asks the
   * server again even for an invite already held.
   */
  private async agentToken(ref: DocumentRef, renew = false): Promise<string | null> {
    if (!this.config.agentKey || !ref.uid || ref.baseUrl !== this.config.baseUrl) return null;
    const held = this.agentInvites.get(ref.uid);
    if (held && !renew) return held.token;
    const refused = this.agentRefusals.get(ref.uid);
    if (refused && Date.now() - refused.at < AGENT_ANSWER_TTL_MS) return null;
    try {
      const granted = await this.agentJson<{ invite_token: string }>(
        `/api/agent/documents/${encodeURIComponent(ref.uid)}/access`,
        { method: 'POST' },
      );
      this.agentRefusals.delete(ref.uid);
      this.agentInvites.set(ref.uid, { token: granted.invite_token, at: Date.now() });
      return granted.invite_token;
    } catch (err) {
      const code = err instanceof MarginaliaApiError ? err.code : 'network-error';
      this.agentRefusals.set(ref.uid, { code, at: Date.now() });
      this.agentInvites.delete(ref.uid);
      return null;
    }
  }

  /**
   * Whether a refusal under `token` may mean the key's invite was deleted.
   * On a readable document a deleted invite and a role refusal both come
   * back `forbidden`, so that case asks the server at most once a minute.
   */
  private agentInviteWorthRenewing(uid: string, token: string, code: string): boolean {
    const held = this.agentInvites.get(uid);
    if (!held || held.token !== token) return false;
    if (code === 'invite-required') return true;
    return code === 'forbidden' && Date.now() - held.at >= AGENT_ANSWER_TTL_MS;
  }

  private identityHeaders(): Headers {
    const headers = new Headers();
    headers.set(CLIENT_HEADER, this.clientId);
    headers.set(CLIENT_NAME_HEADER, encodeHeaderValue(this.config.displayName));
    return headers;
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
    // A token is a capability for one instance, so a token we hold is
    // only replayed when the reference actually resolves to the instance
    // it belongs to. Without this, a tokenless absolute URL naming any
    // other host — which a document's own text could talk an agent into
    // fetching — would carry the agent's invite straight to it.
    const rememberedToken = remembered?.baseUrl === baseUrl ? (remembered.token ?? null) : null;
    const connectionToken = baseUrl === this.config.baseUrl ? this.config.defaultToken : null;

    const ref: DocumentRef = {
      baseUrl,
      uid: parsed.uid,
      // An explicit token always wins, then one seen earlier for this
      // same instance, then the connection's own. The last is what lets
      // a tokenless link — a copied comment link, say — still arrive
      // with the agent's access.
      token: parsed.token ?? rememberedToken ?? connectionToken,
      commentId: parsed.commentId,
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

  /**
   * Replay the password session `from` holds for another document of its
   * folder. The server's session is the folder's, so without this every
   * document of a protected folder would need its own `authenticate`. The
   * key carries the origin, so it never reaches another instance.
   */
  shareSession(from: DocumentRef, uid: string): void {
    const session = this.sessions.get(sessionKey(from));
    if (session) this.sessions.set(sessionKey({ ...from, uid }), session);
  }

  private async send(
    ref: DocumentRef,
    path: string,
    options: RequestOptions,
    internal: { skipSessionRetry?: boolean; skipAgentRetry?: boolean } = {},
  ): Promise<Response> {
    const url = new URL(path, ref.baseUrl);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const headers = this.identityHeaders();
    const token = ref.token ?? (await this.agentToken(ref));
    if (token) headers.set(INVITE_HEADER, token);
    if (options.withAgentKey && this.config.agentKey && ref.baseUrl === this.config.baseUrl) {
      headers.set(AGENT_KEY_HEADER, this.config.agentKey);
    }
    const session = this.sessions.get(sessionKey(ref));
    if (session) headers.set('cookie', `${SESSION_COOKIE}=${session}`);

    const res = await this.dispatch(url, headers, options);
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
      return this.send(ref, path, options, { ...internal, skipSessionRetry: true });
    }
    // The key's invite can be deleted from the access panel while the key
    // still stands; the server then mints a fresh one, so ask it once.
    if (token && !internal.skipAgentRetry && this.agentInviteWorthRenewing(ref.uid, token, code)) {
      const fresh = await this.agentToken(ref, true);
      if (fresh && fresh !== token) {
        return this.send({ ...ref, token: fresh }, path, options, {
          ...internal,
          skipAgentRetry: true,
        });
      }
    }
    const refusal = token ? null : this.agentRefusals.get(ref.uid);
    const message = describeApiError(res.status, code, ref);
    throw new MarginaliaApiError(
      res.status,
      code,
      refusal ? `${message} ${describeAgentRefusal(refusal.code)}` : message,
    );
  }

  private async dispatch(url: URL, headers: Headers, options: RequestOptions): Promise<Response> {
    let body: BodyInit | null = options.form ?? null;
    if (!options.form && options.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(options.body);
    }
    try {
      return await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers,
        body,
        redirect: 'follow',
      });
    } catch (err) {
      throw new MarginaliaApiError(
        0,
        'network-error',
        `Could not reach ${url.origin}: ${err instanceof Error ? err.message : String(err)}. ` +
          'Check MARGINALIA_BASE_URL, or pass the full document URL.',
      );
    }
  }
}

function describeAgentRefusal(code: string): string {
  switch (code) {
    case 'not-in-keyring':
      return 'The agent key could not help: this document is not in the user’s keyring. Ask for its link.';
    case 'not-delegable':
      return (
        'The agent key could not help: the user’s keyring holds this document only through ' +
        'someone else’s link, not one they administer. Ask its owner for an access link.'
      );
    case 'keyring-link-stale':
      return (
        'The agent key could not help: the link the user’s keyring holds for this document no ' +
        'longer works, likely rotated on a device that has not synced since. Ask the user to ' +
        'open the document once on a synced device.'
      );
    case 'agent-key-invalid':
      return 'The agent key was rejected — it has been revoked, or its keyring deleted.';
    default:
      return `The agent key could not open it (${code}).`;
  }
}

function describeAgentError(status: number, code: string): string {
  switch (code) {
    case 'agent-key-invalid':
      return (
        'The agent key was rejected — it has been revoked, or its keyring deleted. Create a new ' +
        'one under "Your devices" on the Marginalia home page and update the connection.'
      );
    case 'admin-invite-required':
      return 'Only a document’s admin link can be added to the keyring.';
    case 'keyring-full':
      return 'The keyring is full; the user has to forget some documents first.';
    default:
      return `Marginalia returned ${status} ${code}.`;
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
    case 'invite-required':
      return (
        `Document ${ref.uid} opens only with an access link (invite-required), and this ` +
        'session has none for it. Pass its full URL. If it belongs to a folder, reading any ' +
        'document of that folder with its link opens this one too.'
      );
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
    case 'folder-not-found':
      return `There is no document ${ref.uid} on ${ref.baseUrl} to add this beside. Check the uid, or pass the document's full URL.`;
    case 'name-required':
      return 'A document added to a folder needs a `name` — the folder lists its documents by it.';
    case 'anchor-block-not-found':
      return (
        'The anchor block id is not present in the current document source. Re-read the block ' +
        'list (the document may have changed since) and retry with a current block_id.'
      );
    case 'proposal-orphaned':
      return (
        'The text this proposal was anchored to no longer exists. Try repair_proposal_anchor ' +
        'first; if that fails, re-create the proposal against the current source.'
      );
    case 'proposal-conflict':
      return (
        'The document changed underneath this proposal. If it is yours, refresh it with ' +
        'update_proposal using text based on the current source; otherwise re-create it.'
      );
    case 'proposal-merge-unavailable':
      return (
        'The server could not run a three-way merge (its `git` binary is missing or broken). ' +
        'This is a server misconfiguration, not a problem with the proposal — report it to the ' +
        'operator and retry afterwards.'
      );
    case 'proposal-update-unavailable':
      return 'This proposal predates branch storage and cannot be updated in place. Re-create it against the current source.';
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
