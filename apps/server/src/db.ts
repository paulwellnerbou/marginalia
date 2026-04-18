import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  uid                  TEXT PRIMARY KEY,
  path                 TEXT NOT NULL,
  name                 TEXT,              -- human-friendly doc name; NULL → derive from content
  password_hash        TEXT,
  editable_by_anyone   INTEGER NOT NULL DEFAULT 0,
  default_theme        TEXT NOT NULL DEFAULT 'default',
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token            TEXT PRIMARY KEY,
  doc_uid          TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  role             TEXT NOT NULL,
  note             TEXT,
  created_at       INTEGER NOT NULL,
  created_by_name  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_doc ON invites(doc_uid);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  doc_uid    TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_doc ON sessions(doc_uid);

CREATE TABLE IF NOT EXISTS comments (
  id                    TEXT PRIMARY KEY,
  doc_uid               TEXT NOT NULL,
  parent_id             TEXT,
  anchor_block_id       TEXT,
  anchor_quote          TEXT,
  anchor_prefix         TEXT,
  anchor_suffix         TEXT,
  anchor_start_offset   INTEGER,
  anchor_end_offset     INTEGER,
  anchor_heading_path   TEXT,            -- JSON array of enclosing heading texts
  anchor_section_index  INTEGER,         -- position within the innermost section
  anchor_section_index_path TEXT,        -- JSON int array; per-level section indices
  author_client_id      TEXT NOT NULL,
  author_display_name   TEXT NOT NULL,
  body                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  resolved_at           INTEGER,
  resolved_by_name      TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_comments_doc ON comments(doc_uid);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

CREATE TABLE IF NOT EXISTS comment_mentions (
  doc_uid               TEXT NOT NULL,
  comment_id            TEXT NOT NULL,
  target_display_name   TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  delivered_at          INTEGER,
  UNIQUE(comment_id, target_display_name)
);

CREATE INDEX IF NOT EXISTS idx_comment_mentions_pending
  ON comment_mentions(doc_uid, target_display_name, delivered_at);

CREATE TABLE IF NOT EXISTS edit_proposals (
  id                    TEXT PRIMARY KEY,
  doc_uid               TEXT NOT NULL,
  anchor_block_id       TEXT,
  anchor_quote          TEXT,          -- snapshot of the original block text
  anchor_kind           TEXT,          -- mdast node type of the original block
  proposed_text         TEXT NOT NULL, -- new markdown source for the block
  rationale             TEXT,
  author_client_id      TEXT NOT NULL,
  author_display_name   TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  decided_at            INTEGER,
  decided_by_name       TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_proposals_doc ON edit_proposals(doc_uid);
`;

export interface DocumentRow {
  uid: string;
  path: string;
  name: string | null;
  password_hash: string | null;
  editable_by_anyone: number;
  default_theme: string;
  created_at: number;
  updated_at: number;
}

/**
 * Per-document role hierarchy (highest → lowest privilege):
 *
 *   admin        — full control: edit, comment, invite, rename, delete.
 *   editor       — edit + comment + read.
 *   collaborator — comment + propose edits + read.  (Propose-edit is a
 *                  planned feature; for now collaborator behaves like
 *                  commentor from the server's point of view.)
 *   commentor    — comment + read.
 *   reader       — read only, cannot comment.
 */
export type InviteRole = 'admin' | 'editor' | 'collaborator' | 'commentor' | 'reader';

export const INVITE_ROLES: readonly InviteRole[] = [
  'admin',
  'editor',
  'collaborator',
  'commentor',
  'reader',
] as const;

export function isInviteRole(v: unknown): v is InviteRole {
  return typeof v === 'string' && (INVITE_ROLES as readonly string[]).includes(v);
}

export interface InviteRow {
  token: string;
  doc_uid: string;
  display_name: string;
  role: InviteRole;
  note: string | null;
  created_at: number;
  created_by_name: string;
}

export interface SessionRow {
  token: string;
  doc_uid: string;
  expires_at: number;
}

export type CommentStatus = 'active' | 'low-confidence' | 'orphaned';

export interface CommentRow {
  id: string;
  doc_uid: string;
  parent_id: string | null;
  anchor_block_id: string | null;
  anchor_quote: string | null;
  anchor_prefix: string | null;
  anchor_suffix: string | null;
  anchor_start_offset: number | null;
  anchor_end_offset: number | null;
  anchor_heading_path: string | null;
  anchor_section_index: number | null;
  anchor_section_index_path: string | null;
  author_client_id: string;
  author_display_name: string;
  body: string;
  status: CommentStatus;
  resolved_at: number | null;
  resolved_by_name: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface CommentMentionRow {
  doc_uid: string;
  comment_id: string;
  target_display_name: string;
  created_at: number;
  delivered_at: number | null;
}

export type EditProposalStatus = 'pending' | 'accepted' | 'rejected' | 'orphaned';

export interface EditProposalRow {
  id: string;
  doc_uid: string;
  anchor_block_id: string | null;
  anchor_quote: string | null;
  anchor_kind: string | null;
  proposed_text: string;
  rationale: string | null;
  author_client_id: string;
  author_display_name: string;
  status: EditProposalStatus;
  decided_at: number | null;
  decided_by_name: string | null;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  ensureColumn(db, 'comments', 'anchor_heading_path', 'TEXT');
  ensureColumn(db, 'comments', 'anchor_section_index', 'INTEGER');
  ensureColumn(db, 'comments', 'anchor_section_index_path', 'TEXT');
  return db;
}

function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
