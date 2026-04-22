import { type Identity, getClientId, getDisplayName } from './identity.js';
import { loadInviteToken } from './invite.js';

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
}

export type DocumentFormat = 'markdown' | 'asciidoc';

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

export interface Document {
  uid: string;
  /** Human-friendly document name. Null → derive from rendered content. */
  name: string | null;
  source: string;
  rendered: RenderedDocument;
  /** Every asset currently attached to this doc (empty array if none). */
  attached_assets: AttachedAsset[];
  format: DocumentFormat;
  default_theme: string;
  password_protected: boolean;
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
  } | null;
}

export interface HistoryDiff {
  before: string;
  after: string;
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
  default_theme?: string;
}

export interface UploadResponse {
  uid: string;
  name: string | null;
  admin_invite: { token: string; url: string; display_name: string };
  default_theme: string;
  format: DocumentFormat;
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

async function request<T>(
  path: string,
  init: RequestInit & { identity?: Identity | null; docUid?: string; _retry?: boolean } = {},
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

  const res = await fetch(path, { ...init, headers, credentials: 'include' });
  if (!res.ok) {
    let code = 'unknown';
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

  const res = await fetch(path, { ...init, headers, credentials: 'include' });
  if (!res.ok) {
    let code = 'unknown';
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
export async function downloadDocumentDocx(
  uid: string,
  theme?: string,
): Promise<{ blob: Blob; filename: string }> {
  const params = theme ? `?theme=${encodeURIComponent(theme)}` : '';
  const res = await requestBinary(
    `/api/documents/${encodeURIComponent(uid)}/export.docx${params}`,
    { method: 'GET', docUid: uid },
  );
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') ?? '';
  const match = cd.match(/filename="([^"]+)"/);
  const filename = match?.[1] ?? `${uid}.docx`;
  return { blob, filename };
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
): Promise<{ oid: string }> {
  return request<{ oid: string }>(`/api/documents/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    body: JSON.stringify({ source }),
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
): Promise<UploadResponse & { imported_comments: number }> {
  return request<UploadResponse & { imported_comments: number }>('/api/documents/import', {
    method: 'POST',
    body: JSON.stringify(bundle),
    identity,
  });
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
  password?: null | 'rotate';
}
export interface DocumentSettingsResponse {
  name: string | null;
  default_theme: string;
  password_protected: boolean;
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

// --- comments --------------------------------------------------------

export interface CommentAnchor {
  block_id: string;
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

export type CommentLinkStatus = 'linked' | 'low-confidence' | 'orphaned';

export interface Comment {
  id: string;
  parent_id: string | null;
  parent_proposal_id: string | null;
  anchor: CommentAnchor | null;
  author: { client_id: string; display_name: string };
  body: string;
  link_status: CommentLinkStatus | null;
  resolved_at: number | null;
  resolved_by_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface ListCommentsResponse {
  comments: Comment[];
  mention_candidates: string[];
  pending_mentions: string[];
}

type ThreadState = 'open' | 'resolved';
type ThreadResolutionKind = 'resolve' | 'accept' | 'reject';

interface ThreadResolution {
  kind: ThreadResolutionKind;
  at: number;
  by_name: string | null;
}

interface ThreadCapabilities {
  reply: boolean;
  resolve: boolean;
  accept: boolean;
  reject: boolean;
  reopen: boolean;
}

interface ThreadNodeCapabilities {
  edit: boolean;
  delete: boolean;
}

interface ThreadAnchor {
  block_id: string | null;
  quote: string | null;
  prefix: string;
  suffix: string;
  start_offset: number | null;
  end_offset: number | null;
  heading_path: string[] | null;
  section_index: number | null;
  section_index_path: number[] | null;
}

interface ThreadCommentNode {
  id: string;
  body: string;
  author: { client_id: string; display_name: string };
  capabilities: ThreadNodeCapabilities;
  created_at: number;
  updated_at: number;
}

interface ThreadProposalData {
  anchor_kind: string | null;
  source_snapshot: string | null;
  proposed_text: string;
}

interface Thread {
  id: string;
  state: ThreadState;
  resolution: ThreadResolution | null;
  link_status: CommentLinkStatus;
  anchor: ThreadAnchor;
  capabilities: ThreadCapabilities;
  root: ThreadCommentNode;
  proposal: ThreadProposalData | null;
  replies: ThreadCommentNode[];
}

interface ListThreadsResponse {
  threads: Thread[];
  mention_candidates: string[];
  pending_mentions: string[];
}

const listThreadsInflight = new Map<string, Promise<ListThreadsResponse>>();
const threadSnapshots = new Map<string, Thread[]>();

function listThreads(uid: string): Promise<ListThreadsResponse> {
  const existing = listThreadsInflight.get(uid);
  if (existing) return existing;

  const promise = request<ListThreadsResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads`,
    {
      method: 'GET',
      docUid: uid,
    },
  )
    .then((res) => {
      threadSnapshots.set(uid, res.threads);
      return res;
    })
    .finally(() => {
      listThreadsInflight.delete(uid);
    });

  listThreadsInflight.set(uid, promise);
  return promise;
}

export function listComments(uid: string): Promise<ListCommentsResponse> {
  return listThreads(uid).then((res) => ({
    comments: threadsToLegacyComments(res.threads),
    mention_candidates: res.mention_candidates,
    pending_mentions: res.pending_mentions,
  }));
}

function threadsToLegacyComments(threads: Thread[]): Comment[] {
  const comments: Comment[] = [];

  for (const thread of threads) {
    if (!thread.proposal) {
      comments.push(threadRootToLegacyComment(thread));
      for (const reply of thread.replies) {
        comments.push(threadReplyToLegacyComment(reply, thread.id, null));
      }
      continue;
    }

    for (const reply of thread.replies) {
      comments.push(threadReplyToLegacyComment(reply, null, thread.id));
    }
  }

  comments.sort((a, b) => a.created_at - b.created_at);
  return comments;
}

function threadsToLegacyProposals(threads: Thread[]): EditProposal[] {
  return threads
    .filter((thread): thread is Thread & { proposal: ThreadProposalData } => thread.proposal !== null)
    .map((thread) => ({
      id: thread.id,
      comment: threadRootToLegacyComment(thread),
      anchor_kind: thread.proposal.anchor_kind,
      source_snapshot: thread.proposal.source_snapshot,
      proposed_text: thread.proposal.proposed_text,
      status: threadToLegacyProposalStatus(thread),
      decided_at: thread.resolution?.kind === 'accept' || thread.resolution?.kind === 'reject'
        ? thread.resolution.at
        : null,
      decided_by_name:
        thread.resolution?.kind === 'accept' || thread.resolution?.kind === 'reject'
          ? thread.resolution.by_name
          : null,
    }))
    .sort((a, b) => a.comment.created_at - b.comment.created_at);
}

function threadToLegacyProposalStatus(thread: Thread): EditProposalStatus {
  if (thread.state === 'open') return 'open';
  if (thread.resolution?.kind === 'accept') return 'accepted';
  if (thread.resolution?.kind === 'reject') return 'rejected';
  return 'open';
}

function threadRootToLegacyComment(thread: Thread): Comment {
  const resolved =
    thread.state === 'resolved' && thread.resolution
      ? {
          resolved_at: thread.resolution.at,
          resolved_by_name: thread.resolution.by_name,
        }
      : {
          resolved_at: null,
          resolved_by_name: null,
        };

  return {
    id: thread.id,
    parent_id: null,
    parent_proposal_id: null,
    anchor: threadAnchorToLegacyAnchor(thread.anchor),
    author: thread.root.author,
    body: thread.root.body,
    link_status: thread.link_status,
    resolved_at: resolved.resolved_at,
    resolved_by_name: resolved.resolved_by_name,
    created_at: thread.root.created_at,
    updated_at: thread.root.updated_at,
  };
}

function threadReplyToLegacyComment(
  reply: ThreadCommentNode,
  parentId: string | null,
  parentProposalId: string | null,
): Comment {
  return {
    id: reply.id,
    parent_id: parentId,
    parent_proposal_id: parentProposalId,
    anchor: null,
    author: reply.author,
    body: reply.body,
    link_status: null,
    resolved_at: null,
    resolved_by_name: null,
    created_at: reply.created_at,
    updated_at: reply.updated_at,
  };
}

function threadAnchorToLegacyAnchor(anchor: ThreadAnchor): CommentAnchor {
  return {
    block_id: anchor.block_id,
    quote: anchor.quote,
    prefix: anchor.prefix,
    suffix: anchor.suffix,
    start_offset: anchor.start_offset,
    end_offset: anchor.end_offset,
    heading_path: anchor.heading_path,
    section_index: anchor.section_index,
    section_index_path: anchor.section_index_path,
  } as CommentAnchor;
}

function threadToLegacyProposal(thread: Thread): EditProposal {
  if (!thread.proposal) {
    throw new Error(`Thread ${thread.id} does not carry proposal data`);
  }
  return threadsToLegacyProposals([thread])[0]!;
}

interface ThreadMutationResponse {
  thread: Thread;
  created_reply_id?: string | null;
}

interface CommentLocation {
  thread: Thread;
  kind: 'root' | 'reply';
}

function rememberThread(uid: string, thread: Thread): void {
  const current = threadSnapshots.get(uid) ?? [];
  const index = current.findIndex((entry) => entry.id === thread.id);
  const next =
    index >= 0
      ? current.map((entry, idx) => (idx === index ? thread : entry))
      : [...current, thread];
  next.sort((a, b) => a.root.created_at - b.root.created_at);
  threadSnapshots.set(uid, next);
}

function forgetComment(uid: string, commentId: string): void {
  const current = threadSnapshots.get(uid);
  if (!current) return;

  const next = current
    .filter((thread) => thread.id !== commentId)
    .map((thread) =>
      thread.replies.some((reply) => reply.id === commentId)
        ? { ...thread, replies: thread.replies.filter((reply) => reply.id !== commentId) }
        : thread,
    );
  threadSnapshots.set(uid, next);
}

function findCommentLocationInThreads(threads: Thread[], commentId: string): CommentLocation | null {
  for (const thread of threads) {
    if (thread.id === commentId) return { thread, kind: 'root' };
    if (thread.replies.some((reply) => reply.id === commentId)) {
      return { thread, kind: 'reply' };
    }
  }
  return null;
}

async function findCommentLocation(uid: string, commentId: string): Promise<CommentLocation> {
  const cached = threadSnapshots.get(uid);
  const inCache = cached ? findCommentLocationInThreads(cached, commentId) : null;
  if (inCache) return inCache;

  const fresh = await listThreads(uid);
  const location = findCommentLocationInThreads(fresh.threads, commentId);
  if (location) return location;
  throw new ApiError(404, 'not-found');
}

function threadToLegacyCommentById(thread: Thread, commentId: string): Comment {
  if (thread.id === commentId) return threadRootToLegacyComment(thread);

  const reply = thread.replies.find((entry) => entry.id === commentId);
  if (!reply) throw new Error(`Thread ${thread.id} does not contain comment ${commentId}`);

  return threadReplyToLegacyComment(
    reply,
    thread.proposal ? null : thread.id,
    thread.proposal ? thread.id : null,
  );
}

export function listEditProposals(uid: string): Promise<{ edit_proposals: EditProposal[] }> {
  return listThreads(uid).then((res) => ({
    edit_proposals: threadsToLegacyProposals(res.threads),
  }));
}

export function createComment(
  uid: string,
  payload: {
    anchor?: CommentAnchor;
    parent_id?: string;
    parent_proposal_id?: string;
    body: string;
  },
  identity: Identity,
): Promise<{ comment: Comment }> {
  if (payload.parent_id && payload.parent_proposal_id) {
    throw new ApiError(400, 'parent-conflict');
  }

  const parentId = payload.parent_id ?? payload.parent_proposal_id;
  if (parentId) {
    return request<ThreadMutationResponse>(
      `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(parentId)}/respond`,
      {
        method: 'POST',
        body: JSON.stringify({ body: payload.body }),
        identity,
        docUid: uid,
      },
    ).then((res) => {
      rememberThread(uid, res.thread);
      const createdId = res.created_reply_id;
      if (!createdId) throw new Error(`Missing created_reply_id for thread ${res.thread.id}`);
      return { comment: threadToLegacyCommentById(res.thread, createdId) };
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
    return { comment: threadRootToLegacyComment(res.thread) };
  });
}

export async function updateComment(
  uid: string,
  cid: string,
  body: string,
  identity: Identity,
): Promise<{ comment: Comment }> {
  const location = await findCommentLocation(uid, cid);
  const path =
    location.kind === 'root'
      ? `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(location.thread.id)}`
      : `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(location.thread.id)}/comments/${encodeURIComponent(cid)}`;
  const res = await request<ThreadMutationResponse>(path, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
    identity,
    docUid: uid,
  });
  rememberThread(uid, res.thread);
  return { comment: threadToLegacyCommentById(res.thread, cid) };
}

export async function deleteComment(uid: string, cid: string, identity: Identity): Promise<void> {
  const location = await findCommentLocation(uid, cid);
  const path =
    location.kind === 'root'
      ? `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(location.thread.id)}`
      : `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(location.thread.id)}/comments/${encodeURIComponent(cid)}`;
  await request<void>(path, {
    method: 'DELETE',
    identity,
    docUid: uid,
  });
  forgetComment(uid, cid);
}

// --- edit proposals --------------------------------------------------

export type EditProposalStatus = 'open' | 'accepted' | 'rejected';

export interface EditProposal {
  id: string;
  comment: Comment;
  anchor_kind: string | null;
  source_snapshot: string | null;
  proposed_text: string;
  status: EditProposalStatus;
  decided_at: number | null;
  decided_by_name: string | null;
}
export function createEditProposal(
  uid: string,
  payload: {
    anchor_block_id: string;
    anchor_quote: string;
    anchor_kind?: string | null;
    proposed_text: string;
    rationale?: string | null;
  },
  identity: Identity,
): Promise<{ edit_proposal: EditProposal }> {
  return request<ThreadMutationResponse>(`/api/documents/${encodeURIComponent(uid)}/threads`, {
    method: 'POST',
    body: JSON.stringify({
      anchor: {
        block_id: payload.anchor_block_id,
        quote: payload.anchor_quote,
      },
      body: payload.rationale,
      proposal: {
        anchor_kind: payload.anchor_kind ?? null,
        proposed_text: payload.proposed_text,
      },
    }),
    identity,
    docUid: uid,
  }).then((res) => {
    rememberThread(uid, res.thread);
    return { edit_proposal: threadToLegacyProposal(res.thread) };
  });
}

export function updateEditProposal(
  uid: string,
  pid: string,
  patch: { rationale: string | null },
  identity: Identity,
): Promise<{ edit_proposal: EditProposal }> {
  return request<ThreadMutationResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(pid)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ body: patch.rationale }),
      identity,
      docUid: uid,
    },
  ).then((res) => {
    rememberThread(uid, res.thread);
    return { edit_proposal: threadToLegacyProposal(res.thread) };
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

export function acceptEditProposal(
  uid: string,
  pid: string,
  identity: Identity,
): Promise<{ edit_proposal: EditProposal; oid: string | null }> {
  return request<ThreadMutationResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(pid)}/respond`,
    {
      method: 'POST',
      body: JSON.stringify({ action: 'accept' }),
      identity,
      docUid: uid,
    },
  ).then((res) => {
    rememberThread(uid, res.thread);
    return { edit_proposal: threadToLegacyProposal(res.thread), oid: null };
  });
}

export function rejectEditProposal(
  uid: string,
  pid: string,
  identity: Identity,
): Promise<{ edit_proposal: EditProposal }> {
  return request<ThreadMutationResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(pid)}/respond`,
    {
      method: 'POST',
      body: JSON.stringify({ action: 'reject' }),
      identity,
      docUid: uid,
    },
  ).then((res) => {
    rememberThread(uid, res.thread);
    return { edit_proposal: threadToLegacyProposal(res.thread) };
  });
}

export function getEditProposalDiff(uid: string, pid: string): Promise<HistoryDiff> {
  return request<HistoryDiff>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(pid)}/diff`,
    { method: 'GET', docUid: uid },
  );
}

export async function resolveComment(
  uid: string,
  cid: string,
  resolved: boolean,
  identity: Identity,
): Promise<{ comment: Comment }> {
  const location = await findCommentLocation(uid, cid);
  if (location.kind !== 'root') {
    throw new ApiError(400, 'replies-not-resolvable');
  }

  const res = await request<ThreadMutationResponse>(
    `/api/documents/${encodeURIComponent(uid)}/threads/${encodeURIComponent(location.thread.id)}/respond`,
    {
      method: 'POST',
      body: JSON.stringify({ action: resolved ? 'resolve' : 'reopen' }),
      identity,
      docUid: uid,
    },
  );
  rememberThread(uid, res.thread);
  return { comment: threadRootToLegacyComment(res.thread) };
}
