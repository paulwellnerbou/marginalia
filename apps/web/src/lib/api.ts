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
  status: string;
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
  message: string;
  author: { name: string; email: string };
  timestamp: number;
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
    if (
      res.status === 401 &&
      code === 'password-required' &&
      init.docUid &&
      !init._retry
    ) {
      await waitForAuth(init.docUid);
      return request(path, { ...init, _retry: true });
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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

export function authenticate(uid: string, password: string): Promise<void> {
  return request<void>(`/api/documents/${encodeURIComponent(uid)}/auth`, {
    method: 'POST',
    body: JSON.stringify({ password }),
    docUid: uid,
  });
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
  return request<{ assets: AttachedAsset[] }>(
    `/api/documents/${encodeURIComponent(uid)}/assets`,
    { method: 'GET', docUid: uid },
  );
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
  return request<{ asset: AttachedAsset }>(
    `/api/documents/${encodeURIComponent(uid)}/assets`,
    { method: 'POST', body: form, identity, docUid: uid },
  );
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

export function assetProxyUrl(uid: string, refName: string): string {
  return `/api/documents/${encodeURIComponent(uid)}/assets/${encodeRefPath(refName)}`;
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

export type CommentStatus = 'active' | 'low-confidence' | 'orphaned';

export interface Comment {
  id: string;
  parent_id: string | null;
  parent_proposal_id: string | null;
  anchor: CommentAnchor | null;
  author: { client_id: string; display_name: string };
  body: string;
  status: CommentStatus;
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

export function listComments(uid: string): Promise<ListCommentsResponse> {
  return request<ListCommentsResponse>(`/api/documents/${encodeURIComponent(uid)}/comments`, {
    method: 'GET',
    docUid: uid,
  });
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
  return request<{ comment: Comment }>(`/api/documents/${encodeURIComponent(uid)}/comments`, {
    method: 'POST',
    body: JSON.stringify(payload),
    identity,
    docUid: uid,
  });
}

export function updateComment(
  uid: string,
  cid: string,
  body: string,
  identity: Identity,
): Promise<{ comment: Comment }> {
  return request<{ comment: Comment }>(
    `/api/documents/${encodeURIComponent(uid)}/comments/${encodeURIComponent(cid)}`,
    { method: 'PUT', body: JSON.stringify({ body }), identity, docUid: uid },
  );
}

export function deleteComment(uid: string, cid: string, identity: Identity): Promise<void> {
  return request<void>(
    `/api/documents/${encodeURIComponent(uid)}/comments/${encodeURIComponent(cid)}`,
    { method: 'DELETE', identity, docUid: uid },
  );
}

// --- edit proposals --------------------------------------------------

export type EditProposalStatus = 'pending' | 'accepted' | 'rejected' | 'orphaned';

export interface EditProposalAnchor {
  block_id: string | null;
  quote: string | null;
  kind: string | null;
}

export interface EditProposal {
  id: string;
  anchor: EditProposalAnchor;
  proposed_text: string;
  rationale: string | null;
  author: { client_id: string; display_name: string };
  status: EditProposalStatus;
  decided_at: number | null;
  decided_by_name: string | null;
  created_at: number;
  updated_at: number;
}

export function listEditProposals(
  uid: string,
): Promise<{ edit_proposals: EditProposal[] }> {
  return request<{ edit_proposals: EditProposal[] }>(
    `/api/documents/${encodeURIComponent(uid)}/edit-proposals`,
    { method: 'GET', docUid: uid },
  );
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
  return request<{ edit_proposal: EditProposal }>(
    `/api/documents/${encodeURIComponent(uid)}/edit-proposals`,
    { method: 'POST', body: JSON.stringify(payload), identity, docUid: uid },
  );
}

export function updateEditProposal(
  uid: string,
  pid: string,
  patch: { rationale: string | null },
  identity: Identity,
): Promise<{ edit_proposal: EditProposal }> {
  return request<{ edit_proposal: EditProposal }>(
    `/api/documents/${encodeURIComponent(uid)}/edit-proposals/${encodeURIComponent(pid)}`,
    { method: 'PATCH', body: JSON.stringify(patch), identity, docUid: uid },
  );
}

export function deleteEditProposal(
  uid: string,
  pid: string,
  identity: Identity,
): Promise<void> {
  return request<void>(
    `/api/documents/${encodeURIComponent(uid)}/edit-proposals/${encodeURIComponent(pid)}`,
    { method: 'DELETE', identity, docUid: uid },
  );
}

export function acceptEditProposal(
  uid: string,
  pid: string,
  identity: Identity,
): Promise<{ edit_proposal: EditProposal; oid: string }> {
  return request<{ edit_proposal: EditProposal; oid: string }>(
    `/api/documents/${encodeURIComponent(uid)}/edit-proposals/${encodeURIComponent(pid)}/accept`,
    { method: 'POST', identity, docUid: uid },
  );
}

export function rejectEditProposal(
  uid: string,
  pid: string,
  identity: Identity,
): Promise<{ edit_proposal: EditProposal }> {
  return request<{ edit_proposal: EditProposal }>(
    `/api/documents/${encodeURIComponent(uid)}/edit-proposals/${encodeURIComponent(pid)}/reject`,
    { method: 'POST', identity, docUid: uid },
  );
}

export function resolveComment(
  uid: string,
  cid: string,
  resolved: boolean,
  identity: Identity,
): Promise<{ comment: Comment }> {
  return request<{ comment: Comment }>(
    `/api/documents/${encodeURIComponent(uid)}/comments/${encodeURIComponent(cid)}/resolve`,
    { method: 'POST', body: JSON.stringify({ resolved }), identity, docUid: uid },
  );
}
