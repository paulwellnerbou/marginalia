import { join } from 'node:path';

export interface ServerConfig {
  port: number;
  dataDir: string;
  repoDir: string;
  dbPath: string;
  sessionTtlMs: number;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir = overrides.dataDir ?? process.env.MARKDOWNER_DATA_DIR ?? 'var';
  return {
    port: overrides.port ?? Number(process.env.PORT ?? 3434),
    dataDir,
    repoDir: overrides.repoDir ?? join(dataDir, 'repo'),
    dbPath: overrides.dbPath ?? join(dataDir, 'db.sqlite'),
    sessionTtlMs: overrides.sessionTtlMs ?? 24 * 60 * 60 * 1000, // 24h
  };
}
