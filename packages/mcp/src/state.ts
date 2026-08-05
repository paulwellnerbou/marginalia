import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Small on-disk cache so a document URL only has to be handed over once.
 *
 * Two things live here:
 *
 * - `clientId` — Marginalia's per-browser identity marker. The server
 *   uses it to decide who may edit or delete a comment, so it has to
 *   survive process restarts; otherwise every new MCP session would lose
 *   ownership of the comments it wrote in the previous one.
 * - `documents` — the invite token (and origin) last seen for a uid. The
 *   token is the capability that grants comment/propose rights, and it
 *   only appears in the shareable `/d/<uid>/<token>` URL.
 *
 * Both are secrets in the same sense a browser's localStorage is, so the
 * file is written 0600. Set `MARGINALIA_MCP_NO_PERSIST=1` to keep
 * everything in memory instead — at the cost of re-supplying the full
 * URL each session and losing edit rights over older comments.
 */
export interface DocumentMemory {
  baseUrl: string;
  token: string | null;
}

/**
 * As read back from disk. `documents` stays `unknown` because the file
 * is user-editable and may have been half-written — every field is
 * validated on the way in, not asserted.
 */
interface PersistedState {
  clientId: string;
  documents: Record<string, unknown>;
}

export class McpState {
  private clientId: string;
  private readonly documents = new Map<string, DocumentMemory>();
  private readonly file: string | null;

  constructor(stateDir: string | null, clientIdOverride: string | null) {
    this.file = stateDir ? join(stateDir, 'state.json') : null;
    const loaded = this.file ? readState(this.file) : null;
    this.clientId = clientIdOverride ?? loaded?.clientId ?? newClientId();
    // Both fields go on the wire — `baseUrl` as a URL, `token` as a
    // header value — so a hand-edited or half-written state file must
    // not smuggle a non-string through into a request, where it would
    // surface as a baffling auth failure rather than a bad cache entry.
    for (const [uid, raw] of Object.entries(loaded?.documents ?? {})) {
      const memory = asDocumentMemory(raw);
      if (memory) this.documents.set(uid, memory);
    }
    // A generated client id is only useful if it outlives the process.
    if (!loaded || loaded.clientId !== this.clientId) this.flush();
  }

  getClientId(): string {
    return this.clientId;
  }

  recall(uid: string): DocumentMemory | null {
    return this.documents.get(uid) ?? null;
  }

  remember(uid: string, memory: DocumentMemory): void {
    const prior = this.documents.get(uid);
    // A URL without a token must not erase a token learned earlier —
    // `/d/<uid>` is a perfectly normal way to refer to a document you
    // already have access to.
    const next: DocumentMemory = {
      baseUrl: memory.baseUrl,
      token: memory.token ?? prior?.token ?? null,
    };
    if (prior && prior.baseUrl === next.baseUrl && prior.token === next.token) return;
    this.documents.set(uid, next);
    this.flush();
  }

  forget(uid: string): void {
    if (this.documents.delete(uid)) this.flush();
  }

  knownDocuments(): Array<{ uid: string } & DocumentMemory> {
    return [...this.documents.entries()].map(([uid, memory]) => ({ uid, ...memory }));
  }

  /** Where state is persisted, for the `get_identity` tool to report. */
  get path(): string | null {
    return this.file;
  }

  private flush(): void {
    if (!this.file) return;
    const payload: PersistedState = {
      clientId: this.clientId,
      documents: Object.fromEntries(this.documents),
    };
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      // `mode` on writeFileSync only applies when the file is created, so
      // a state.json left behind world-readable — by an older build, or a
      // permissive umask — would keep leaking invite tokens on every
      // write. Enforce it every time instead of trusting creation.
      chmodSync(this.file, 0o600);
    } catch (err) {
      // Losing the cache degrades ergonomics, never correctness — the
      // caller can always re-supply the full URL. stderr is safe to
      // write to: stdout is the JSON-RPC channel, stderr is not.
      console.error('[marginalia-mcp] could not persist state:', err);
    }
  }
}

function readState(file: string): PersistedState | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistedState>;
    if (typeof parsed.clientId !== 'string' || parsed.clientId.length < 8) return null;
    const documents =
      parsed.documents && typeof parsed.documents === 'object' ? parsed.documents : {};
    return { clientId: parsed.clientId, documents };
  } catch {
    return null;
  }
}

/**
 * Accept an entry only if both fields are strings. A missing or
 * malformed token degrades the entry to "known document, no access
 * link" — the caller re-supplies the URL — rather than putting a
 * non-string into an HTTP header.
 */
function asDocumentMemory(raw: unknown): DocumentMemory | null {
  if (!raw || typeof raw !== 'object') return null;
  const { baseUrl, token } = raw as { baseUrl?: unknown; token?: unknown };
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return null;
  return { baseUrl, token: typeof token === 'string' && token.length > 0 ? token : null };
}

/** Matches the web client's format: 32 lowercase hex chars. */
function newClientId(): string {
  return randomBytes(16).toString('hex');
}
