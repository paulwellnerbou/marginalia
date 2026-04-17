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

export type InviteRole = 'admin' | 'editor' | 'reader';

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

export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}
