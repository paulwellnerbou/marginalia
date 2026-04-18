import { extname, isAbsolute, join, normalize, relative } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import type { ServerConfig } from './config.js';
import { openDatabase } from './db.js';
import { GitStore } from './git-store.js';
import { Realtime } from './realtime.js';
import { commentsRouter } from './routes/comments.js';
import { documentsRouter } from './routes/documents.js';
import { editProposalsRouter } from './routes/edit-proposals.js';
import { eventsRouter } from './routes/events.js';

export interface App {
  hono: Hono;
  websocket: ReturnType<typeof createBunWebSocket<ServerWebSocket>>['websocket'];
  close(): void;
}

export async function createApp(config: ServerConfig): Promise<App> {
  const db = openDatabase(config.dbPath);
  const store = new GitStore(config.repoDir);
  await store.init();
  const realtime = new Realtime();

  const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();

  const hono = new Hono();
  hono.get('/health', (c) => c.json({ ok: true }));
  const deps = { db, store, config, realtime };
  hono.route('/api/documents', documentsRouter(deps));
  hono.route('/api/documents', commentsRouter(deps));
  hono.route('/api/documents', editProposalsRouter(deps));
  hono.route('/api/documents', eventsRouter({ db, realtime, upgradeWebSocket }));
  hono.get('*', async (c) => {
    const fileResponse = await serveWebAsset(config.webDir, c.req.path);
    return fileResponse ?? c.notFound();
  });

  return {
    hono,
    websocket,
    close() {
      db.close();
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
