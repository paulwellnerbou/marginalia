import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp(config);

const server = Bun.serve({
  port: config.port,
  fetch: app.hono.fetch,
});

console.log(`markdowner server listening on http://localhost:${server.port}`);
console.log(`  data dir: ${config.dataDir}`);
