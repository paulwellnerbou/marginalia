import { getClientId, getDisplayName, type Identity } from './identity.js';

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
}

export interface Document {
  uid: string;
  source: string;
  rendered: RenderedDocument;
  editable_by_anyone: boolean;
  default_theme: string;
  password_protected: boolean;
  role: 'admin' | 'editor' | 'reader';
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
  password_protected?: boolean;
  editable_by_anyone?: boolean;
  default_theme?: string;
}

export interface UploadResponse {
  uid: string;
  admin_recovery_token: string;
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

async function request<T>(
  path: string,
  init: RequestInit & { identity?: Identity | null } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');

  const identity = init.identity;
  if (identity) {
    headers.set('x-markdowner-client', identity.clientId);
    headers.set('x-markdowner-client-name', identity.displayName);
  } else {
    // Some routes (e.g. GET) don't strictly require identity but benefit
    // from admin detection when available.
    const clientId = getClientId();
    const displayName = getDisplayName();
    if (clientId) headers.set('x-markdowner-client', clientId);
    if (displayName) headers.set('x-markdowner-client-name', displayName);
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
  return request<Document>(`/api/documents/${encodeURIComponent(uid)}`, { method: 'GET' });
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
  });
}

export function getHistory(uid: string): Promise<{ history: HistoryEntry[] }> {
  return request<{ history: HistoryEntry[] }>(
    `/api/documents/${encodeURIComponent(uid)}/history`,
    { method: 'GET' },
  );
}

export function authenticate(uid: string, password: string): Promise<void> {
  return request<void>(`/api/documents/${encodeURIComponent(uid)}/auth`, {
    method: 'POST',
    body: JSON.stringify({ password }),
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
}

export type CommentStatus = 'active' | 'low-confidence' | 'orphaned';

export interface Comment {
  id: string;
  parent_id: string | null;
  anchor: CommentAnchor | null;
  author: { client_id: string; display_name: string };
  body: string;
  status: CommentStatus;
  created_at: number;
  updated_at: number;
}

export function listComments(uid: string): Promise<{ comments: Comment[] }> {
  return request<{ comments: Comment[] }>(
    `/api/documents/${encodeURIComponent(uid)}/comments`,
    { method: 'GET' },
  );
}

export function createComment(
  uid: string,
  payload: { anchor?: CommentAnchor; parent_id?: string; body: string },
  identity: Identity,
): Promise<{ comment: Comment }> {
  return request<{ comment: Comment }>(
    `/api/documents/${encodeURIComponent(uid)}/comments`,
    { method: 'POST', body: JSON.stringify(payload), identity },
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
    { method: 'PUT', body: JSON.stringify({ body }), identity },
  );
}

export function deleteComment(uid: string, cid: string, identity: Identity): Promise<void> {
  return request<void>(
    `/api/documents/${encodeURIComponent(uid)}/comments/${encodeURIComponent(cid)}`,
    { method: 'DELETE', identity },
  );
}
