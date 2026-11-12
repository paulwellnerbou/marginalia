import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { normalizeAgentName } from '@marginalia/mcp';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { revokeInviteSessions } from '../auth.js';
import type { DocumentFormat, InviteRole, KeyringAgentRow, KeyringRow } from '../db.js';
import { newAgentId, newAgentKey } from '../ids.js';
import { createInviteRow, setInviteRole } from './documents.js';
import { readKeyringRow, safeJson, touchKeyringIfStale, upsertKeyringDoc } from './keyrings.js';

/**
 * Agent keys — one MCP connection for a whole keyring.
 *
 * The keyring token is never handed to an agent. It is the standing
 * secret for every link in the ring, and an MCP connection string ends up
 * in config files and third-party connector settings. An agent key is a
 * separate credential minted from the ring, revocable on its own, with a
 * default role and a name of its own.
 *
 * It still authorizes nothing directly: `authorize()` never reads these
 * tables. The agent exchanges the key for an ordinary named invite per
 * document, minted here from the admin link the ring holds, at the key's
 * role. Those invites show in each document's access panel like any
 * other, and revoking the key deletes them — which is what cuts the
 * agent off, wherever it cached them.
 *
 * Only documents the ring holds an admin link for are reachable: minting
 * an invite is an admin act, and handing the agent a lesser link of the
 * ring's own would mean it signing under someone else's invite with no
 * way to take that back.
 */

export const AGENT_KEY_HEADER = 'x-marginalia-agent-key';

/** Marks the invites minted here in a document's access panel. */
export const AGENT_INVITE_NOTE = 'AI agent via keyring';

const AGENT_ROLES: readonly InviteRole[] = ['editor', 'collaborator', 'reader'];

/** Keys per ring. A person has a handful of agents, not hundreds. */
const MAX_AGENTS_PER_RING = 20;

/** How stale `last_used_at` may get before a request refreshes it. */
const LAST_USED_INTERVAL_MS = 60 * 60 * 1000;

export function hashAgentKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function agentKeysRouter(deps: { db: Database }): Hono {
  const r = new Hono();
  const { db } = deps;

  // Managed with the keyring token, from a synced device.
  r.get('/keyrings/self/agents', (c) => listAgents(c, db));
  r.post('/keyrings/self/agents', async (c) => createAgent(c, db));
  r.patch('/keyrings/self/agents/:id', async (c) => updateAgent(c, db));
  r.delete('/keyrings/self/agents/:id', (c) => deleteAgent(c, db));
  r.put('/keyrings/self/agents/:id/documents/:uid', async (c) => setAgentDocumentRole(c, db));

  // Used with the agent key, by the MCP server.
  r.get('/agent/self', (c) => agentSelf(c, db));
  r.get('/agent/documents', (c) => agentDocuments(c, db));
  r.post('/agent/documents/:uid/access', (c) => agentAccess(c, db));
  r.put('/agent/documents/:uid', async (c) => agentAddDocument(c, db));

  return r;
}

// --- ring side --------------------------------------------------------

interface AgentWire {
  id: string;
  display_name: string;
  role: InviteRole;
  created_at: number;
  last_used_at: number | null;
  /** Documents it has been given an invite on so far. */
  documents: number;
  /** Only with `?doc=`: its standing on that document, null when the ring cannot delegate it. */
  document?: AgentDocumentRoleWire | null;
}

interface AgentDocumentRoleWire {
  role: InviteRole;
  /** False until the agent opens the document or a role is set here; `role` is then the key's. */
  invited: boolean;
  /** False once the role here was set apart from the key's: re-roling the key leaves it. */
  follows_key: boolean;
  /** The ring's admin link here was rotated elsewhere: the invite still works, its role can't change. */
  link_stale: boolean;
  /** The document shares its links with others in a folder, so a role set here covers them too. */
  folder: boolean;
}

function toAgentWire(db: Database, row: KeyringAgentRow): AgentWire {
  const { n } = db
    .prepare('SELECT count(*) AS n FROM keyring_agent_invites WHERE agent_id = ?')
    .get(row.id) as { n: number };
  return {
    id: row.id,
    display_name: row.display_name,
    role: row.role,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
    documents: n,
  };
}

function ringAgents(db: Database, ringToken: string): KeyringAgentRow[] {
  return db
    .prepare('SELECT * FROM keyring_agents WHERE keyring_token = ? ORDER BY created_at')
    .all(ringToken) as KeyringAgentRow[];
}

function listAgents(c: Context, db: Database) {
  const ring = readKeyringRow(db, c);
  if (!ring) return c.json({ error: 'not-found' }, 404);
  const docUid = c.req.query('doc');
  const gateUid = docUid ? gateOf(db, docUid) : null;
  const coverage = gateUid ? ringCoverage(db, ring.token, gateUid) : 'none';
  const folder =
    gateUid !== null &&
    (gateUid !== docUid ||
      db.prepare('SELECT 1 FROM documents WHERE folder_uid = ? LIMIT 1').get(gateUid) !== null);
  const agents = ringAgents(db, ring.token).map((a): AgentWire => {
    const wire = toAgentWire(db, a);
    if (!docUid) return wire;
    const invite = gateUid ? agentInvite(db, a.id, gateUid) : null;
    if (coverage === 'admin' || (coverage === 'stale' && invite)) {
      const document = {
        role: invite?.role ?? a.role,
        invited: invite !== null,
        follows_key: invite === null || invite.follows_key === 1,
        link_stale: coverage === 'stale',
        folder,
      };
      return { ...wire, document };
    }
    return { ...wire, document: null };
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ agents });
}

function readRingAgent(
  db: Database,
  c: Context,
): { ring: KeyringRow; agent: KeyringAgentRow } | null {
  const ring = readKeyringRow(db, c);
  if (!ring) return null;
  const agent = db
    .prepare('SELECT * FROM keyring_agents WHERE id = ? AND keyring_token = ?')
    .get(c.req.param('id') ?? '', ring.token) as KeyringAgentRow | undefined;
  return agent ? { ring, agent } : null;
}

function asAgentRole(value: unknown): InviteRole | null {
  return typeof value === 'string' && (AGENT_ROLES as readonly string[]).includes(value)
    ? (value as InviteRole)
    : null;
}

/**
 * Re-role a key. Its invites that follow it move along; one given another
 * role, here or in a document's access panel, was a choice for that
 * document and stays.
 */
async function updateAgent(c: Context, db: Database) {
  const found = readRingAgent(db, c);
  if (!found) return c.json({ error: 'not-found' }, 404);
  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  const role = asAgentRole(body.role);
  if (!role) return c.json({ error: 'invalid-role' }, 400);

  const { id } = found.agent;
  const updated = db.transaction(() => {
    // Re-read: the body was awaited, and a concurrent re-role may have landed.
    const agent = db.prepare('SELECT * FROM keyring_agents WHERE id = ?').get(id) as
      | KeyringAgentRow
      | undefined;
    if (!agent) return null;
    if (agent.role === role) return agent;
    db.prepare('UPDATE keyring_agents SET role = ? WHERE id = ?').run(role, id);
    const following = db
      .prepare(
        `SELECT invite_token FROM keyring_agent_invites WHERE agent_id = ? AND follows_key = 1`,
      )
      .all(id) as Array<{ invite_token: string }>;
    for (const { invite_token } of following) setInviteRole(db, invite_token, role);
    return { ...agent, role };
  })();
  if (!updated) return c.json({ error: 'not-found' }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json({ agent: toAgentWire(db, updated) });
}

/**
 * The key's role on one document (its whole folder, which shares one
 * set of links). Mints the invite when the agent has not opened the
 * document yet, so the role is waiting for it.
 */
async function setAgentDocumentRole(c: Context, db: Database) {
  const found = readRingAgent(db, c);
  if (!found) return c.json({ error: 'not-found' }, 404);
  const gateUid = gateOf(db, c.req.param('uid') ?? '');
  if (!gateUid) return c.json({ error: 'not-found' }, 404);
  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  const role = asAgentRole(body.role);
  if (!role) return c.json({ error: 'invalid-role' }, 400);

  const coverage = ringCoverage(db, found.ring.token, gateUid);
  if (coverage === 'none') return c.json({ error: 'not-in-keyring' }, 404);
  if (coverage === 'not-admin') return c.json({ error: 'not-delegable' }, 403);
  if (coverage === 'stale') return c.json({ error: 'keyring-link-stale' }, 409);

  const done = db.transaction(() => {
    // Re-read: the key may have been re-roled or revoked while the body was awaited.
    const agent = db.prepare('SELECT * FROM keyring_agents WHERE id = ?').get(found.agent.id) as
      | KeyringAgentRow
      | undefined;
    if (!agent) return false;
    const invite = agentInvite(db, agent.id, gateUid);
    if (invite) setInviteRole(db, invite.token, role);
    else mintAgentInvite(db, agent, found.ring, gateUid, role);
    return true;
  })();
  if (!done) return c.json({ error: 'not-found' }, 404);
  c.header('Cache-Control', 'no-store');
  return c.json({ role, invited: true });
}

async function createAgent(c: Context, db: Database) {
  const ring = readKeyringRow(db, c);
  if (!ring) return c.json({ error: 'not-found' }, 404);

  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  const displayName = normalizeAgentName(
    typeof body.display_name === 'string' ? body.display_name : null,
  );
  const role = body.role === undefined ? 'collaborator' : asAgentRole(body.role);
  if (!role) return c.json({ error: 'invalid-role' }, 400);

  const existing = ringAgents(db, ring.token);
  if (existing.length >= MAX_AGENTS_PER_RING) return c.json({ error: 'too-many-agents' }, 409);
  // Two keys under one name would put two participants called "Claude" on
  // the same document, indistinguishable in comments and @-mentions.
  if (existing.some((a) => a.display_name.toLowerCase() === displayName.toLowerCase())) {
    return c.json({ error: 'agent-name-taken' }, 409);
  }

  const key = newAgentKey();
  const row: KeyringAgentRow = {
    id: newAgentId(),
    key_hash: hashAgentKey(key),
    keyring_token: ring.token,
    display_name: displayName,
    role,
    created_at: Date.now(),
    last_used_at: null,
  };
  db.prepare(
    `INSERT INTO keyring_agents
       (id, key_hash, keyring_token, display_name, role, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(row.id, row.key_hash, row.keyring_token, row.display_name, row.role, row.created_at);

  c.header('Cache-Control', 'no-store');
  return c.json({ key, agent: toAgentWire(db, row) }, 201);
}

function deleteAgent(c: Context, db: Database) {
  const found = readRingAgent(db, c);
  if (!found) return c.json({ error: 'not-found' }, 404);
  revokeAgent(db, found.agent.id);
  return c.body(null, 204);
}

// --- agent side -------------------------------------------------------

interface AgentCaller {
  agent: KeyringAgentRow;
  ring: KeyringRow;
}

function readAgent(db: Database, c: Context): AgentCaller | null {
  const key = c.req.header(AGENT_KEY_HEADER);
  if (!key) return null;
  const agent = db
    .prepare('SELECT * FROM keyring_agents WHERE key_hash = ?')
    .get(hashAgentKey(key)) as KeyringAgentRow | undefined;
  if (!agent) return null;
  const ring = db.prepare('SELECT * FROM keyrings WHERE token = ?').get(agent.keyring_token) as
    | KeyringRow
    | undefined;
  if (!ring) return null;

  const now = Date.now();
  if (agent.last_used_at === null || now - agent.last_used_at > LAST_USED_INTERVAL_MS) {
    db.prepare('UPDATE keyring_agents SET last_used_at = ? WHERE id = ?').run(now, agent.id);
    agent.last_used_at = now;
  }
  // An agent working the ring is the ring in use, so it keeps the idle
  // sweep away as a device's pull would.
  touchKeyringIfStale(db, ring);
  return { agent, ring };
}

function agentSelf(c: Context, db: Database) {
  const caller = readAgent(db, c);
  if (!caller) return c.json({ error: 'agent-key-invalid' }, 401);
  c.header('Cache-Control', 'no-store');
  return c.json({ display_name: caller.agent.display_name, role: caller.agent.role });
}

interface AgentDocumentWire {
  doc_uid: string;
  title: string | null;
  format: DocumentFormat;
  folder_uid: string | null;
  password_protected: boolean;
  updated_at: number;
  /** The role the agent gets here, or null when the ring holds no admin link for it. */
  role: InviteRole | null;
  /** The ring's only links here no longer exist: rotated on a device that has not synced. */
  link_stale: boolean;
}

/**
 * The ring's documents, without a single token in them: the agent gets
 * access one document at a time through `/access`, so that every invite
 * it ends up holding is one the server minted for it and can revoke.
 */
function agentDocuments(c: Context, db: Database) {
  const caller = readAgent(db, c);
  if (!caller) return c.json({ error: 'agent-key-invalid' }, 401);

  const rows = db
    .prepare(
      `SELECT kd.doc_uid, COALESCE(kd.title, d.name) AS title, d.format, d.updated_at,
              d.folder_uid, gate.uid AS gate_uid, gate.password_hash, i.kind AS kind,
              mine.role AS agent_role
         FROM keyring_docs kd
         JOIN documents d ON d.uid = kd.doc_uid
         JOIN documents gate ON gate.uid = COALESCE(d.folder_uid, d.uid)
         LEFT JOIN invites i ON i.token = kd.invite_token AND i.doc_uid = gate.uid
         LEFT JOIN keyring_agent_invites ai ON ai.agent_id = ? AND ai.gate_uid = gate.uid
         LEFT JOIN invites mine ON mine.token = ai.invite_token AND mine.doc_uid = gate.uid
        WHERE kd.keyring_token = ?
        ORDER BY d.updated_at DESC`,
    )
    .all(caller.agent.id, caller.ring.token) as Array<{
    doc_uid: string;
    title: string | null;
    format: DocumentFormat;
    updated_at: number;
    folder_uid: string | null;
    gate_uid: string;
    password_hash: string | null;
    kind: string | null;
    agent_role: InviteRole | null;
  }>;
  // One admin link opens the whole folder, so coverage is per gate.
  const kindsByGate = new Map<string, Array<string | null>>();
  for (const r of rows)
    kindsByGate.set(r.gate_uid, [...(kindsByGate.get(r.gate_uid) ?? []), r.kind]);

  const docs: AgentDocumentWire[] = rows.map((r) => {
    const coverage = coverageOf(kindsByGate.get(r.gate_uid) ?? []);
    const role = coverage === 'admin' ? (r.agent_role ?? caller.agent.role) : null;
    return {
      doc_uid: r.doc_uid,
      title: r.title,
      format: r.format,
      folder_uid: r.folder_uid,
      password_protected: r.password_hash !== null,
      updated_at: r.updated_at,
      role,
      link_stale: coverage === 'stale',
    };
  });
  c.header('Cache-Control', 'no-store');
  return c.json({ display_name: caller.agent.display_name, role: caller.agent.role, docs });
}

/**
 * The agent's own invite on one document, minted on first use and reused
 * after. Re-minted when the old one is gone — an admin deleting it from
 * the access panel removes that link, not the key's standing to ask.
 */
function agentAccess(c: Context, db: Database) {
  const caller = readAgent(db, c);
  if (!caller) return c.json({ error: 'agent-key-invalid' }, 401);

  const gateUid = gateOf(db, c.req.param('uid') ?? '');
  if (!gateUid) return c.json({ error: 'not-found' }, 404);

  const coverage = ringCoverage(db, caller.ring.token, gateUid);
  if (coverage === 'none') return c.json({ error: 'not-in-keyring' }, 404);
  if (coverage === 'not-admin') return c.json({ error: 'not-delegable' }, 403);

  const { agent } = caller;
  const token = db.transaction(() => {
    const mapped = agentInvite(db, agent.id, gateUid);
    if (mapped) return mapped.token;
    // A dead admin link proves nothing about who administers the document
    // now, so it is good for keeping an invite but not for minting one.
    if (coverage === 'stale') return null;
    return mintAgentInvite(db, agent, caller.ring, gateUid, agent.role);
  })();
  if (!token) return c.json({ error: 'keyring-link-stale' }, 409);

  const role = (
    db.prepare('SELECT role FROM invites WHERE token = ?').get(token) as { role: InviteRole }
  ).role;
  c.header('Cache-Control', 'no-store');
  return c.json({ invite_token: token, role, gate_uid: gateUid });
}

/**
 * Record a document the agent created in the ring, so it reaches the
 * owner's devices. Only its admin link: that is what a creator holds, and
 * accepting anything else would let a key fill the ring with links to
 * documents nobody in it owns.
 */
async function agentAddDocument(c: Context, db: Database) {
  const caller = readAgent(db, c);
  if (!caller) return c.json({ error: 'agent-key-invalid' }, 401);

  const docUid = c.req.param('uid') ?? '';
  const body = await safeJson(c);
  if (!body) return c.json({ error: 'invalid-body' }, 400);
  const inviteToken = typeof body.invite_token === 'string' ? body.invite_token : '';
  const admin = db
    .prepare(
      `SELECT 1 FROM invites i
         JOIN documents d ON d.uid = ?
        WHERE i.token = ? AND i.kind = 'admin' AND i.doc_uid = COALESCE(d.folder_uid, d.uid)`,
    )
    .get(docUid, inviteToken);
  if (!admin) return c.json({ error: 'admin-invite-required' }, 403);

  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) || null : null;
  const outcome = upsertKeyringDoc(db, caller.ring.token, docUid, inviteToken, title);
  if (outcome === 'full') return c.json({ error: 'keyring-full' }, 409);
  renameAgentAdminLink(db, inviteToken, caller.agent.display_name, caller.ring.display_name);
  return c.json({ ok: true }, 200);
}

/**
 * Give an admin link the agent created to the ring's owner. An admin
 * link's name seeds whoever opens it first, so left as the agent's, the
 * owner's first visit would sign them as the agent. Only a link named
 * after the agent: one someone else handed it keeps its owner's name.
 */
function renameAgentAdminLink(
  db: Database,
  inviteToken: string,
  agentName: string,
  ownerName: string,
): void {
  db.prepare(
    `UPDATE invites SET display_name = ?
      WHERE token = ? AND kind = 'admin' AND lower(display_name) = lower(?)`,
  ).run(ownerName, inviteToken, agentName);
}

// --- invites ----------------------------------------------------------

function gateOf(db: Database, docUid: string): string | null {
  const doc = db.prepare('SELECT uid, folder_uid FROM documents WHERE uid = ?').get(docUid) as
    | { uid: string; folder_uid: string | null }
    | undefined;
  return doc ? (doc.folder_uid ?? doc.uid) : null;
}

/** The agent's live invite on a gate; a mapping whose invite was deleted counts as none. */
function agentInvite(
  db: Database,
  agentId: string,
  gateUid: string,
): { token: string; role: InviteRole; follows_key: number } | null {
  return (
    (db
      .prepare(
        `SELECT i.token, i.role, ai.follows_key FROM keyring_agent_invites ai
           JOIN invites i ON i.token = ai.invite_token AND i.doc_uid = ai.gate_uid
          WHERE ai.agent_id = ? AND ai.gate_uid = ?`,
      )
      .get(agentId, gateUid) as { token: string; role: InviteRole; follows_key: number } | null) ??
    null
  );
}

function mintAgentInvite(
  db: Database,
  agent: KeyringAgentRow,
  ring: KeyringRow,
  gateUid: string,
  role: InviteRole,
): string {
  const invite = createInviteRow(db, {
    docUid: gateUid,
    displayName: agent.display_name,
    role,
    kind: 'named',
    note: AGENT_INVITE_NOTE,
    createdByName: ring.display_name,
  });
  db.prepare(
    `INSERT INTO keyring_agent_invites (agent_id, gate_uid, invite_token, created_at, follows_key)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(agent_id, gate_uid)
       DO UPDATE SET invite_token = excluded.invite_token, created_at = excluded.created_at,
                     follows_key = excluded.follows_key`,
  ).run(agent.id, gateUid, invite.token, invite.created_at, role === agent.role ? 1 : 0);
  return invite.token;
}

// --- lifecycle --------------------------------------------------------

type RingCoverage = 'admin' | 'stale' | 'not-admin' | 'none';

/**
 * What a ring holds for a gate: a live admin link, only links that no
 * longer exist (rotated on a device that has not synced since), some
 * other live link, or nothing.
 */
function ringCoverage(db: Database, ringToken: string, gateUid: string): RingCoverage {
  const rows = db
    .prepare(
      `SELECT i.kind FROM keyring_docs kd
         JOIN documents d ON d.uid = kd.doc_uid
         LEFT JOIN invites i ON i.token = kd.invite_token AND i.doc_uid = ?
        WHERE kd.keyring_token = ? AND COALESCE(d.folder_uid, d.uid) = ?`,
    )
    .all(gateUid, ringToken, gateUid) as Array<{ kind: string | null }>;
  return coverageOf(rows.map((r) => r.kind));
}

function coverageOf(kinds: Array<string | null>): RingCoverage {
  if (kinds.length === 0) return 'none';
  if (kinds.includes('admin')) return 'admin';
  return kinds.every((k) => k === null) ? 'stale' : 'not-admin';
}

function deleteAgentInvite(db: Database, inviteToken: string): void {
  db.prepare('DELETE FROM invites WHERE token = ?').run(inviteToken);
  revokeInviteSessions(db, inviteToken);
}

/** Delete one agent and every invite minted for it. */
export function revokeAgent(db: Database, agentId: string): void {
  db.transaction(() => {
    const minted = db
      .prepare('SELECT invite_token FROM keyring_agent_invites WHERE agent_id = ?')
      .all(agentId) as Array<{ invite_token: string }>;
    for (const { invite_token } of minted) deleteAgentInvite(db, invite_token);
    db.prepare('DELETE FROM keyring_agent_invites WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM asset_upload_tickets WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM source_upload_tickets WHERE agent_id = ?').run(agentId);
    db.prepare('DELETE FROM keyring_agents WHERE id = ?').run(agentId);
  })();
}

/** A ring that ends takes its agents' access with it. */
export function revokeRingAgents(db: Database, ringToken: string): void {
  for (const agent of ringAgents(db, ringToken)) revokeAgent(db, agent.id);
}

/**
 * After a ring stops holding an admin link for a document — forgotten
 * ring-wide, or replaced by a lesser link — its agents lose their invites
 * there too. Agent access follows the ring; it never outlives it.
 */
export function revokeUncoveredAgentInvites(db: Database, ringToken: string, docUid: string): void {
  const gateUid = gateOf(db, docUid);
  if (!gateUid) return;
  if (ringCoverage(db, ringToken, gateUid) === 'admin') return;
  const minted = db
    .prepare(
      `SELECT ai.agent_id, ai.invite_token FROM keyring_agent_invites ai
         JOIN keyring_agents a ON a.id = ai.agent_id
        WHERE a.keyring_token = ? AND ai.gate_uid = ?`,
    )
    .all(ringToken, gateUid) as Array<{ agent_id: string; invite_token: string }>;
  db.transaction(() => {
    for (const row of minted) {
      deleteAgentInvite(db, row.invite_token);
      db.prepare('DELETE FROM keyring_agent_invites WHERE agent_id = ? AND gate_uid = ?').run(
        row.agent_id,
        gateUid,
      );
    }
  })();
}
