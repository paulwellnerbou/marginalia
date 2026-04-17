import { getClientId, getDisplayName, type Identity } from './identity.js';
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

export type Role = 'admin' | 'editor' | 'reader';

export interface Document {
  uid: string;
  /** Human-friendly document name. Null → derive from rendered content. */
  name: string | null;
  source: string;
  rendered: RenderedDocument;
  editable_by_anyone: boolean;
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
  markdown: string;
  /** Optional document name. Omit/empty → server stores null and the UI
   *  falls back to deriving a title from the rendered content. */
  name?: string;
  password_protected?: boolean;
  editable_by_anyone?: boolean;
  default_theme?: string;
}

export interface UploadResponse {
  uid: string;
  name: string | null;
  admin_invite: { token: string; url: string; display_name: string };
  default_theme: string;
  editable_by_anyone: boolean;
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

async function request<T>(
  path: string,
  init: RequestInit & { identity?: Identity | null; docUid?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');

  const identity = init.identity ?? fallbackIdentity();
  if (identity) {
    headers.set('x-marginalia-client', identity.clientId);
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

export function uploadDocument(
  opts: UploadOptions,
  identity: Identity,
): Promise<UploadResponse> {
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

export function updateDocument(
  uid: string,
  markdown: string,
  identity: Identity,
): Promise<{ oid: string }> {
  return request<{ oid: string }>(`/api/documents/${encodeURIComponent(uid)}`, {
    method: 'PUT',
    body: JSON.stringify({ markdown }),
    identity,
    docUid: uid,
  });
}

export function getHistory(uid: string): Promise<{ history: HistoryEntry[] }> {
  return request<{ history: HistoryEntry[] }>(
    `/api/documents/${encodeURIComponent(uid)}/history`,
    { method: 'GET', docUid: uid },
  );
}

export function authenticate(uid: string, password: string): Promise<void> {
  return request<void>(`/api/documents/${encodeURIComponent(uid)}/auth`, {
    method: 'POST',
    body: JSON.stringify({ password }),
    docUid: uid,
  });
}

// --- settings --------------------------------------------------------

export interface DocumentSettingsPatch {
  /** Rename the document. `null` clears it (→ derive from content). */
  name?: string | null;
  editable_by_anyone?: boolean;
  default_theme?: string;
  password?: null | 'rotate';
}
export interface DocumentSettingsResponse {
  name: string | null;
  editable_by_anyone: boolean;
  default_theme: string;
  password_protected: boolean;
  password?: string;
}

export function updateDocumentSettings(
  uid: string,
  patch: DocumentSettingsPatch,
  identity: Identity,
): Promise<DocumentSettingsResponse> {
  return request<DocumentSettingsResponse>(
    `/api/documents/${encodeURIComponent(uid)}/settings`,
    { method: 'PATCH', body: JSON.stringify(patch), identity, docUid: uid },
  );
}

// --- invites --------------------------------------------------------

export interface Invite {
  token: string;
  display_name: string;
  role: Role;
  note: string | null;
  created_at: number;
  created_by_name: string;
  url: string;
}

export function listInvites(uid: string): Promise<{ invites: Invite[] }> {
  return request<{ invites: Invite[] }>(
    `/api/documents/${encodeURIComponent(uid)}/invites`,
    { method: 'GET', docUid: uid },
  );
}

export function createInvite(
  uid: string,
  payload: { display_name: string; role: Role; note?: string | null },
  identity: Identity,
): Promise<{ invite: Invite }> {
  return request<{ invite: Invite }>(
    `/api/documents/${encodeURIComponent(uid)}/invites`,
    { method: 'POST', body: JSON.stringify(payload), identity, docUid: uid },
  );
}

export function deleteInvite(uid: string, token: string, identity: Identity): Promise<void> {
  return request<void>(
    `/api/documents/${encodeURIComponent(uid)}/invites/${encodeURIComponent(token)}`,
    { method: 'DELETE', identity, docUid: uid },
  );
}

// --- comments --------------------------------------------------------

export interface CommentAnchor {
  block_id: string;
  quote: string;
  prefix: string;
  suffix: string;
  start_offset: number;
  end_offset: number;
}

export type CommentStatus = 'active' | 'low-confidence' | 'orphaned';

export interface Comment {
  id: string;
  parent_id: string | null;
  anchor: CommentAnchor | null;
  author: { client_id: string; display_name: string };
  body: string;
  status: CommentStatus;
  resolved_at: number | null;
  resolved_by_name: string | null;
  created_at: number;
  updated_at: number;
}

export function listComments(uid: string): Promise<{ comments: Comment[] }> {
  return request<{ comments: Comment[] }>(
    `/api/documents/${encodeURIComponent(uid)}/comments`,
    { method: 'GET', docUid: uid },
  );
}

export function createComment(
  uid: string,
  payload: { anchor?: CommentAnchor; parent_id?: string; body: string },
  identity: Identity,
): Promise<{ comment: Comment }> {
  return request<{ comment: Comment }>(
    `/api/documents/${encodeURIComponent(uid)}/comments`,
    { method: 'POST', body: JSON.stringify(payload), identity, docUid: uid },
  );
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
