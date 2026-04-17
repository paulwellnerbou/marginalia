import { Hono } from 'hono';
import { openDatabase } from './db.js';
import { GitStore } from './git-store.js';
import { documentsRouter } from './routes/documents.js';
import { commentsRouter } from './routes/comments.js';
import type { ServerConfig } from './config.js';

export interface App {
  hono: Hono;
  close(): void;
}

export async function createApp(config: ServerConfig): Promise<App> {
  const db = openDatabase(config.dbPath);
  const store = new GitStore(config.repoDir);
  await store.init();

  const hono = new Hono();
  hono.get('/health', (c) => c.json({ ok: true }));
  const deps = { db, store, config };
  hono.route('/api/documents', documentsRouter(deps));
  hono.route('/api/documents', commentsRouter(deps));

  return {
    hono,
    close() {
      db.close();
    },
  };
}
