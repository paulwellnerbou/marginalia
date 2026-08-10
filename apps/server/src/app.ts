import type { Database } from 'bun:sqlite';
import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { HTTPException } from 'hono/http-exception';
import { createBlobStore } from './blob-store.js';
import type { ServerConfig } from './config.js';
import { dropLegacyProposalColumns, openDatabase } from './db.js';
import { closeExportBrowser } from './export/pdf.js';
import { GitStore } from './git-store.js';
import { backfillProposalBranches } from './proposal-branch-backfill.js';
import { Realtime } from './realtime.js';
import { assetsRouter } from './routes/assets.js';
import { documentsRouter } from './routes/documents.js';
import { eventsRouter } from './routes/events.js';
import { keyringsRouter } from './routes/keyrings.js';
import { mcpRouter } from './routes/mcp.js';
import { threadsRouter } from './routes/threads.js';

export interface App {
  hono: Hono;
  websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>['websocket'];
  /** Exposed for tests that need to assert direct DB state. */
  db: Database;
  /** Exposed for tests that need to inspect raw git history. */
  store: GitStore;
  /**
   * Tears down the app's long-lived resources: the SQLite handle and
   * the shared PDF export Chromium (if it was ever started).
   *
   * Always returns a promise — callers should `await` it so teardown
   * ordering stays deterministic (especially in tests, where an
   * un-awaited browser close can leak a process into the next case
   * and flake the semaphore). The DB close is synchronous; the
   * browser close is the part worth awaiting.
   */
  close(): Promise<void>;
}

export async function createApp(config: ServerConfig): Promise<App> {
  const db = openDatabase(config.dbPath);
  const store = new GitStore(config.reposDir);
  await store.init();
  const backfill = await backfillProposalBranches(db, store);
  if (backfill.skipped > 0) {
    // Proposals whose anchor block isn't locatable in the current
    // source can't be backfilled. After the column drop their content
    // is lost permanently — surface the count so operators can audit
    // before/after a deploy.
    console.warn(
      `[marginalia] proposal-branch backfill skipped ${backfill.skipped} row(s); their proposed_text/source_snapshot will be discarded by the column drop`,
    );
  }
  // Backfill must run before this — it reads `proposed_text`. After,
  // those columns are dead.
  dropLegacyProposalColumns(db);
  const blobs = createBlobStore(config);
  const realtime = new Realtime();

  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

  const hono = new Hono();
  // Hono's default answer to an unhandled throw is plain-text "Internal
  // Server Error". Every other failure here is `{ error: <code> }`, and
  // the web client only knows how to read that shape — a text body
  // leaves it with no code at all, which surfaces to the reader as the
  // word "unknown". Keep the envelope even when we have nothing better
  // to say than "internal".
  hono.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    console.error(`[marginalia] unhandled error on ${c.req.method} ${c.req.path}`, err);
    return c.json({ error: 'internal' }, 500);
  });
  hono.get('/health', (c) => c.json({ ok: true }));
  hono.get('/api/version', (c) => {
    // This endpoint is polled specifically to discover a newly deployed
    // server, so every intermediary must revalidate it.
    c.header('Cache-Control', 'no-store, max-age=0');
    return c.json({ releaseVersion: config.releaseVersion });
  });
  const deps = { db, store, blobs, config, realtime };
  hono.route('/api/documents', documentsRouter(deps));
  hono.route('/api/documents', assetsRouter({ db, blobs, config }));
  hono.route('/api/documents', threadsRouter(deps));
  hono.route('/api/documents', eventsRouter({ db, realtime, upgradeWebSocket }));
  // Mounted at /api rather than /api/keyrings because redeeming a
  // pairing code is by definition not a request from a device that has
  // a keyring, so it lives outside that prefix.
  hono.route('/api', keyringsRouter({ db, config }));
  // Marginalia's own MCP endpoint. Mounted after the API routes because
  // it dispatches tool calls back through this same app.
  hono.route('/mcp', mcpRouter({ hono }));
  hono.get('*', async (c) => {
    const fileResponse = await serveWebAsset(config.webDir, c.req.path);
    return fileResponse ?? c.notFound();
  });

  return {
    hono,
    websocket,
    db,
    store,
    async close() {
      db.close();
      // The PDF export browser is a module-level singleton shared
      // across App instances in a process. Closing it here is mostly
      // for tests (which spin up an App per test case) and `bun --hot`
      // reloads — production relies on SIGTERM taking down the whole
      // process tree, including the Chromium children.
      await closeExportBrowser();
    },
  };
}

async function serveWebAsset(rootDir: string, requestPath: string): Promise<Response | null> {
  const assetPath = toAssetPath(rootDir, requestPath);
  if (assetPath) {
    const asset = Bun.file(assetPath);
    if (await asset.exists()) {
      return new Response(asset);
    }
  }

  if (extname(requestPath) !== '') return null;

  const indexFile = Bun.file(join(rootDir, 'index.html'));
  if (!(await indexFile.exists())) return null;

  return new Response(indexFile, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
    },
  });
}

function toAssetPath(rootDir: string, requestPath: string): string | null {
  const normalizedPath = safeDecodePath(requestPath).replace(/^\/+/, '');
  const candidate = normalize(join(rootDir, normalizedPath === '' ? 'index.html' : normalizedPath));
  const rel = relative(rootDir, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return candidate;
}

function safeDecodePath(requestPath: string): string {
  try {
    return decodeURIComponent(requestPath);
  } catch {
    return requestPath;
  }
}
