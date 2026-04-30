import { Database } from 'bun:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS documents (
  uid                  TEXT PRIMARY KEY,
  -- Per-doc git repo location, relative to <dataDir>/repos. Always equals
  -- the uid for now (one doc → one repo). Stored as a column so we have
  -- an obvious place to override later if we ever need it.
  repo_dir             TEXT NOT NULL DEFAULT '',
  name                 TEXT,              -- human-friendly doc name; NULL → derive from content
  password_hash        TEXT,
  password_recovery_ciphertext TEXT,
  password_recovery_iv TEXT,
  -- DEPRECATED. Unread by authorize(), unwritten by new requests; kept so
  -- old bundles round-trip. Drop in a later migration.
  editable_by_anyone   INTEGER NOT NULL DEFAULT 0,
  default_theme        TEXT NOT NULL DEFAULT 'default',
  -- 'markdown' | 'asciidoc'. Legacy rows without a format are treated
  -- as markdown by the route layer (their path column already ends
  -- in ".md").
  format               TEXT NOT NULL DEFAULT 'markdown',
  -- Mermaid renderer for DOCX/PDF exports: 'mmdr' (native Rust, fast,
  -- lower fidelity) | 'chromium' (real mermaid.js, slower, pixel-
  -- identical to viewer). NULL means "use server default" (env
  -- MARGINALIA_MERMAID_RENDERER_DEFAULT, falling back to 'mmdr').
  -- Does NOT affect the viewer — that always uses mermaid.js.
  mermaid_renderer     TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  token            TEXT PRIMARY KEY,
  doc_uid          TEXT NOT NULL,
  -- NULL only for kind='generic'. Enforced in the route layer, not as
  -- CHECK (bun:sqlite doesn't surface CHECK errors cleanly).
  display_name     TEXT,
  role             TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'named',  -- 'admin' | 'generic' | 'named'
  note             TEXT,
  created_at       INTEGER NOT NULL,
  created_by_name  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_doc ON invites(doc_uid);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  doc_uid    TEXT NOT NULL,
  persistent INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_doc ON sessions(doc_uid);

CREATE TABLE IF NOT EXISTS comments (
  id                    TEXT PRIMARY KEY,
  doc_uid               TEXT NOT NULL,
  parent_id             TEXT,
  parent_proposal_id    TEXT,            -- reply to an edit proposal; mutually exclusive with parent_id + anchor
  anchor_block_id       TEXT,
  anchor_end_block_id   TEXT,            -- multi-block proposal: id of the last block in the span; NULL for single-block
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
  link_status           TEXT NOT NULL DEFAULT 'linked',
  resolved_at           INTEGER,
  resolved_by_name      TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER
);

CREATE INDEX IF NOT EXISTS idx_comments_doc ON comments(doc_uid);
CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id);

CREATE TABLE IF NOT EXISTS comments_edit_proposals (
  comment_id             TEXT PRIMARY KEY,
  anchor_kind            TEXT,
  source_snapshot        TEXT,
  proposed_text          TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'open',
  accepted_oid           TEXT
);

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

-- Per-document user registry. authorize() upserts on every request; a
-- display_name change for the same (doc_uid, client_id) fans out to
-- comments.author_display_name and comment_mentions.target_display_name
-- (the latter only when the old name is unambiguous in this doc).
CREATE TABLE IF NOT EXISTS doc_users (
  doc_uid        TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  PRIMARY KEY (doc_uid, client_id)
);

CREATE INDEX IF NOT EXISTS idx_doc_users_name
  ON doc_users(doc_uid, display_name);

-- Content-addressed blob metadata. One row per unique sha256; reused
-- across documents via document_assets. Rows are GC'd inline (see
-- gcAssetIfOrphan in routes/assets.ts) when the last document_assets
-- reference is detached — by explicit delete, replace-upload with
-- different bytes, or document deletion cascade.
CREATE TABLE IF NOT EXISTS assets (
  id          TEXT PRIMARY KEY,       -- hex sha256 of the bytes
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

-- Per-document attachment. ref_name is the string used to reference
-- the asset in source (e.g. "diagram.png", "intro.adoc"); the renderer
-- rewrites img src to the proxy URL when a row exists here. kind
-- mirrors the source usage ('image' | 'include' | 'attachment'); the
-- upload endpoint infers it from the mime type and the caller's hint.
CREATE TABLE IF NOT EXISTS document_assets (
  doc_uid     TEXT NOT NULL,
  ref_name    TEXT NOT NULL,
  asset_id    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'image',
  -- Content-Type served to browsers when this specific attachment is
  -- fetched. Derived server-side from the ref_name extension on upload
  -- (never from client-supplied file.type). Per-junction so two docs
  -- referencing the same bytes under different extensions each get
  -- their own Content-Type -- avoids a shared mime column in the
  -- assets table where the first uploader would otherwise control the
  -- type for every later attachment of the same sha256.
  mime        TEXT NOT NULL DEFAULT 'application/octet-stream',
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,
  PRIMARY KEY (doc_uid, ref_name)
);

CREATE INDEX IF NOT EXISTS idx_document_assets_asset ON document_assets(asset_id);
`;

/** Document source flavours persisted in `documents.format`. */
export type DocumentFormat = 'markdown' | 'asciidoc';

export const DOCUMENT_FORMATS: readonly DocumentFormat[] = ['markdown', 'asciidoc'] as const;

export function isDocumentFormat(v: unknown): v is DocumentFormat {
  return typeof v === 'string' && (DOCUMENT_FORMATS as readonly string[]).includes(v);
}

export interface DocumentRow {
  uid: string;
  /** Per-doc repo subpath under `<dataDir>/repos`. Equals `uid`. */
  repo_dir: string;
  name: string | null;
  password_hash: string | null;
  password_recovery_ciphertext: string | null;
  password_recovery_iv: string | null;
  editable_by_anyone: number;
  default_theme: string;
  format: DocumentFormat;
  /**
   * Per-document override of the mermaid renderer used for DOCX/PDF
   * exports. NULL → use server default (env
   * `MARGINALIA_MERMAID_RENDERER_DEFAULT`, falling back to `'mmdr'`).
   * Does not affect the viewer.
   */
  mermaid_renderer: MermaidRenderer | null;
  created_at: number;
  updated_at: number;
}

/**
 * Renderer used to rasterize mermaid blocks for DOCX/PDF exports.
 *
 *   'mmdr'     — native Rust subprocess (fast, lower fidelity)
 *   'chromium' — real mermaid.js inside headless Chromium (slow,
 *                pixel-identical to the viewer)
 *
 * The viewer is unaffected by this choice.
 */
export type MermaidRenderer = 'mmdr' | 'chromium';

export const MERMAID_RENDERERS: readonly MermaidRenderer[] = ['mmdr', 'chromium'] as const;

export function isMermaidRenderer(v: unknown): v is MermaidRenderer {
  return typeof v === 'string' && (MERMAID_RENDERERS as readonly string[]).includes(v);
}

/**
 * Per-document role hierarchy (highest → lowest privilege):
 *
 *   admin        — full control: edit, comment, propose, invite, rename, delete.
 *   editor       — edit + comment + propose + read.
 *   collaborator — comment + propose edits + read.
 *   reader       — read only, cannot comment or propose.
 *
 * Legacy `commentor` rows are migrated to `collaborator` in openDatabase().
 */
export type InviteRole = 'admin' | 'editor' | 'collaborator' | 'reader';

export const INVITE_ROLES: readonly InviteRole[] = [
  'admin',
  'editor',
  'collaborator',
  'reader',
] as const;

export function isInviteRole(v: unknown): v is InviteRole {
  return typeof v === 'string' && (INVITE_ROLES as readonly string[]).includes(v);
}

/**
 *   admin   — always-valid, rotatable, never shared. One per document.
 *   named   — seeds display_name + role on first visit.
 *   generic — role only; visitor keeps (or picks) their own name.
 */
export type InviteKind = 'admin' | 'named' | 'generic';

export const INVITE_KINDS: readonly InviteKind[] = ['admin', 'named', 'generic'] as const;

export function isInviteKind(v: unknown): v is InviteKind {
  return typeof v === 'string' && (INVITE_KINDS as readonly string[]).includes(v);
}

export interface InviteRow {
  token: string;
  doc_uid: string;
  display_name: string | null;
  role: InviteRole;
  kind: InviteKind;
  note: string | null;
  created_at: number;
  created_by_name: string;
}

export interface SessionRow {
  token: string;
  doc_uid: string;
  persistent: number;
  expires_at: number;
  /** Non-null only for invite sessions created by POST /invites/:token/claim. */
  invite_display_name: string | null;
  invite_role: string | null;
  invite_kind: string | null;
}

export type CommentLinkStatus = 'linked' | 'low-confidence' | 'orphaned';

export interface CommentRow {
  id: string;
  doc_uid: string;
  parent_id: string | null;
  parent_proposal_id: string | null;
  anchor_block_id: string | null;
  anchor_end_block_id: string | null;
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
  link_status: CommentLinkStatus;
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

export interface DocUserRow {
  doc_uid: string;
  client_id: string;
  display_name: string;
  first_seen_at: number;
  last_seen_at: number;
}

export type AssetKind = 'image' | 'include' | 'attachment';

export const ASSET_KINDS: readonly AssetKind[] = ['image', 'include', 'attachment'] as const;

export function isAssetKind(v: unknown): v is AssetKind {
  return typeof v === 'string' && (ASSET_KINDS as readonly string[]).includes(v);
}

export interface AssetRow {
  id: string;
  mime: string;
  size: number;
  created_at: number;
}

export interface DocumentAssetRow {
  doc_uid: string;
  ref_name: string;
  asset_id: string;
  kind: AssetKind;
  mime: string;
  created_at: number;
  created_by: string;
}

export type EditProposalStatus = 'open' | 'accepted' | 'rejected';

export interface EditProposalRow {
  comment_id: string;
  anchor_kind: string | null;
  source_snapshot: string | null;
  proposed_text: string;
  status: EditProposalStatus;
  accepted_oid: string | null;
}

export interface EditProposalThreadRow extends CommentRow {
  id: string;
  anchor_kind: string | null;
  source_snapshot: string | null;
  proposed_text: string;
  proposal_status: EditProposalStatus;
  accepted_oid: string | null;
  decided_at: number | null;
  decided_by_name: string | null;
}

export function openDatabase(path: string): Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  renameColumn(db, 'comments', 'status', 'link_status');
  ensureColumn(db, 'documents', 'name', 'TEXT');
  ensureColumn(db, 'comments', 'anchor_heading_path', 'TEXT');
  ensureColumn(db, 'comments', 'anchor_section_index', 'INTEGER');
  ensureColumn(db, 'comments', 'anchor_section_index_path', 'TEXT');
  ensureColumn(db, 'comments', 'parent_proposal_id', 'TEXT');
  ensureColumn(db, 'comments', 'anchor_end_block_id', 'TEXT');
  ensureColumn(db, 'documents', 'format', "TEXT NOT NULL DEFAULT 'markdown'");
  ensureColumn(db, 'documents', 'password_recovery_ciphertext', 'TEXT');
  ensureColumn(db, 'documents', 'password_recovery_iv', 'TEXT');
  ensureColumn(db, 'documents', 'mermaid_renderer', 'TEXT');
  ensureColumn(db, 'comments_edit_proposals', 'source_snapshot', 'TEXT');
  ensureColumn(db, 'comments_edit_proposals', 'accepted_oid', 'TEXT');
  ensureColumn(db, 'sessions', 'persistent', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'sessions', 'invite_display_name', 'TEXT');
  ensureColumn(db, 'sessions', 'invite_role', 'TEXT');
  ensureColumn(db, 'sessions', 'invite_kind', 'TEXT');
  ensureColumn(db, 'document_assets', 'mime', "TEXT NOT NULL DEFAULT 'application/octet-stream'");
  ensureColumn(db, 'documents', 'repo_dir', "TEXT NOT NULL DEFAULT ''");
  // Backfill per-doc repo subpath. Always = uid for now; the legacy
  // `path` column held `<uid>.<ext>`, derivable from uid + format and no
  // longer needed once the data migration (createApp) has split the
  // shared repo into per-doc repos.
  db.exec(`UPDATE documents SET repo_dir = uid WHERE repo_dir = ''`);
  dropColumnIfExists(db, 'documents', 'path');
  db.exec(`UPDATE comments SET link_status = 'linked' WHERE link_status = 'active'`);
  db.exec(`UPDATE comments_edit_proposals SET status = 'open' WHERE status = 'pending'`);
  db.exec(`UPDATE comments_edit_proposals SET status = 'open' WHERE status = 'orphaned'`);
  // Legacy 'commentor' rows → 'collaborator' (same server-side behavior).
  db.exec(`UPDATE invites SET role = 'collaborator' WHERE role = 'commentor'`);
  migrateInvitesKind(db);
  migrateEditProposalsToCommentExtensions(db);
  migrateProposalDecisionColumnsToComments(db);
  return db;
}

/**
 * Add `invites.kind`, relax `display_name` to nullable, backfill admin
 * rows. SQLite can't drop NOT NULL in place, so we rebuild the table
 * when the old schema is detected. Idempotent; no-op on fresh DBs.
 */
function migrateInvitesKind(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(invites)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  const hasKind = cols.some((c) => c.name === 'kind');
  const displayNotNull = cols.some((c) => c.name === 'display_name' && c.notnull === 1);
  if (hasKind && !displayNotNull) return; // already migrated

  db.exec('BEGIN');
  try {
    db.exec(`ALTER TABLE invites RENAME TO invites_pre_step3`);
    db.exec(`
      CREATE TABLE invites (
        token            TEXT PRIMARY KEY,
        doc_uid          TEXT NOT NULL,
        display_name     TEXT,
        role             TEXT NOT NULL,
        kind             TEXT NOT NULL DEFAULT 'named',
        note             TEXT,
        created_at       INTEGER NOT NULL,
        created_by_name  TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO invites (token, doc_uid, display_name, role, kind, note, created_at, created_by_name)
      SELECT token, doc_uid, display_name, role,
             CASE WHEN role = 'admin' THEN 'admin' ELSE 'named' END,
             note, created_at, created_by_name
      FROM invites_pre_step3
    `);
    db.exec(`DROP TABLE invites_pre_step3`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_invites_doc ON invites(doc_uid)`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function ensureColumn(db: Database, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

function renameColumn(db: Database, table: string, from: string, to: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (cols.some((c) => c.name === to) || !cols.some((c) => c.name === from)) return;
  db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
}

function dropColumnIfExists(db: Database, table: string, column: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

function migrateEditProposalsToCommentExtensions(db: Database): void {
  if (!tableExists(db, 'edit_proposals')) return;

  db.exec('BEGIN');
  try {
    db.exec(`
      INSERT OR IGNORE INTO comments (
        id, doc_uid, parent_id, parent_proposal_id,
        anchor_block_id, anchor_quote, anchor_prefix, anchor_suffix,
        anchor_start_offset, anchor_end_offset,
        anchor_heading_path, anchor_section_index, anchor_section_index_path,
        author_client_id, author_display_name,
        body, link_status, resolved_at, resolved_by_name,
        created_at, updated_at, deleted_at
      )
      SELECT
        id,
        doc_uid,
        NULL,
        NULL,
        anchor_block_id,
        anchor_quote,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        NULL,
        author_client_id,
        author_display_name,
        COALESCE(rationale, ''),
        CASE WHEN status = 'orphaned' THEN 'orphaned' ELSE 'linked' END,
        CASE WHEN status IN ('accepted', 'rejected') THEN decided_at ELSE NULL END,
        CASE WHEN status IN ('accepted', 'rejected') THEN decided_by_name ELSE NULL END,
        created_at,
        updated_at,
        deleted_at
      FROM edit_proposals
    `);
    db.exec(`
      INSERT OR IGNORE INTO comments_edit_proposals (
        comment_id, anchor_kind, source_snapshot, proposed_text, status, accepted_oid
      )
      SELECT
        id,
        anchor_kind,
        anchor_quote,
        proposed_text,
        CASE
          WHEN status = 'accepted' THEN 'accepted'
          WHEN status = 'rejected' THEN 'rejected'
          ELSE 'open'
        END,
        NULL
      FROM edit_proposals
    `);
    db.exec('DROP TABLE edit_proposals');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function migrateProposalDecisionColumnsToComments(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(comments_edit_proposals)`).all() as Array<{
    name: string;
  }>;
  const hasDecidedAt = cols.some((c) => c.name === 'decided_at');
  const hasDecidedByName = cols.some((c) => c.name === 'decided_by_name');
  if (!hasDecidedAt && !hasDecidedByName) return;

  const assignments: string[] = [];
  if (hasDecidedAt) {
    assignments.push(`
      resolved_at = COALESCE(
        resolved_at,
        (SELECT cep.decided_at
           FROM comments_edit_proposals cep
          WHERE cep.comment_id = comments.id)
      )
    `);
  }
  if (hasDecidedByName) {
    assignments.push(`
      resolved_by_name = COALESCE(
        resolved_by_name,
        (SELECT cep.decided_by_name
           FROM comments_edit_proposals cep
          WHERE cep.comment_id = comments.id)
      )
    `);
  }

  db.exec('BEGIN');
  try {
    db.exec(
      `UPDATE comments
          SET ${assignments.join(', ')}
        WHERE EXISTS (
              SELECT 1
                FROM comments_edit_proposals cep
               WHERE cep.comment_id = comments.id
                 AND cep.status IN ('accepted', 'rejected')
            )`,
    );

    db.exec(`ALTER TABLE comments_edit_proposals RENAME TO comments_edit_proposals_pre_cleanup`);
    db.exec(`
      CREATE TABLE comments_edit_proposals (
        comment_id             TEXT PRIMARY KEY,
        anchor_kind            TEXT,
        source_snapshot        TEXT,
        proposed_text          TEXT NOT NULL,
        status                 TEXT NOT NULL DEFAULT 'open',
        accepted_oid           TEXT
      )
    `);
    db.exec(`
      INSERT INTO comments_edit_proposals (
        comment_id, anchor_kind, source_snapshot, proposed_text, status, accepted_oid
      )
      SELECT
        comment_id, anchor_kind, source_snapshot, proposed_text, status, accepted_oid
      FROM comments_edit_proposals_pre_cleanup
    `);
    db.exec(`DROP TABLE comments_edit_proposals_pre_cleanup`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function tableExists(db: Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return row?.name === table;
}
