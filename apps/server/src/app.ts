import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { createBlobStore } from './blob-store.js';
import type { ServerConfig } from './config.js';
import { openDatabase } from './db.js';
import { GitStore } from './git-store.js';
import { Realtime } from './realtime.js';
import { closeExportBrowser } from './export/pdf.js';
import { assetsRouter } from './routes/assets.js';
import { documentsRouter } from './routes/documents.js';
import { eventsRouter } from './routes/events.js';
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
  const store = new GitStore(config.repoDir);
  await store.init();
  const blobs = createBlobStore(config);
  const realtime = new Realtime();

  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

  const hono = new Hono();
  hono.get('/health', (c) => c.json({ ok: true }));
  const deps = { db, store, blobs, config, realtime };
  hono.route('/api/documents', documentsRouter(deps));
  hono.route('/api/documents', assetsRouter({ db, blobs, config }));
  hono.route('/api/documents', threadsRouter(deps));
  hono.route('/api/documents', eventsRouter({ db, realtime, upgradeWebSocket }));
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
