/**
 * Tracks every document the current user has opened, in localStorage.
 *
 * Used by the landing page (to render "Recent documents"), and by the
 * ViewPage on mount to record the last-seen time — this lets us surface
 * "new since X" indicators later.
 */

const KEY = 'marginalia.recentDocs';
const MAX = 50;

export interface RecentDoc {
  uid: string;
  title: string;
  role: 'admin' | 'editor' | 'collaborator' | 'reader';
  password_protected: boolean;
  /** When we last opened it. */
  visited_at: number;
  /** When the doc was last updated on the server (as reported by GET). */
  updated_at: number;
  /** Invite token used to open this doc (undefined for public-only access). */
  invite_token?: string;
}

/** Build the URL we should navigate to when re-opening a recent doc. */
export function openUrlFor(doc: RecentDoc): string {
  return doc.invite_token ? `/d/${doc.uid}/${doc.invite_token}` : `/d/${doc.uid}`;
}

export function loadRecentDocs(): RecentDoc[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(coerceRecentDoc);
  } catch {
    return [];
  }
}

export function recordVisit(doc: RecentDoc): void {
  const list = loadRecentDocs().filter((d) => d.uid !== doc.uid);
  list.unshift(doc);
  const trimmed = list.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* quota exceeded — best-effort */
  }
}

export function removeFromRecent(uid: string): void {
  const list = loadRecentDocs().filter((d) => d.uid !== uid);
  localStorage.setItem(KEY, JSON.stringify(list));
}

const VALID_ROLES = new Set<RecentDoc['role']>([
  'admin',
  'editor',
  'collaborator',
  'reader',
]);

/**
 * Validate + migrate a stored entry. Returns a one-element array on
 * success, empty on garbage. Migrates legacy `commentor` rows to
 * `collaborator` (the role was retired) and coerces a missing/unknown
 * `role` or `password_protected` to safe defaults rather than letting
 * stale shapes leak into the UI typed as `RecentDoc`.
 */
function coerceRecentDoc(v: unknown): RecentDoc[] {
  if (!v || typeof v !== 'object') return [];
  const r = v as Record<string, unknown>;
  if (
    typeof r.uid !== 'string' ||
    typeof r.title !== 'string' ||
    typeof r.visited_at !== 'number' ||
    typeof r.updated_at !== 'number'
  ) {
    return [];
  }
  const rawRole = typeof r.role === 'string' ? r.role : 'reader';
  const role: RecentDoc['role'] = rawRole === 'commentor'
    ? 'collaborator'
    : VALID_ROLES.has(rawRole as RecentDoc['role'])
      ? (rawRole as RecentDoc['role'])
      : 'reader';
  const out: RecentDoc = {
    uid: r.uid,
    title: r.title,
    role,
    password_protected: r.password_protected === true,
    visited_at: r.visited_at,
    updated_at: r.updated_at,
    ...(typeof r.invite_token === 'string' ? { invite_token: r.invite_token } : {}),
  };
  return [out];
}
