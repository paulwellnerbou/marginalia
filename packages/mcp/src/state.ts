import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

interface PersistedState {
  clientId: string;
  documents: Record<string, DocumentMemory>;
}

export class McpState {
  private clientId: string;
  private readonly documents = new Map<string, DocumentMemory>();
  private readonly file: string | null;

  constructor(stateDir: string | null, clientIdOverride: string | null) {
    this.file = stateDir ? join(stateDir, 'state.json') : null;
    const loaded = this.file ? readState(this.file) : null;
    this.clientId = clientIdOverride ?? loaded?.clientId ?? newClientId();
    for (const [uid, memory] of Object.entries(loaded?.documents ?? {})) {
      if (typeof memory?.baseUrl === 'string') {
        this.documents.set(uid, { baseUrl: memory.baseUrl, token: memory.token ?? null });
      }
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
    return {
      clientId: parsed.clientId,
      documents: (parsed.documents ?? {}) as Record<string, DocumentMemory>,
    };
  } catch {
    return null;
  }
}

/** Matches the web client's format: 32 lowercase hex chars. */
function newClientId(): string {
  return randomBytes(16).toString('hex');
}
