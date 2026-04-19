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
});
