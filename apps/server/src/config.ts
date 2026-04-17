import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  port: number;
  dataDir: string;
  repoDir: string;
  dbPath: string;
  webDir: string;
  sessionTtlMs: number;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir =
    overrides.dataDir ??
    process.env.MARGINALIA_DATA_DIR ??
    'var';
  const webDir =
    overrides.webDir ??
    process.env.MARGINALIA_WEB_DIR ??
    fileURLToPath(new URL('../../web/dist', import.meta.url));
  return {
    port: overrides.port ?? Number(process.env.PORT ?? 3434),
    dataDir,
    repoDir: overrides.repoDir ?? join(dataDir, 'repo'),
    dbPath: overrides.dbPath ?? join(dataDir, 'db.sqlite'),
    webDir,
    sessionTtlMs: overrides.sessionTtlMs ?? 24 * 60 * 60 * 1000, // 24h
  };
}
