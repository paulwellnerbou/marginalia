import { getClientId, getDisplayName, type Identity } from './identity.js';
import { loadInviteToken } from './invite.js';
import { markTransportFailure } from './retry.js';

export interface Anchor {
  level: number;
  text: string;
  id: string;
}

export interface TocNode extends Anchor {
  children: TocNode[];
}

export interface RenderedDocument {
  html: string;
  anchors: Anchor[];
  toc: TocNode[];
  frontmatter: Record<string, unknown>;
  warnings: Array<{ kind: string; message: string }>;
  blocks: Array<{ id: string; kind: string; text: string }>;
}

export interface ExportedDocumentRepresentation {
  frontmatter: Record<string, unknown>;
  anchors: Anchor[];
  toc: TocNode[];
  assets: Array<{ src: string; line?: number; alt: string | null; kind: 'image' | 'link' }>;
  mermaid: Array<{ index: number; source: string }>;
  blocks: Array<{
    id: string;
    kind: string;
    text: string;
    headingPath: string[];
    sectionIndex: number;
    sectionIndexPath: number[];
  }>;
  warnings: Array<{ kind: string; message: string; line?: number }>;
}

export interface ExportedComment {
  id: string;
  parent_id: string | null;
  parent_proposal_id?: string | null;
  anchor_block_id: string | null;
  anchor_quote: string | null;
  anchor_prefix: string | null;
  anchor_suffix: string | null;
  anchor_start_offset: number | null;
  anchor_end_offset: number | null;
  anchor_heading_path: string[] | null;
  anchor_section_index: number | null;
  anchor_section_index_path: number[] | null;
  author_client_id: string;
  author_display_name: string;
  body: string;
  link_status: string;
  resolved_at: number | null;
  resolved_by_name: string | null;
  created_at: number;
  updated_at: number;
  edit_proposal?: {
    anchor_kind: string | null;
    source_snapshot: string | null;
    proposed_text: string;
    status: ProposalStatus;
    accepted_oid: string | null;
  } | null;
}

export type DocumentFormat = 'markdown' | 'asciidoc';

/**
 * Mermaid renderer used for DOCX/PDF exports.
 *
 *   'mmdr'     — native Rust subprocess (fast, lower fidelity)
 *   'chromium' — real mermaid.js inside headless Chromium (slow,
 *                pixel-identical to the viewer)
 *
 * The viewer always uses mermaid.js; this only affects exports.
 */
export type MermaidRenderer = 'mmdr' | 'chromium';

export const MERMAID_RENDERERS: readonly MermaidRenderer[] = ['mmdr', 'chromium'] as const;

export function isDocumentFormat(v: unknown): v is DocumentFormat {
  return v === 'markdown' || v === 'asciidoc';
}

export interface DocumentBundle {
  version: number;
  kind: 'marginalia.document-bundle';
  exported_at: number;
  document: {
    name: string | null;
    source: string;
    /** Bundle v3+ carries format; older bundles default to markdown on import. */
    format?: DocumentFormat;
    /** @deprecated Accepted for back-compat with old bundles; ignored. */
    editable_by_anyone?: boolean;
    default_theme: string;
    /** Bundle v4+ carries the per-document mermaid renderer override. */
    mermaid_renderer?: MermaidRenderer | null;
  };
  representation?: ExportedDocumentRepresentation;
  comments: ExportedComment[];
}

export type Role = 'admin' | 'editor' | 'collaborator' | 'reader';

export type AssetKind = 'image' | 'include' | 'attachment';

export interface AttachedAsset {
  ref_name: string;
  asset_id: string;
  kind: AssetKind;
  mime: string;
  size: number;
  created_at: number;
  created_by: string;
}

/**
 * The document's book cover — an ordinary attached asset the document
 * points at, so it's fetched through the same authorized asset proxy as
 * any other image. Used for EPUB exports and as the thumbnail on the
 * document list.
 */
export interface DocumentCover {
  ref_name: string;
  /** sha256 of the bytes; doubles as a cache-busting URL version. */
  asset_id: string;
  mime: string;
}

export interface Document {
  uid: string;
  /** Human-friendly document name. Null → derive from rendered content. */
  name: string | null;
  source: string;
  rendered: RenderedDocument;
  /** Every asset currently attached to this doc (empty array if none). */
  attached_assets: AttachedAsset[];
  /** Stored book cover, or null when the doc has none. */
  cover: DocumentCover | null;
  format: DocumentFormat;
  default_theme: string;
  /**
   * Per-document override for the mermaid renderer used by DOCX/PDF
   * exports. `null` means "use server default" (typically `'mmdr'`).
   * The viewer is unaffected by this — it always uses mermaid.js.
   */
  mermaid_renderer: MermaidRenderer | null;
  password_protected: boolean;
  /** True → the document URL alone grants nothing; an invite link is required. */
  invite_only: boolean;
  role: Role;
  /** Server-forced display name (from the invite), or null if no invite. */
  display_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface HistoryEntry {
  oid: string;
  action: 'upload' | 'update' | 'restore' | 'accept-proposal' | 'unknown';
  actor: { client_id: string | null; display_name: string | null };
  timestamp: number;
  restored_from_oid: string | null;
  proposal: {
    id: string;
    author: { client_id: string; display_name: string };
    summary: string;
    /** The proposal thread was deleted — attribution remains, but there is no thread to open. */
    deleted: boolean;
  } | null;
}

export interface HistoryDiff {
  before: string;
  after: string;
}

/**
 * Proposal diff payload. Mirrors `HistoryDiff` but adds a `mergeable`
 * status so clients can disable accept/show a rebase hint without a
 * second round-trip.
 *
 * `mergeable` is `null` when the server doesn't compute it, which
 * happens in any of:
 *   - the proposal is accepted or rejected (mergeability is meaningless)
 *   - the proposal is not currently acceptable — `link_status` is
 *     `'orphaned'`, or a non-whole-document proposal lost its anchor
 *     block. Accept would refuse these regardless of the merge result,
 *     so the server skips the dry-run even for editors
 *   - the caller lacks edit permission and didn't opt in via
 *     `?mergeable=1` on the diff request (computing it under the
 *     per-doc lock is too expensive for read-only viewers)
 *   - the caller opted in but lacks propose permission — readers can't
 *     force the dry-run merge by spamming the query parameter
 *
 * A non-null value only ever appears for open, acceptable proposals —
 * the ones where the server attempted the mergeability check. The
 * attempt can still come back without an answer: `'unavailable'` means
 * the check itself could not run (no `git` binary), which is a
 * deployment fault rather than a property of the proposal.
 */
export interface ProposalDiff extends HistoryDiff {
  mergeable: 'clean' | 'conflict' | 'stale' | 'unavailable' | null;
  original: HistoryDiff | null;
}

export interface UploadOptions {
  /** Raw source text. */
  source: string;
  /** Source flavour. Defaults server-side to 'markdown'. */
  format?: DocumentFormat;
  /** Optional document name. Omit/empty → server stores null and the UI
   *  falls back to deriving a title from the rendered content. */
  name?: string;
  password_protected?: boolean;
  /** Restrict reads to invite-link holders from the moment the doc exists. */
  invite_only?: boolean;
  default_theme?: string;
}

export interface UploadResponse {
  uid: string;
  name: string | null;
  admin_invite: { token: string; url: string; display_name: string };
  default_theme: string;
  /** New documents always start at `null` (= use server default). */
  mermaid_renderer: MermaidRenderer | null;
  format: DocumentFormat;
  /**
   * Echoes back what the upload asked for. Optional because a tab loaded
   * from an older build can outlive a deploy and read a response that
   * predates the field.
   */
  invite_only?: boolean;
  password?: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/**
 * Stand-in code for a failure that carried no `{ error }` body to name
 * itself with — the reverse proxy answering for a server that died or
 * never accepted the connection, a plain-text 500, an HTML error page.
 * Exported so `apiErrorMessage` can recognise it and describe the
 * status instead of showing the reader the word "unknown".
 */
export const UNKNOWN_ERROR_CODE = 'unknown';

function encodeHeaderValue(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return encodeURIComponent(s);
}

/**
 * Shared auth-gate for `401 password-required`. Callers are stalled on
 * a per-docUid Promise, then retried once after the UI re-authenticates.
 *
 * Protocol:
 *   - gate dispatches `marginalia:auth-required { docUid }`
 *   - UI dispatches `marginalia:auth-resolved { docUid }` to release
 *   - UI dispatches `marginalia:auth-cancelled { docUid }` to reject
 *     all gated callers with a 401 ApiError
 *
 * Concurrent 401s for the same doc share one Promise → one prompt.
 */
const authGates = new Map<string, Promise<void>>();

export const AUTH_REQUIRED_EVENT = 'marginalia:auth-required';
export const AUTH_RESOLVED_EVENT = 'marginalia:auth-resolved';
export const AUTH_CANCELLED_EVENT = 'marginalia:auth-cancelled';

const AUTH_REQUIRED = AUTH_REQUIRED_EVENT;
const AUTH_RESOLVED = AUTH_RESOLVED_EVENT;
const AUTH_CANCELLED = AUTH_CANCELLED_EVENT;

/** UI helper: fire this after a successful `authenticate(docUid, pw)` call
 *  so any queued requests waiting on `waitForAuth` wake up and retry. */
export function notifyAuthResolved(docUid: string): void {
  window.dispatchEvent(new CustomEvent(AUTH_RESOLVED_EVENT, { detail: { docUid } }));
}

/** UI helper: fire this when the user dismisses the password prompt so
 *  waiters reject with a 401 ApiError instead of hanging forever. */
export function notifyAuthCancelled(docUid: string): void {
  window.dispatchEvent(new CustomEvent(AUTH_CANCELLED_EVENT, { detail: { docUid } }));
}

/**
 * Is an auth-gate currently open for this doc? The UI reads this on
 * mount as a durability mechanism — AUTH_REQUIRED is dispatched
 * synchronously, so a listener that attaches later (e.g. a dialog
 * mounted after the offending request fired) would miss the event and
 * the gate would hang. Polling this on mount lets the dialog pick up
 * any gate that was already armed.
 */
export function isAuthPending(docUid: string): boolean {
  return authGates.has(docUid);
}

function waitForAuth(docUid: string): Promise<void> {
  const existing = authGates.get(docUid);
  if (existing) return existing;

  const gate = new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      window.removeEventListener(AUTH_RESOLVED, onResolved as EventListener);
      window.removeEventListener(AUTH_CANCELLED, onCancelled as EventListener);
      authGates.delete(docUid);
    };
    const onResolved = (e: CustomEvent<{ docUid: string }>) => {
      if (e.detail?.docUid !== docUid) return;
      cleanup();
      resolve();
    };
    const onCancelled = (e: CustomEvent<{ docUid: string }>) => {
      if (e.detail?.docUid !== docUid) return;
      cleanup();
      reject(new ApiError(401, 'password-required'));
    };
    window.addEventListener(AUTH_RESOLVED, onResolved as EventListener);
    window.addEventListener(AUTH_CANCELLED, onCancelled as EventListener);
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED, { detail: { docUid } }));
  });
  authGates.set(docUid, gate);
  return gate;
}

/**
 * A timeout signal, or null where the runtime has no `AbortSignal.timeout`.
 *
 * Degrading to "no ceiling" is deliberate. The alternative — an
 * `AbortController` and a timer that every exit path has to clear — is a
 * second timeout implementation living in the one function every API
 * call goes through, and it would only ever run on browsers older than
 * the container queries the document layout already depends on. Losing
 * the ceiling there restores the behaviour those browsers had anyway;
 * calling a missing method would instead throw synchronously and turn
 * every read into a hard failure.
 */
function timeoutSignal(timeoutMs: number | undefined): AbortSignal | null {
  if (timeoutMs === undefined) return null;
  if (typeof AbortSignal?.timeout !== 'function') return null;
  return AbortSignal.timeout(timeoutMs);
}

async function request<T>(
  path: string,
  init: RequestInit & {
    identity?: Identity | null;
    docUid?: string;
    _retry?: boolean;
    /**
     * Reject with a `TimeoutError` if the whole exchange, body included,
     * outlasts this. Opt-in: uploads and exports are legitimately slow,
     * and a ceiling that fits a JSON read would cut them off.
     *
     * A caller's own `signal` still wins where one is given. Where it
     * isn't, the signal is minted fresh on each pass through this
     * function rather than once per logical call, so the retry after a
     * password prompt starts a new budget — the prompt can sit on a
     * dialog for a minute, and a signal carried over from the first
     * attempt would abort the second the instant it began.
     */
    timeoutMs?: number;
  } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  // Don't set a content-type for FormData — the browser fills in
  // `multipart/form-data; boundary=...` on its own, and forcing a
  // content-type here would break the boundary. Only set JSON when
  // the caller didn't supply a body of another shape.
  if (!(init.body instanceof FormData) && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }

  const identity = init.identity ?? fallbackIdentity();
  const clientId = identity?.clientId ?? getClientId();
  headers.set('x-marginalia-client', clientId);
  if (identity?.displayName) {
    headers.set('x-marginalia-client-name', encodeHeaderValue(identity.displayName));
  }

  if (init.docUid) {
    const token = loadInviteToken(init.docUid);
    if (token) headers.set('x-marginalia-invite', token);
  }

  const signal = init.signal ?? timeoutSignal(init.timeoutMs);
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers,
      credentials: 'include',
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    // Only here is a `TypeError` known to be a dead connection rather
    // than a bug one line further down. Say so while we can.
    throw markTransportFailure(err);
  }
  if (!res.ok) {
    let code: string = UNKNOWN_ERROR_CODE;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) code = body.error;
    } catch {
      /* ignore */
    }
    // Pause-prompt-retry once; _retry guards against retry loops.
    if (res.status === 401 && code === 'password-required' && init.docUid && !init._retry) {
      await waitForAuth(init.docUid);
      return request(path, { ...init, _retry: true });
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Binary sibling of `request<T>` — same auth-gate and identity/invite
 * headers, but returns the raw Response so the caller can read a Blob
 * (or parse a Content-Disposition filename) without force-parsing
 * JSON. Used by the DOCX export today; any future binary export can
 * share this.
 */
async function requestBinary(
  path: string,
  init: RequestInit & { identity?: Identity | null; docUid?: string; _retry?: boolean } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  const identity = init.identity ?? fallbackIdentity();
  const clientId = identity?.clientId ?? getClientId();
  headers.set('x-marginalia-client', clientId);
  if (identity?.displayName) {
    headers.set('x-marginalia-client-name', encodeHeaderValue(identity.displayName));
  }
  if (init.docUid) {
    const token = loadInviteToken(init.docUid);
    if (token) headers.set('x-marginalia-invite', token);
  }

  // Tagged like its sibling above, so the invariant holds for the whole
  // module: every rejection that came off the wire says so.
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, credentials: 'include' });
  } catch (err) {
    throw markTransportFailure(err);
  }
  if (!res.ok) {
    let code: string = UNKNOWN_ERROR_CODE;
    try {
      const body = (await res.clone().json()) as { error?: string };
      if (body.error) code = body.error;
    } catch {
      /* ignore */
    }
    if (res.status === 401 && code === 'password-required' && init.docUid && !init._retry) {
      await waitForAuth(init.docUid);
      return requestBinary(path, { ...init, _retry: true });
    }
    throw new ApiError(res.status, code);
  }
  return res;
}

function fallbackIdentity(): Identity | null {
  const clientId = getClientId();
  const displayName = getDisplayName();
  if (!clientId || !displayName) return null;
  return { clientId, displayName };
}

// --- documents -------------------------------------------------------

export function uploadDocument(opts: UploadOptions, identity: Identity): Promise<UploadResponse> {
  return request<UploadResponse>('/api/documents', {
    method: 'POST',
    body: JSON.stringify(opts),
    identity,
  });
}

export function getDocument(uid: string): Promise<Document> {
  return request<Document>(`/api/documents/${encodeURIComponent(uid)}`, {
    method: 'GET',
    docUid: uid,
  });
}

export function exportDocumentBundle(uid: string): Promise<DocumentBundle> {
  return request<DocumentBundle>(`/api/documents/${encodeURIComponent(uid)}/export`, {
    method: 'GET',
    docUid: uid,
  });
}

/**
 * Fetches a DOCX export of the document and returns the bytes plus a
 * server-suggested filename (from Content-Disposition). The caller is
 * responsible for triggering the browser download — kept outside this
 * function so tests and other consumers (e.g. a future "Send DOCX via
 * email" button) don't have to stub out DOM side effects.
 *
 * Theme defaults to the document's current default theme on the
 * server; passing an explicit id overrides it (matches viewer
 * behavior: the user's selected theme gets baked into the export).
 */
/**
 * Server-side review mode the renderer always emits when asked:
 * BOTH open comments and open edit proposals fold into the export
 * as native Word features. Resolved / accepted / rejected threads
 * are excluded server-side and there is no opt-in to bring them
 * back — the export is always a snapshot of what's still open.
 */
export type DocxReviewMode = 'both';

export interface DocxExportClientOptions {
  theme?: string;
  /**
   * Fold the document's open comments + edit proposals into the
   * DOCX as native Word features. Omit (or pass undefined) for a
   * vanilla export with no review chrome.
   */
  review?: DocxReviewMode;
}

export async function downloadDocumentDocx(
  uid: string,
  options: DocxExportClientOptions = {},
): Promise<{ blob: Blob; filename: string }> {
  const params = new URLSearchParams();
  if (options.theme) params.set('theme', options.theme);
  if (options.review) params.set('review', options.review);
  const qs = params.toString();
  const res = await requestBinary(
    `/api/documents/${encodeURIComponent(uid)}/export.docx${qs ? `?${qs}` : ''}`,
    { method: 'GET', docUid: uid },
  );
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? `${uid}.docx`;
  return { blob, filename };
}

export async function downloadDocumentSourceWithAcceptedProposals(
  uid: string,
): Promise<{ blob: Blob; filename: string; skippedProposals: number }> {
  const res = await requestBinary(
    `/api/documents/${encodeURIComponent(uid)}/export.accepted-source`,
    { method: 'GET', docUid: uid },
  );
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? `${uid}-proposals-accepted.md`;
  return { blob, filename, skippedProposals: readSkippedProposalCount(res) };
}

export async function downloadDocumentDocxWithAcceptedProposals(
  uid: string,
  theme?: string,
): Promise<{ blob: Blob; filename: string; skippedProposals: number }> {
  const params = theme ? `?theme=${encodeURIComponent(theme)}` : '';
  const res = await requestBinary(
    `/api/documents/${encodeURIComponent(uid)}/export.accepted.docx${params}`,
    { method: 'GET', docUid: uid },
  );
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? `${uid}-proposals-accepted.docx`;
  return { blob, filename, skippedProposals: readSkippedProposalCount(res) };
}

export async function downloadDocumentMarkdownChapters(
  uid: string,
  acceptedProposals = false,
): Promise<{ blob: Blob; filename: string; skippedProposals: number }> {
  const route = acceptedProposals ? 'export.accepted.chapters.zip' : 'export.chapters.zip';
  const res = await requestBinary(`/api/documents/${encodeURIComponent(uid)}/${route}`, {
    method: 'GET',
    docUid: uid,
  });
  return {
    blob: await res.blob(),
    filename: filenameFromResponse(res, `${uid}-chapters.zip`),
    skippedProposals: readSkippedProposalCount(res),
  };
}

export async function downloadDocumentEpub(
  uid: string,
  options: { acceptedProposals?: boolean; cover?: File | null; theme?: string } = {},
): Promise<{ blob: Blob; filename: string; skippedProposals: number }> {
  const route = options.acceptedProposals ? 'export.accepted.epub' : 'export.epub';
  const params = new URLSearchParams();
  if (options.theme) params.set('theme', options.theme);
  const query = params.toString();
  const form = new FormData();
  if (options.cover) form.append('cover', options.cover, options.cover.name);
  const res = await requestBinary(
    `/api/documents/${encodeURIComponent(uid)}/${route}${query ? `?${query}` : ''}`,
    {
      method: 'POST',
      body: form,
      docUid: uid,
    },
  );
  return {
    blob: await res.blob(),
    filename: filenameFromResponse(res, `${uid}.epub`),
    skippedProposals: readSkippedProposalCount(res),
  };
}

function filenameFromResponse(res: Response, fallback: string): string {
  const cd = res.headers.get('Content-Disposition') ?? '';
  return cd.match(/filename="([^"]+)"/)?.[1] ?? fallback;
}

function readSkippedProposalCount(res: Response): number {
  const raw = res.headers.get('X-Marginalia-Proposals-Skipped');
  const n = raw ? Number(raw) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Fetches a PDF export of the document and returns the bytes plus a
 * server-suggested filename. Mirrors `downloadDocumentDocx` — same
 * theme/filename semantics on both ends of the wire.
 *
 * Errors surfaced by the server (`export-engine-missing`,
 * `export-busy`, `export-timeout`) come through `requestBinary` as
 * non-2xx responses and are handled by the caller's try/catch.
 */
export async function downloadDocumentPdf(
  uid: string,
  theme?: string,
): Promise<{ blob: Blob; filename: string }> {
  const params = theme ? `?theme=${encodeURIComponent(theme)}` : '';
  const res = await requestBinary(`/api/documents/${encodeURIComponent(uid)}/export.pdf${params}`, {
    method: 'GET',
    docUid: uid,
  });
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? `${uid}.pdf`;
  return { blob, filename };
}

export function updateDocument(
  uid: string,
  source: string,
  identity: Identity,
  commitMessage?: string,
): Promise<{ oid: string }> {
  return request<{ oid: string }>(`/api/documents/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    body: JSON.stringify({ source, ...(commitMessage ? { commit_message: commitMessage } : {}) }),
    identity,
    docUid: uid,
  });
}

export function getHistory(uid: string): Promise<{ history: HistoryEntry[] }> {
  return request<{ history: HistoryEntry[] }>(`/api/documents/${encodeURIComponent(uid)}/history`, {
    method: 'GET',
    docUid: uid,
  });
}

export function getHistoryDiff(uid: string, oid: string): Promise<HistoryDiff> {
  return request<HistoryDiff>(
    `/api/documents/${encodeURIComponent(uid)}/history/${encodeURIComponent(oid)}/diff`,
    {
      method: 'GET',
      docUid: uid,
    },
  );
}

export function restoreHistoryVersion(
  uid: string,
  oid: string,
  identity: Identity,
): Promise<{ oid: string }> {
  return request<{ oid: string }>(
    `/api/documents/${encodeURIComponent(uid)}/history/${encodeURIComponent(oid)}/restore`,
    {
      method: 'POST',
      identity,
      docUid: uid,
    },
  );
}

export function revertHistoryVersion(
  uid: string,
  oid: string,
  identity: Identity,
): Promise<{ oid: string; reopened_proposal_id: string | null }> {
  return request<{ oid: string; reopened_proposal_id: string | null }>(
    `/api/documents/${encodeURIComponent(uid)}/history/${encodeURIComponent(oid)}/revert`,
    {
      method: 'POST',
      identity,
      docUid: uid,
    },
  );
}

export function authenticate(
  uid: string,
  password: string,
  opts: { remember?: boolean } = {},
): Promise<void> {
  return request<void>(`/api/documents/${encodeURIComponent(uid)}/auth`, {
    method: 'POST',
    body: JSON.stringify({ password, remember: opts.remember !== false }),
    docUid: uid,
  });
}

export function logoutPasswordSession(uid: string): Promise<void> {
  return request<void>(`/api/documents/${encodeURIComponent(uid)}/logout`, {
    method: 'POST',
    docUid: uid,
  });
}

export function recoverCurrentPassword(uid: string): Promise<{ password: string }> {
  return request<{ password: string }>(
    `/api/documents/${encodeURIComponent(uid)}/password/recover`,
    {
      method: 'POST',
      docUid: uid,
    },
  );
}

export function importDocumentBundle(
  bundle: DocumentBundle,
  identity: Identity,
): Promise<UploadResponse & { imported_comments: number; imported_edit_proposals?: number }> {
  return request<UploadResponse & { imported_comments: number; imported_edit_proposals?: number }>(
    '/api/documents/import',
    {
      method: 'POST',
      body: JSON.stringify(bundle),
      identity,
    },
  );
}

// --- assets ----------------------------------------------------------

export function listAttachedAssets(uid: string): Promise<{ assets: AttachedAsset[] }> {
  return request<{ assets: AttachedAsset[] }>(`/api/documents/${encodeURIComponent(uid)}/assets`, {
    method: 'GET',
    docUid: uid,
  });
}

export function uploadAsset(
  uid: string,
  refName: string,
  file: File | Blob,
  identity: Identity,
  kind?: AssetKind,
): Promise<{ asset: AttachedAsset }> {
  const form = new FormData();
  form.append('file', file, fileName(refName, file));
  form.append('ref_name', refName);
  if (kind) form.append('kind', kind);
  // Route through `request()` (which now handles FormData bodies) so
  // the shared 401/password-required wait+retry gate applies —
  // otherwise an upload against a password-protected doc with an
  // expired session would just fail silently instead of triggering
  // the password prompt.
  return request<{ asset: AttachedAsset }>(`/api/documents/${encodeURIComponent(uid)}/assets`, {
    method: 'POST',
    body: form,
    identity,
    docUid: uid,
  });
}

export function deleteAttachedAsset(
  uid: string,
  refName: string,
  identity: Identity,
): Promise<void> {
  return request<void>(
    `/api/documents/${encodeURIComponent(uid)}/assets/${encodeRefPath(refName)}`,
    { method: 'DELETE', identity, docUid: uid },
  );
}

// --- cover -----------------------------------------------------------

/**
 * Store `file` as the document's book cover. Needs `editor`+; readers and
 * collaborators can still pass a one-off cover to the EPUB export instead.
 */
export function uploadDocumentCover(
  uid: string,
  file: File,
  identity: Identity,
): Promise<{ cover: DocumentCover }> {
  const form = new FormData();
  form.append('file', file, file.name);
  return request<{ cover: DocumentCover }>(`/api/documents/${encodeURIComponent(uid)}/cover`, {
    method: 'PUT',
    body: form,
    identity,
    docUid: uid,
  });
}

export function deleteDocumentCover(uid: string, identity: Identity): Promise<void> {
  return request<void>(`/api/documents/${encodeURIComponent(uid)}/cover`, {
    method: 'DELETE',
    identity,
    docUid: uid,
  });
}

/** Proxy URL for a document's cover image. */
export function coverProxyUrl(uid: string, cover: DocumentCover): string {
  return assetProxyUrl(uid, cover.ref_name, cover.asset_id);
}

export function assetProxyUrl(uid: string, refName: string, version?: string): string {
  const base = `/api/documents/${encodeURIComponent(uid)}/assets/${encodeRefPath(refName)}`;
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}

function encodeRefPath(refName: string): string {
  return refName.split('/').map(encodeURIComponent).join('/');
}

function fileName(refName: string, file: File | Blob): string {
  if (file instanceof File && file.name) return file.name;
  return refName.split('/').pop() ?? 'upload.bin';
}

// --- settings --------------------------------------------------------

export interface DocumentSettingsPatch {
  /** Rename the document. `null` clears it (→ derive from content). */
  name?: string | null;
  default_theme?: string;
  /**
   * Per-document mermaid renderer override. Pass `null` to clear the
   * override and fall back to the server default. Anything outside
   * the typed values is rejected by the server with 400.
   */
  mermaid_renderer?: MermaidRenderer | null;
  password?: null | 'rotate';
  /** Restrict reads to invite-link holders. Independent of `password`. */
  invite_only?: boolean;
}
export interface DocumentSettingsResponse {
  name: string | null;
  default_theme: string;
  mermaid_renderer: MermaidRenderer | null;
  password_protected: boolean;
  invite_only: boolean;
  password?: string;
}

export function updateDocumentSettings(
  uid: string,
  patch: DocumentSettingsPatch,
  identity: Identity,
): Promise<DocumentSettingsResponse> {
  return request<DocumentSettingsResponse>(`/api/documents/${encodeURIComponent(uid)}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
    identity,
    docUid: uid,
  });
}

// --- invites --------------------------------------------------------

/**
 *   - 'admin'   — one per doc, rotatable, never shared.
 *   - 'named'   — seeds display_name + role on first visit.
 *   - 'generic' — role only; visitor keeps their own name.
 */
export type InviteKind = 'admin' | 'named' | 'generic';

export interface Invite {
  token: string;
  /** Null for `kind='generic'` (the visitor brings their own name). */
  display_name: string | null;
  role: Role;
  kind: InviteKind;
  note: string | null;
  created_at: number;
  created_by_name: string;
  url: string;
}

export function listInvites(uid: string): Promise<{ invites: Invite[] }> {
  return request<{ invites: Invite[] }>(`/api/documents/${encodeURIComponent(uid)}/invites`, {
    method: 'GET',
    docUid: uid,
  });
}

/**
 * Create an invite. `kind` defaults to 'named' on the server for
 * back-compat with pre-Step-3 clients; pass 'generic' to mint a
 * no-forced-name link.
 */
export function createInvite(
  uid: string,
  payload: {
    kind?: InviteKind;
    /** Required for kind='named'; ignored for kind='generic'. */
    display_name?: string;
    role: Role;
    note?: string | null;
  },
  identity: Identity,
): Promise<{ invite: Invite }> {
  return request<{ invite: Invite }>(`/api/documents/${encodeURIComponent(uid)}/invites`, {
    method: 'POST',
    body: JSON.stringify(payload),
    identity,
    docUid: uid,
  });
}

export function deleteInvite(uid: string, token: string, identity: Identity): Promise<void> {
  return request<void>(
    `/api/documents/${encodeURIComponent(uid)}/invites/${encodeURIComponent(token)}`,
    { method: 'DELETE', identity, docUid: uid },
  );
}

/**
 * Claim a named/generic invite: the server mints an invite session cookie so
 * the token no longer needs to appear in the URL. The invite itself is NOT
 * deleted, so the same user can re-claim from another browser. Admin invites
 * and password-protected docs return an error — callers should ignore those
 * and fall back to the invite-header flow.
 */
export function claimInvite(
  uid: string,
  token: string,
): Promise<{ display_name: string | null; role: Role }> {
  return request<{ display_name: string | null; role: Role }>(
    `/api/documents/${encodeURIComponent(uid)}/invites/${encodeURIComponent(token)}/claim`,
    { method: 'POST' },
  );
}

/**
 * Rotate the admin invite: revokes the existing token and issues a fresh
 * one. Useful if the admin URL leaked. Keeps the same display_name + note.
 */
export function rotateAdminInvite(
  uid: string,
  identity: Identity,
): Promise<{ admin_invite: { token: string; url: string; display_name: string } }> {
  return request(`/api/documents/${encodeURIComponent(uid)}/invites/admin/rotate`, {
    method: 'POST',
    identity,
    docUid: uid,
  });
}

// --- keyrings --------------------------------------------------------

const KEYRING_HEADER = 'x-marginalia-keyring';

export interface KeyringWire {
  client_id: string;
  display_name: string;
  updated_at?: number;
  /** How long an unused ring lasts before the server sweeps it. */
  idle_ttl_ms?: number;
  docs: KeyringDocEntry[];
}

/** One document as the keyring API reports it. */
export interface KeyringDocEntry {
  doc_uid: string;
  invite_token: string;
  title: string | null;
  /** null when the invite behind this entry was revoked or rotated away. */
  role: Role | null;
  format: DocumentFormat;
  password_protected: boolean;
  updated_at: number;
  added_at: number;
  cover: DocumentCover | null;
}

export interface KeyringSeed {
  doc_uid: string;
  invite_token: string;
  title?: string;
}

/** Mint a keyring, seeded with the credentials this browser already holds. */
export function createKeyring(
  seeds: KeyringSeed[],
  identity: Identity,
): Promise<KeyringWire & { token: string }> {
  return request('/api/keyrings', {
    method: 'POST',
    body: JSON.stringify({ docs: seeds }),
    identity,
  });
}

export function fetchKeyring(token: string): Promise<KeyringWire> {
  return request('/api/keyrings/self', {
    method: 'GET',
    headers: { [KEYRING_HEADER]: token },
  });
}

export function renameKeyring(
  token: string,
  displayName: string,
): Promise<{ display_name: string }> {
  return request('/api/keyrings/self', {
    method: 'PATCH',
    headers: { [KEYRING_HEADER]: token },
    body: JSON.stringify({ display_name: displayName }),
  });
}

/** Destroy the ring server-side, with its copies of the invite tokens. */
export function deleteKeyring(token: string): Promise<void> {
  return request<void>('/api/keyrings/self', {
    method: 'DELETE',
    headers: { [KEYRING_HEADER]: token },
  });
}

export function rotateKeyring(
  token: string,
): Promise<{ token: string; client_id: string; display_name: string }> {
  return request('/api/keyrings/self/rotate', {
    method: 'POST',
    headers: { [KEYRING_HEADER]: token },
  });
}

export function putKeyringDoc(
  token: string,
  uid: string,
  payload: { invite_token: string; title?: string },
): Promise<{ ok: true }> {
  return request(`/api/keyrings/self/docs/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    headers: { [KEYRING_HEADER]: token },
    body: JSON.stringify(payload),
  });
}

export function deleteKeyringDoc(token: string, uid: string): Promise<void> {
  return request<void>(`/api/keyrings/self/docs/${encodeURIComponent(uid)}`, {
    method: 'DELETE',
    headers: { [KEYRING_HEADER]: token },
  });
}

export function createKeyringPairing(token: string): Promise<{ code: string; expires_at: number }> {
  return request('/api/keyrings/self/pairings', {
    method: 'POST',
    headers: { [KEYRING_HEADER]: token },
  });
}

/** Exchange a pairing code for the keyring it names. No credential needed. */
export function redeemKeyringPairing(code: string): Promise<KeyringWire & { token: string }> {
  return request('/api/pairings/redeem', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

// --- comments --------------------------------------------------------

export interface CommentAnchor {
  block_id: string;
  /**
   * Last block of a multi-block span; null when the anchor covers a single
   * block. `quote` then holds one `SPAN_SEPARATOR`-joined fragment per
   * covered block, and `start_offset`/`end_offset` are offsets into
   * `block_id` and `end_block_id` respectively.
   */
  end_block_id?: string | null;
  quote: string;
  prefix: string;
  suffix: string;
  start_offset: number;
  end_offset: number;
  /** Enclosing heading hierarchy at comment time (normalized heading texts). */
  heading_path?: string[] | null;
  /** Position within the innermost section at comment time. */
  section_index?: number | null;
  /**
   * Section index at each enclosing heading level, root → innermost.
   * Length = heading_path.length + 1. Used as a graceful fallback when the
   * innermost heading is later renamed/removed.
   */
  section_index_path?: number[] | null;
}

export type CommentLinkStatus = 'linked' | 'low-confidence' | 'conflict' | 'orphaned';

export type ThreadState = 'open' | 'resolved';
export type ThreadResolutionKind = 'resolve' | 'accept' | 'reject';
export type ThreadLinkStatus = CommentLinkStatus;

export interface ThreadResolution {
  kind: ThreadResolutionKind;
  at: number;
  by_name: string | null;
}

export interface ThreadCapabilities {
  reply: boolean;
  resolve: boolean;
  accept: boolean;
  reject: boolean;
  /** Whether the viewer may replace this proposal's proposed text in place. */
  update: boolean;
  repair: boolean;
  reopen: boolean;
}

export interface ThreadNodeCapabilities {
  edit: boolean;
  delete: boolean;
  /** Whether the viewer is allowed to add or toggle emoji reactions. */
  react: boolean;
}

export interface CommentReaction {
  emoji: string;
  count: number;
  /** True when the requesting viewer has this reaction on this comment. */
  reacted: boolean;
  /** Display names of authors who reacted, ordered oldest-first. */
  authors: string[];
}

export interface ThreadAnchor {
  block_id: string | null;
  /** Multi-block proposal: ID of the last block in the span. NULL/absent for single-block. */
  end_block_id?: string | null;
  quote: string | null;
  prefix: string;
  suffix: string;
  start_offset: number | null;
  end_offset: number | null;
  heading_path: string[] | null;
  section_index: number | null;
  section_index_path: number[] | null;
}

export interface Comment {
  id: string;
  body: string;
  author: { client_id: string; display_name: string };
  capabilities: ThreadNodeCapabilities;
  reactions: CommentReaction[];
  created_at: number;
  updated_at: number;
}

export interface ThreadProposalData {
  whole_document: boolean;
  /**
   * Root comment thread this proposal was written to answer, or null if
   * it stands on its own. The reverse direction is
   * `Thread.answered_by_thread_ids`.
   */
  answers_thread_id: string | null;
  /**
   * The proposal's current replacement text, recovered from the branch
   * tip. Null when the branch is unreadable (deleted repo, legacy row) —
   * in-place editing is impossible then.
   */
  proposed_text: string | null;
  /** The base source range the proposal replaces, as of its base commit. */
  source_snapshot: string | null;
}

export interface Thread {
  id: string;
  state: ThreadState;
  resolution: ThreadResolution | null;
  link_status: ThreadLinkStatus;
  anchor: ThreadAnchor;
  capabilities: ThreadCapabilities;
  /** Ordered oldest-first. comments[0] is the opener; remaining are replies. */
  comments: [Comment, ...Comment[]];
  /**
   * Edit proposals written to answer this thread, oldest first. Always
   * empty for a proposal thread — a proposal is not itself a request.
   */
  answered_by_thread_ids: string[];
  proposal: ThreadProposalData | null;
}

export interface ListThreadsResponse {
  threads: Thread[];
  mention_candidates: string[];
  pending_mentions: string[];
}

// --- Thread view helpers ---------------------------------------------------

export function isProposal(t: Thread): t is Thread & { proposal: ThreadProposalData } {
  return t.proposal !== null;
}

export function isComment(t: Thread): boolean {
  return t.proposal === null;
}

export type ProposalStatus = 'open' | 'accepted' | 'rejected';

export function proposalStatus(t: Thread): ProposalStatus {
  if (t.state === 'open') return 'open';
  if (t.resolution?.kind === 'accept') return 'accepted';
  if (t.resolution?.kind === 'reject') return 'rejected';
  return 'open';
}

export function isOrphan(t: Thread): boolean {
  return t.link_status === 'orphaned';
}

export function isResolved(t: Thread): boolean {
  return t.state === 'resolved';
}

export function threadAuthor(t: Thread): { client_id: string; display_name: string } {
  return t.comments[0].author;
}

export function threadCreatedAt(t: Thread): number {
  return t.comments[0].created_at;
}

const listThreadsInflight = new Map<string, Promise<ListThreadsResponse>>();

/**
 * Ceiling on a single thread read.
 *
 * Deduping in-flight reads means a request that never settles is worse
 * than one that fails: its key is never released, so every later caller
 * is handed the same hung promise and the document keeps its empty
 * comment column for as long as the page is open. A half-open socket
 * (network changed under us, a proxy that stopped answering) does
 * exactly that. Bound it so the failure is a rejection the retry ladder
 * and the reconnect path can both act on.
 *
 * Generous on purpose — this covers the body too, and the payload grows
 * with the comment count.
 */
const LIST_THREADS_TIMEOUT_MS = 30_000;

// LRU cache of the last-fetched thread list per document uid.
// Capped at MAX_SNAPSHOT_DOCS entries; evicts the least-recently-used document
// when the cap is exceeded. Map insertion order is used as the LRU key, so
// every write deletes-then-reinserts to move the entry to the back.
const MAX_SNAPSHOT_DOCS = 10;
const threadSnapshots = new Map<string, Thread[]>();

function snapshotGet(uid: string): Thread[] | undefined {
  const threads = threadSnapshots.get(uid);
  if (threads !== undefined) {
    threadSnapshots.delete(uid);
    threadSnapshots.set(uid, threads);
  }
  return threads;
}

function snapshotSet(uid: string, threads: Thread[]): void {
  threadSnapshots.delete(uid);
  threadSnapshots.set(uid, threads);
  if (threadSnapshots.size > MAX_SNAPSHOT_DOCS) {
    const oldest = threadSnapshots.keys().next().value;
    if (oldest !== undefined) threadSnapshots.delete(oldest);
  }
}

export function listThreads(
  uid: string,
  opts: { consumeMentions?: boolean } = {},
): Promise<ListThreadsResponse> {
  const consumeMentions = opts.consumeMentions !== false;
  const cacheKey = `${uid}:${consumeMentions ? 'consume' : 'peek'}`;
  const existing = listThreadsInflight.get(cacheKey);
  if (existing) return existing;

  const suffix = consumeMentions ? '' : '?consume_mentions=false';
  const promise = request<ListThreadsResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads${suffix}`,
    {
      method: 'GET',
      docUid: uid,
      timeoutMs: LIST_THREADS_TIMEOUT_MS,
    },
  )
    .then((res) => {
      snapshotSet(uid, res.threads);
      return res;
    })
    .finally(() => {
      // Only clear our own entry: a later call may already have claimed
      // the key, and dropping that one would let a third caller start a
      // duplicate read alongside it.
      if (listThreadsInflight.get(cacheKey) === promise) {
        listThreadsInflight.delete(cacheKey);
      }
    });

  listThreadsInflight.set(cacheKey, promise);
  return promise;
}

interface ThreadMutationResponse {
  thread: Thread;
  created_reply_id?: string | null;
}

interface CommentLocation {
  thread: Thread;
}

function rememberThread(uid: string, thread: Thread): void {
  const current = snapshotGet(uid) ?? [];
  const index = current.findIndex((entry) => entry.id === thread.id);
  const next =
    index >= 0
      ? current.map((entry, idx) => (idx === index ? thread : entry))
      : [...current, thread];
  next.sort((a, b) => a.comments[0].created_at - b.comments[0].created_at);
  snapshotSet(uid, next);
}

function forgetComment(uid: string, commentId: string): void {
  const current = snapshotGet(uid);
  if (!current) return;

  const next = current
    .filter((thread) => thread.id !== commentId)
    .map((thread) => {
      if (!thread.comments.some((c) => c.id === commentId)) return thread;
      const [head, ...tail] = thread.comments;
      return {
        ...thread,
        comments: [head, ...tail.filter((c) => c.id !== commentId)] as [Comment, ...Comment[]],
      };
    });
  snapshotSet(uid, next);
}

function findCommentLocationInThreads(
  threads: Thread[],
  commentId: string,
): CommentLocation | null {
  for (const thread of threads) {
    if (thread.comments.some((c) => c.id === commentId)) return { thread };
  }
  return null;
}

async function findCommentLocation(uid: string, commentId: string): Promise<CommentLocation> {
  const cached = snapshotGet(uid);
  const inCache = cached ? findCommentLocationInThreads(cached, commentId) : null;
  if (inCache) return inCache;

  const fresh = await listThreads(uid, { consumeMentions: false });
  const location = findCommentLocationInThreads(fresh.threads, commentId);
  if (location) return location;
  throw new ApiError(404, 'not-found');
}

export function createComment(
  uid: string,
  payload: {
    anchor?: CommentAnchor;
    parent_id?: string;
    body: string;
  },
  identity: Identity,
): Promise<void> {
  if (payload.parent_id) {
    return request<ThreadMutationResponse>(
      `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(payload.parent_id)}/respond`,
      {
        method: 'POST',
        body: JSON.stringify({ body: payload.body }),
        identity,
        docUid: uid,
      },
    ).then((res) => {
      rememberThread(uid, res.thread);
    });
  }

  return request<ThreadMutationResponse>(`/api/documents/${encodeURIComponent(uid)}/threads`, {
    method: 'POST',
    body: JSON.stringify({
      anchor: payload.anchor,
      body: payload.body,
    }),
    identity,
    docUid: uid,
  }).then((res) => {
    rememberThread(uid, res.thread);
  });
}

export async function updateComment(
  uid: string,
  cid: string,
  body: string,
  identity: Identity,
): Promise<void> {
  const location = await findCommentLocation(uid, cid);
  const tid = location.thread.id;
  const isOpener = location.thread.comments[0].id === cid;
  const path = isOpener
    ? `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(tid)}`
    : `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(tid)}/comments/${encodeURIComponent(cid)}`;
  const res = await request<ThreadMutationResponse>(path, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
    identity,
    docUid: uid,
  });
  rememberThread(uid, res.thread);
}

/**
 * Returns the updated `Thread` so callers can splice it into local
 * state without a follow-up `listThreads()`. Pre-update local cache is
 * still patched via `rememberThread` for any other consumer that reads
 * straight from the snapshot.
 */
export async function toggleCommentReaction(
  uid: string,
  cid: string,
  emoji: string,
  identity: Identity,
): Promise<Thread> {
  const location = await findCommentLocation(uid, cid);
  const tid = location.thread.id;
  const path = `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(tid)}/comments/${encodeURIComponent(cid)}/reactions`;
  const res = await request<ThreadMutationResponse>(path, {
    method: 'POST',
    body: JSON.stringify({ emoji }),
    identity,
    docUid: uid,
  });
  rememberThread(uid, res.thread);
  return res.thread;
}

export async function deleteComment(uid: string, cid: string, identity: Identity): Promise<void> {
  const location = await findCommentLocation(uid, cid);
  const tid = location.thread.id;
  const isOpener = location.thread.comments[0].id === cid;
  const path = isOpener
    ? `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(tid)}`
    : `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(tid)}/comments/${encodeURIComponent(cid)}`;
  await request<void>(path, {
    method: 'DELETE',
    identity,
    docUid: uid,
  });
  forgetComment(uid, cid);
}

// --- edit proposals --------------------------------------------------

export function createEditProposal(
  uid: string,
  payload: {
    anchor_block_id: string;
    anchor_end_block_id?: string | null;
    anchor_quote: string;
    proposed_text: string;
    rationale?: string | null;
  },
  identity: Identity,
): Promise<void> {
  return request<ThreadMutationResponse>(`/api/documents/${encodeURIComponent(uid)}/threads`, {
    method: 'POST',
    body: JSON.stringify({
      anchor: {
        block_id: payload.anchor_block_id,
        end_block_id: payload.anchor_end_block_id ?? null,
        quote: payload.anchor_quote,
      },
      body: payload.rationale,
      proposal: { proposed_text: payload.proposed_text },
    }),
    identity,
    docUid: uid,
  }).then((res) => {
    rememberThread(uid, res.thread);
  });
}

/**
 * Create a whole-document proposal — replaces the entire source on accept.
 * Anchored at the first block of the current document so the thread renders
 * at the very top of the inline-comment column. The "Proposed document
 * change" badge is driven by `whole_document = true` on the proposal row.
 */
export function createDocumentProposal(
  uid: string,
  payload: {
    proposed_text: string;
    rationale?: string | null;
    anchor_block_id: string;
    anchor_quote: string;
  },
  identity: Identity,
): Promise<void> {
  return request<ThreadMutationResponse>(`/api/documents/${encodeURIComponent(uid)}/threads`, {
    method: 'POST',
    body: JSON.stringify({
      anchor: {
        block_id: payload.anchor_block_id,
        end_block_id: null,
        quote: payload.anchor_quote,
      },
      body: payload.rationale,
      proposal: { proposed_text: payload.proposed_text, whole_document: true },
    }),
    identity,
    docUid: uid,
  }).then((res) => {
    rememberThread(uid, res.thread);
  });
}

/**
 * Replace an open proposal's proposed text in place. Authors and document
 * admins may do this; gate on `thread.capabilities.update`. The branch is
 * rebuilt against current main, so this also clears a stale/conflicted
 * proposal. An optional `comment` is posted as a reply in the same request,
 * leaving a revision note in the discussion.
 */
export function updateEditProposal(
  uid: string,
  pid: string,
  payload: { proposed_text: string; comment?: string },
  identity: Identity,
): Promise<Thread> {
  const comment = payload.comment?.trim();
  return request<ThreadMutationResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(pid)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        proposal: { proposed_text: payload.proposed_text },
        ...(comment ? { comment } : {}),
      }),
      identity,
      docUid: uid,
    },
  ).then((res) => {
    rememberThread(uid, res.thread);
    return res.thread;
  });
}

export function deleteEditProposal(uid: string, pid: string, identity: Identity): Promise<void> {
  return request<void>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(pid)}`,
    { method: 'DELETE', identity, docUid: uid },
  ).then(() => {
    forgetComment(uid, pid);
  });
}

export function deleteThread(uid: string, threadId: string, identity: Identity): Promise<void> {
  return request<void>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(threadId)}`,
    { method: 'DELETE', identity, docUid: uid },
  ).then(() => {
    forgetComment(uid, threadId);
  });
}

export function acceptEditProposal(
  uid: string,
  pid: string,
  identity: Identity,
  body?: string,
): Promise<void> {
  const replyBody = body?.trim();
  return request<ThreadMutationResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(pid)}/respond`,
    {
      method: 'POST',
      body: JSON.stringify({
        action: 'accept',
        ...(replyBody ? { body: replyBody } : {}),
      }),
      identity,
      docUid: uid,
    },
  ).then((res) => {
    rememberThread(uid, res.thread);
  });
}

export function rejectEditProposal(
  uid: string,
  pid: string,
  identity: Identity,
  body?: string,
): Promise<void> {
  const replyBody = body?.trim();
  return request<ThreadMutationResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(pid)}/respond`,
    {
      method: 'POST',
      body: JSON.stringify({
        action: 'reject',
        ...(replyBody ? { body: replyBody } : {}),
      }),
      identity,
      docUid: uid,
    },
  ).then((res) => {
    rememberThread(uid, res.thread);
  });
}

/**
 * Pass `{ mergeable: true }` to opt the diff response into a `mergeable`
 * status (`'clean' | 'conflict' | 'stale'`). The server only honours the
 * opt-in for callers with propose permission; read-only viewers still
 * get `null`. Editors get a non-null status without the opt-in for
 * open, acceptable proposals; accepted/rejected and orphaned/unanchored
 * proposals always return `null` regardless of caller role.
 */
export function getEditProposalDiff(
  uid: string,
  pid: string,
  opts: { mergeable?: boolean } = {},
): Promise<ProposalDiff> {
  const path = `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(pid)}/diff`;
  const url = opts.mergeable ? `${path}?mergeable=1` : path;
  return request<ProposalDiff>(url, { method: 'GET', docUid: uid });
}

export function repairEditProposalAnchor(
  uid: string,
  pid: string,
  identity: Identity,
): Promise<Thread> {
  return request<ThreadMutationResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(pid)}/repair`,
    {
      method: 'POST',
      identity,
      docUid: uid,
    },
  ).then((res) => {
    rememberThread(uid, res.thread);
    return res.thread;
  });
}

export async function resolveThread(
  uid: string,
  threadId: string,
  resolved: boolean,
  identity: Identity,
  body?: string,
): Promise<void> {
  const replyBody = body?.trim();
  const res = await request<ThreadMutationResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(threadId)}/respond`,
    {
      method: 'POST',
      body: JSON.stringify({
        action: resolved ? 'resolve' : 'reopen',
        ...(replyBody ? { body: replyBody } : {}),
      }),
      identity,
      docUid: uid,
    },
  );
  rememberThread(uid, res.thread);
}
