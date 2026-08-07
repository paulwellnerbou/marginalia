import type { Database } from 'bun:sqlite';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { readIdentity } from '../auth.js';
import type { ServerConfig } from '../config.js';
import type { DocumentFormat, InviteRole, KeyringRow } from '../db.js';
import { newKeyringToken, newPairingCode } from '../ids.js';
import { clientKey, FixedWindowRateLimiter } from '../rate-limit.js';

/**
 * Keyrings — one person's documents across their several devices.
 *
 * The deliberate non-feature here: none of this authorizes anything.
 * `authorize()` never reads these tables, and holding a keyring token
 * lets you fetch a list of invite tokens, not a document. Access is
 * still the per-document capability URL it always was; the keyring only
 * spares you from carrying each one to each device by hand.
 *
 * That is what keeps it small — no grants, no per-document ACL, no
 * migration of existing invite links — and it is also the security
 * boundary worth stating plainly: a leaked keyring token is equivalent
 * to leaking every access link inside it at once. Hence the pairing
 * code, so the standing secret never has to be shown, typed, or
 * photographed.
 */

export const KEYRING_HEADER = 'x-marginalia-keyring';

/** Ceiling on documents in one keyring. Guards the unbounded PUT loop. */
const MAX_KEYRING_DOCS = 500;

/** Single key for the server-wide redeem counter. */
const GLOBAL_BUCKET = '*';

export interface KeyringDeps {
  db: Database;
  config: ServerConfig;
}

interface Limiters {
  redeemPerClient: FixedWindowRateLimiter;
  redeemGlobal: FixedWindowRateLimiter;
  createPerClient: FixedWindowRateLimiter;
}

/** 429 with a `Retry-After`, so a client can back off rather than spin. */
function tooManyRequests(c: Context, retryAfterSec: number, error: string) {
  c.header('Retry-After', String(retryAfterSec));
  return c.json({ error, retry_after: retryAfterSec }, 429);
}

interface KeyringDocWire {
  doc_uid: string;
  invite_token: string;
  title: string | null;
  role: InviteRole | null;
  format: DocumentFormat;
  password_protected: boolean;
  updated_at: number;
  added_at: number;
  cover: { ref_name: string; asset_id: string; mime: string } | null;
}

export function keyringsRouter(deps: KeyringDeps): Hono {
  const r = new Hono();
  // Per-router instances: one process, one set of counters, and tests
  // get a fresh app (and so fresh limits) per case.
  const limits: Limiters = {
    redeemPerClient: new FixedWindowRateLimiter({
      limit: deps.config.pairingRedeemPerClient,
      windowMs: deps.config.pairingRedeemWindowMs,
    }),
    redeemGlobal: new FixedWindowRateLimiter({
      limit: deps.config.pairingRedeemGlobal,
      windowMs: deps.config.pairingRedeemWindowMs,
    }),
    createPerClient: new FixedWindowRateLimiter({
      limit: deps.config.keyringCreatePerClient,
      windowMs: deps.config.keyringCreateWindowMs,
    }),
  };

  r.post('/keyrings', async (c) => createKeyring(c, deps, limits));
  r.get('/keyrings/self', async (c) => readKeyring(c, deps));
  r.patch('/keyrings/self', async (c) => renameKeyring(c, deps));
  r.post('/keyrings/self/rotate', async (c) => rotateKeyring(c, deps));
  r.put('/keyrings/self/docs/:uid', async (c) => putKeyringDoc(c, deps));
  r.delete('/keyrings/self/docs/:uid', async (c) => deleteKeyringDoc(c, deps));
  r.post('/keyrings/self/pairings', async (c) => createPairing(c, deps));
  r.post('/pairings/redeem', async (c) => redeemPairing(c, deps, limits));

  return r;
}

/** Resolve the caller's keyring from the header, or null. */
function readKeyringRow(db: Database, c: Context): KeyringRow | null {
  const token = c.req.header(KEYRING_HEADER);
  if (!token) return null;
  const row = db.prepare('SELECT * FROM keyrings WHERE token = ?').get(token) as
    | KeyringRow
    | undefined;
  return row ?? null;
}

function touch(db: Database, token: string): void {
  db.prepare('UPDATE keyrings SET updated_at = ? WHERE token = ?').run(Date.now(), token);
}

async function safeJson(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = (await c.req.json()) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

// --- POST /api/keyrings ----------------------------------------------

/**
 * Mint a keyring for the calling device, adopting its current identity
 * so nothing is lost by turning one on: the clientId it has been
 * authoring comments under becomes the shared one, rather than every
 * device switching to a new identity and orphaning past authorship.
 *
 * `docs` seeds the ring from what this browser already holds — the
 * device that creates the keyring is usually the one with the full list.
 */
async function createKeyring(c: Context, { db, config }: KeyringDeps, limits: Limiters) {
  // Unauthenticated and it writes rows, so it gets a ceiling too — not
  // for secrecy (there is nothing to guess) but so one client cannot
  // fill the table.
  const who = clientKey(c, config.trustProxy);
  const quota = limits.createPerClient.check(who);
  if (!quota.allowed) return tooManyRequests(c, quota.retryAfterSec, 'too-many-keyrings');

  const identity = readIdentity(c.req.raw.headers);
  if (!identity) return c.json({ error: 'identity-required' }, 400);
  limits.createPerClient.record(who);

  const body = (await safeJson(c)) ?? {};
  const seeds = parseDocSeeds(body.docs);

  const token = newKeyringToken();
  const now = Date.now();
  db.prepare(
    `INSERT INTO keyrings (token, client_id, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(token, identity.clientId, identity.displayName, now, now);

  for (const seed of seeds.slice(0, MAX_KEYRING_DOCS)) {
    if (!inviteMatchesDoc(db, seed.doc_uid, seed.invite_token)) continue;
    db.prepare(
      `INSERT OR REPLACE INTO keyring_docs
         (keyring_token, doc_uid, invite_token, title, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(token, seed.doc_uid, seed.invite_token, seed.title, now);
  }

  c.header('Cache-Control', 'no-store');
  return c.json(
    {
      token,
      client_id: identity.clientId,
      display_name: identity.displayName,
      docs: listKeyringDocs(db, token),
    },
    201,
  );
}

// --- GET /api/keyrings/self ------------------------------------------

async function readKeyring(c: Context, { db }: KeyringDeps) {
  const ring = readKeyringRow(db, c);
  if (!ring) return c.json({ error: 'not-found' }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json({
    client_id: ring.client_id,
    display_name: ring.display_name,
    updated_at: ring.updated_at,
    docs: listKeyringDocs(db, ring.token),
  });
}

// --- PATCH /api/keyrings/self ----------------------------------------

/**
 * The keyring is authoritative for the display name, so a rename has to
 * land here to reach the other devices — they adopt it on their next
 * pull. Renaming *within* a document still goes through the per-document
 * path in authorize(); this only keeps the shared identity in step.
 */
async function renameKeyring(c: Context, { db }: KeyringDeps) {
  const ring = readKeyringRow(db, c);
  if (!ring) return c.json({ error: 'not-found' }, 404);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  const name = typeof body.display_name === 'string' ? body.display_name.trim() : '';
  if (name.length < 1 || name.length > 80) return c.json({ error: 'invalid-display-name' }, 400);

  db.prepare('UPDATE keyrings SET display_name = ?, updated_at = ? WHERE token = ?').run(
    name,
    Date.now(),
    ring.token,
  );
  return c.json({ display_name: name });
}

// --- POST /api/keyrings/self/rotate ----------------------------------

/**
 * Replace the token, keeping the documents and identity. The escape
 * hatch for a keyring you believe leaked — and the reason it is worth
 * having is that the alternative, rotating the admin invite of every
 * document one at a time, is exactly the chore this feature exists to
 * remove.
 *
 * Insert-then-move-then-delete, so the rows are never briefly ownerless.
 * Outstanding pairing codes die with the old token: a rotation is a
 * response to compromise, and a code minted before it should not still
 * open the door.
 */
async function rotateKeyring(c: Context, { db }: KeyringDeps) {
  const ring = readKeyringRow(db, c);
  if (!ring) return c.json({ error: 'not-found' }, 404);

  const fresh = newKeyringToken();
  const now = Date.now();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO keyrings (token, client_id, display_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(fresh, ring.client_id, ring.display_name, ring.created_at, now);
    db.prepare('UPDATE keyring_docs SET keyring_token = ? WHERE keyring_token = ?').run(
      fresh,
      ring.token,
    );
    db.prepare('DELETE FROM keyring_pairings WHERE keyring_token = ?').run(ring.token);
    db.prepare('DELETE FROM keyrings WHERE token = ?').run(ring.token);
  })();

  c.header('Cache-Control', 'no-store');
  return c.json({ token: fresh, client_id: ring.client_id, display_name: ring.display_name });
}

// --- PUT /api/keyrings/self/docs/:uid --------------------------------

async function putKeyringDoc(c: Context, { db }: KeyringDeps) {
  const ring = readKeyringRow(db, c);
  if (!ring) return c.json({ error: 'not-found' }, 404);

  const docUid = c.req.param('uid');
  if (!docUid) return c.json({ error: 'not-found' }, 404);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  const inviteToken = typeof body.invite_token === 'string' ? body.invite_token : '';
  if (!inviteToken) return c.json({ error: 'invite-token-required' }, 400);

  // The token has to be a real invite on this document. Not an
  // authorization check — anyone holding the token could use it directly
  // — just a guard against junk rows that would 404 on another device
  // with no way to tell why.
  if (!inviteMatchesDoc(db, docUid, inviteToken)) {
    return c.json({ error: 'invite-not-found' }, 404);
  }

  const existing = db
    .prepare('SELECT 1 FROM keyring_docs WHERE keyring_token = ? AND doc_uid = ?')
    .get(ring.token, docUid);
  if (!existing) {
    const { n } = db
      .prepare('SELECT count(*) AS n FROM keyring_docs WHERE keyring_token = ?')
      .get(ring.token) as { n: number };
    if (n >= MAX_KEYRING_DOCS) return c.json({ error: 'keyring-full' }, 409);
  }

  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) || null : null;
  db.prepare(
    `INSERT INTO keyring_docs (keyring_token, doc_uid, invite_token, title, added_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(keyring_token, doc_uid)
       DO UPDATE SET invite_token = excluded.invite_token,
                     title = COALESCE(excluded.title, keyring_docs.title)`,
  ).run(ring.token, docUid, inviteToken, title, Date.now());
  touch(db, ring.token);

  return c.json({ ok: true }, 200);
}

// --- DELETE /api/keyrings/self/docs/:uid -----------------------------

async function deleteKeyringDoc(c: Context, { db }: KeyringDeps) {
  const ring = readKeyringRow(db, c);
  if (!ring) return c.json({ error: 'not-found' }, 404);

  const docUid = c.req.param('uid');
  if (!docUid) return c.json({ error: 'not-found' }, 404);

  db.prepare('DELETE FROM keyring_docs WHERE keyring_token = ? AND doc_uid = ?').run(
    ring.token,
    docUid,
  );
  touch(db, ring.token);
  return c.body(null, 204);
}

// --- POST /api/keyrings/self/pairings --------------------------------

/**
 * Mint a short-lived code that hands this keyring to another device.
 *
 * Only one code is outstanding per keyring: minting drops the previous
 * one, so the code on the screen is always the only one that works and
 * closing the dialog without using it doesn't leave a live credential
 * behind. Expired rows from other keyrings are swept here too — there
 * is no scheduler in this server, and this is the one endpoint whose
 * traffic is proportional to the table's growth.
 */
async function createPairing(c: Context, { db, config }: KeyringDeps) {
  const ring = readKeyringRow(db, c);
  if (!ring) return c.json({ error: 'not-found' }, 404);

  const now = Date.now();
  db.prepare('DELETE FROM keyring_pairings WHERE expires_at < ? OR keyring_token = ?').run(
    now,
    ring.token,
  );

  const code = newPairingCode();
  const expiresAt = now + config.keyringPairingTtlMs;
  db.prepare(
    `INSERT INTO keyring_pairings (code, keyring_token, created_at, expires_at)
     VALUES (?, ?, ?, ?)`,
  ).run(code, ring.token, now, expiresAt);

  c.header('Cache-Control', 'no-store');
  return c.json({ code, expires_at: expiresAt }, 201);
}

// --- POST /api/pairings/redeem ---------------------------------------

/**
 * Exchange a pairing code for the keyring token. Unauthenticated by
 * design — the calling device has nothing yet; the code is the proof.
 *
 * Single-use: the row is deleted inside the same transaction that reads
 * it, so two devices racing on one code cannot both win.
 *
 * This is the only route where guessing wins something, so it carries
 * two counters. Only *failures* are recorded: a real pairing succeeds on
 * the first try and spends nothing, which is what lets the limits sit
 * low enough to matter without ever getting in a user's way.
 *
 * The global counter is the one that actually bounds a brute force —
 * per-client limits assume the client can be identified, and an attacker
 * picks their own source addresses. It is set high enough that the
 * collateral case (an attacker burning the global budget and blocking
 * real pairings for the rest of the window) needs a deliberate flood
 * rather than background noise; access links still work throughout, so
 * the degraded state is "pairing is unavailable for a few minutes", not
 * "locked out".
 */
async function redeemPairing(c: Context, { db, config }: KeyringDeps, limits: Limiters) {
  const who = clientKey(c, config.trustProxy);
  const perClient = limits.redeemPerClient.check(who);
  if (!perClient.allowed) return tooManyRequests(c, perClient.retryAfterSec, 'too-many-attempts');
  const global = limits.redeemGlobal.check(GLOBAL_BUCKET);
  if (!global.allowed) return tooManyRequests(c, global.retryAfterSec, 'too-many-attempts');

  const fail = (status: 400 | 404, error: string) => {
    limits.redeemPerClient.record(who);
    limits.redeemGlobal.record(GLOBAL_BUCKET);
    return c.json({ error }, status);
  };

  const body = await safeJson(c);
  if (!body) return fail(400, 'invalid-body');
  const raw = typeof body.code === 'string' ? body.code : '';
  const code = normalizePairingCode(raw);
  if (!code) return fail(400, 'invalid-code');

  const claim = db.transaction(() => {
    const row = db.prepare('SELECT * FROM keyring_pairings WHERE code = ?').get(code) as
      | { code: string; keyring_token: string; expires_at: number }
      | undefined;
    if (!row) return null;
    db.prepare('DELETE FROM keyring_pairings WHERE code = ?').run(code);
    if (row.expires_at < Date.now()) return null;
    return row;
  })();
  if (!claim) return fail(404, 'invalid-code');

  const ring = db.prepare('SELECT * FROM keyrings WHERE token = ?').get(claim.keyring_token) as
    | KeyringRow
    | undefined;
  if (!ring) return fail(404, 'invalid-code');

  c.header('Cache-Control', 'no-store');
  return c.json({
    token: ring.token,
    client_id: ring.client_id,
    display_name: ring.display_name,
    docs: listKeyringDocs(db, ring.token),
  });
}

// --- helpers ---------------------------------------------------------

/**
 * Join through to `documents` so a paired device gets titles, formats
 * and covers without a request per document — and so rows for documents
 * that have since been deleted simply fall out of the list. Deletion
 * doesn't cascade into keyrings (the document routes have no idea these
 * tables exist), which makes the inner join the thing that keeps a
 * keyring honest.
 */
function listKeyringDocs(db: Database, keyringToken: string): KeyringDocWire[] {
  const rows = db
    .prepare(
      `SELECT kd.doc_uid, kd.invite_token, kd.title, kd.added_at,
              d.format, d.updated_at, d.password_hash, d.cover_ref,
              i.role AS role,
              da.ref_name AS cover_ref_name, da.asset_id AS cover_asset_id,
              da.mime AS cover_mime
         FROM keyring_docs kd
         JOIN documents d ON d.uid = kd.doc_uid
         LEFT JOIN invites i ON i.token = kd.invite_token AND i.doc_uid = kd.doc_uid
         LEFT JOIN document_assets da
                ON da.doc_uid = d.uid AND da.ref_name = d.cover_ref
        WHERE kd.keyring_token = ?
        ORDER BY d.updated_at DESC`,
    )
    .all(keyringToken) as Array<{
    doc_uid: string;
    invite_token: string;
    title: string | null;
    added_at: number;
    format: DocumentFormat;
    updated_at: number;
    password_hash: string | null;
    cover_ref: string | null;
    role: InviteRole | null;
    cover_ref_name: string | null;
    cover_asset_id: string | null;
    cover_mime: string | null;
  }>;

  return rows.map((row) => ({
    doc_uid: row.doc_uid,
    invite_token: row.invite_token,
    title: row.title,
    // NULL when the invite was revoked or rotated from another device.
    // Surfaced rather than hidden: the entry still opens, it just won't
    // grant what it used to, and the client says so on the card.
    role: row.role,
    format: row.format,
    password_protected: row.password_hash !== null,
    updated_at: row.updated_at,
    added_at: row.added_at,
    cover:
      row.cover_ref_name && row.cover_asset_id
        ? {
            ref_name: row.cover_ref_name,
            asset_id: row.cover_asset_id,
            mime: row.cover_mime ?? 'application/octet-stream',
          }
        : null,
  }));
}

function inviteMatchesDoc(db: Database, docUid: string, inviteToken: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM invites WHERE token = ? AND doc_uid = ?')
    .get(inviteToken, docUid);
  return !!row;
}

function parseDocSeeds(
  v: unknown,
): Array<{ doc_uid: string; invite_token: string; title: string | null }> {
  if (!Array.isArray(v)) return [];
  const out: Array<{ doc_uid: string; invite_token: string; title: string | null }> = [];
  for (const entry of v) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.doc_uid !== 'string' || typeof e.invite_token !== 'string') continue;
    if (!e.doc_uid || !e.invite_token) continue;
    out.push({
      doc_uid: e.doc_uid,
      invite_token: e.invite_token,
      title: typeof e.title === 'string' ? e.title.trim().slice(0, 200) || null : null,
    });
  }
  return out;
}

/**
 * Codes are shown grouped and read off a screen, so accept them back the
 * way people retype them: any case, with or without the separator, and
 * with stray whitespace. The lookup itself stays an exact match on the
 * canonical form.
 */
export function normalizePairingCode(raw: string): string | null {
  const compact = raw.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(compact)) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}
