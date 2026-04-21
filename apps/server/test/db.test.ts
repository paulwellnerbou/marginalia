import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';

/**
 * Schema migrations live inside `openDatabase()`. They must run on existing
 * databases without losing data and must be idempotent so server restarts
 * stay cheap.
 */
describe('openDatabase migrations', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-db-mig-'));
    dbPath = join(dir, 'test.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('invites schema: pre-Step-3 tables get kind column, display_name made nullable, admin rows backfilled', () => {
    // Seed a pre-Step-3 invites table: display_name NOT NULL, no kind column.
    {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE invites (
          token            TEXT PRIMARY KEY,
          doc_uid          TEXT NOT NULL,
          display_name     TEXT NOT NULL,
          role             TEXT NOT NULL,
          note             TEXT,
          created_at       INTEGER NOT NULL,
          created_by_name  TEXT NOT NULL
        )
      `);
      const now = Date.now();
      seed
        .prepare(
          `INSERT INTO invites (token, doc_uid, display_name, role, note, created_at, created_by_name)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run('adm', 'doc-x', 'Alice', 'admin', now, 'Alice');
      seed
        .prepare(
          `INSERT INTO invites (token, doc_uid, display_name, role, note, created_at, created_by_name)
           VALUES (?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run('nmd', 'doc-x', 'Bob', 'collaborator', now, 'Alice');
      seed.close();
    }

    // Trigger migration.
    const db = openDatabase(dbPath);
    const cols = db.prepare('PRAGMA table_info(invites)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const kindCol = cols.find((c) => c.name === 'kind');
    const displayCol = cols.find((c) => c.name === 'display_name');
    expect(kindCol).toBeDefined();
    expect(kindCol!.notnull).toBe(1); // kind is NOT NULL with default
    expect(displayCol).toBeDefined();
    expect(displayCol!.notnull).toBe(0); // display_name is now nullable

    const rows = db
      .prepare('SELECT token, role, kind, display_name FROM invites ORDER BY token')
      .all() as Array<{ token: string; role: string; kind: string; display_name: string | null }>;
    expect(rows).toEqual([
      { token: 'adm', role: 'admin', kind: 'admin', display_name: 'Alice' },
      { token: 'nmd', role: 'collaborator', kind: 'named', display_name: 'Bob' },
    ]);
    db.close();

    // Idempotent: a second open is a no-op (same shape, same rows).
    const db2 = openDatabase(dbPath);
    const rows2 = db2
      .prepare('SELECT token, kind FROM invites ORDER BY token')
      .all() as Array<{ token: string; kind: string }>;
    expect(rows2).toEqual([
      { token: 'adm', kind: 'admin' },
      { token: 'nmd', kind: 'named' },
    ]);
    db2.close();
  });

  test('commentor invites are migrated to collaborator on open (ACCESS_CONTROL Step 1)', () => {
    // Seed an "old" database the way a previously-shipped server would
    // have written it: invites with role='commentor'. We bypass
    // openDatabase here because today's schema's CHECK / type system
    // wouldn't let the old value through if we ever add a constraint.
    {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE invites (
          token            TEXT PRIMARY KEY,
          doc_uid          TEXT NOT NULL,
          display_name     TEXT NOT NULL,
          role             TEXT NOT NULL,
          note             TEXT,
          created_at       INTEGER NOT NULL,
          created_by_name  TEXT NOT NULL
        );
      `);
      const now = Date.now();
      seed.prepare(
        `INSERT INTO invites (token, doc_uid, display_name, role, note, created_at, created_by_name)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run('tok-1', 'doc-1', 'Bob', 'commentor', now, 'Alice');
      seed.prepare(
        `INSERT INTO invites (token, doc_uid, display_name, role, note, created_at, created_by_name)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).run('tok-2', 'doc-1', 'Carol', 'collaborator', now, 'Alice');
      seed.close();
    }

    // Open via the production path → migration runs.
    const db = openDatabase(dbPath);
    const rows = db
      .prepare('SELECT token, role FROM invites ORDER BY token')
      .all() as Array<{ token: string; role: string }>;
    expect(rows).toEqual([
      { token: 'tok-1', role: 'collaborator' }, // migrated from commentor
      { token: 'tok-2', role: 'collaborator' }, // unchanged
    ]);
    db.close();

    // Idempotent: a second openDatabase on the same file leaves it alone
    // (no rows still match `role='commentor'`).
    const db2 = openDatabase(dbPath);
    const stillCommentors = db2
      .prepare(`SELECT count(*) AS n FROM invites WHERE role = 'commentor'`)
      .get() as { n: number };
    expect(stillCommentors.n).toBe(0);
    db2.close();
  });

  test('documents schema: legacy tables get nullable name column on open', () => {
    {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE documents (
          uid                  TEXT PRIMARY KEY,
          path                 TEXT NOT NULL,
          password_hash        TEXT,
          editable_by_anyone   INTEGER NOT NULL DEFAULT 0,
          default_theme        TEXT NOT NULL DEFAULT 'default',
          format               TEXT NOT NULL DEFAULT 'markdown',
          created_at           INTEGER NOT NULL,
          updated_at           INTEGER NOT NULL
        )
      `);
      const now = Date.now();
      seed
        .prepare(
          `INSERT INTO documents
             (uid, path, password_hash, editable_by_anyone, default_theme, format, created_at, updated_at)
           VALUES (?, ?, NULL, 0, ?, ?, ?, ?)`,
        )
        .run('doc-1', 'docs/doc-1.md', 'default', 'markdown', now, now);
      seed.close();
    }

    const db = openDatabase(dbPath);
    const cols = db.prepare('PRAGMA table_info(documents)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    const nameCol = cols.find((c) => c.name === 'name');
    expect(nameCol).toBeDefined();
    expect(nameCol!.notnull).toBe(0);

    const row = db.prepare('SELECT uid, path, name FROM documents WHERE uid = ?').get('doc-1') as {
      uid: string;
      path: string;
      name: string | null;
    };
    expect(row).toEqual({
      uid: 'doc-1',
      path: 'docs/doc-1.md',
      name: null,
    });
    db.close();

    const db2 = openDatabase(dbPath);
    const row2 = db2.prepare('SELECT name FROM documents WHERE uid = ?').get('doc-1') as {
      name: string | null;
    };
    expect(row2.name).toBeNull();
    db2.close();
  });

  test('legacy edit_proposals are migrated into comments + comments_edit_proposals', () => {
    {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE comments (
          id                    TEXT PRIMARY KEY,
          doc_uid               TEXT NOT NULL,
          parent_id             TEXT,
          parent_proposal_id    TEXT,
          anchor_block_id       TEXT,
          anchor_quote          TEXT,
          anchor_prefix         TEXT,
          anchor_suffix         TEXT,
          anchor_start_offset   INTEGER,
          anchor_end_offset     INTEGER,
          anchor_heading_path   TEXT,
          anchor_section_index  INTEGER,
          anchor_section_index_path TEXT,
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
        CREATE TABLE edit_proposals (
          id                    TEXT PRIMARY KEY,
          doc_uid               TEXT NOT NULL,
          anchor_block_id       TEXT,
          anchor_quote          TEXT,
          anchor_kind           TEXT,
          proposed_text         TEXT NOT NULL,
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
      `);
      const now = Date.now();
      seed.prepare(
        `INSERT INTO edit_proposals
           (id, doc_uid, anchor_block_id, anchor_quote, anchor_kind, proposed_text,
            rationale, author_client_id, author_display_name, status,
            decided_at, decided_by_name, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        'prop-1',
        'doc-1',
        'block-1',
        'Original block',
        'paragraph',
        'Edited block',
        'Why this should change',
        'client-1',
        'Alice',
        'pending',
        null,
        null,
        now,
        now,
        null,
      );
      seed.close();
    }

    const db = openDatabase(dbPath);

    const oldTable = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'edit_proposals'`,
    ).get() as { name: string } | null;
    expect(oldTable).toBeNull();

    const migratedComment = db.prepare(
      `SELECT id, doc_uid, anchor_block_id, anchor_quote, body, status, author_client_id, author_display_name
         FROM comments
        WHERE id = ?`,
    ).get('prop-1') as {
      id: string;
      doc_uid: string;
      anchor_block_id: string | null;
      anchor_quote: string | null;
      body: string;
      status: string;
      author_client_id: string;
      author_display_name: string;
    };
    expect(migratedComment).toEqual({
      id: 'prop-1',
      doc_uid: 'doc-1',
      anchor_block_id: 'block-1',
      anchor_quote: 'Original block',
      body: 'Why this should change',
      status: 'active',
      author_client_id: 'client-1',
      author_display_name: 'Alice',
    });

    const migratedProposal = db.prepare(
      `SELECT comment_id, anchor_kind, proposed_text, status, decided_at, decided_by_name
         FROM comments_edit_proposals
        WHERE comment_id = ?`,
    ).get('prop-1') as {
      comment_id: string;
      anchor_kind: string | null;
      proposed_text: string;
      status: string;
      decided_at: number | null;
      decided_by_name: string | null;
    };
    expect(migratedProposal).toEqual({
      comment_id: 'prop-1',
      anchor_kind: 'paragraph',
      proposed_text: 'Edited block',
      status: 'pending',
      decided_at: null,
      decided_by_name: null,
    });

    db.close();
  });
});
