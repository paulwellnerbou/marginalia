import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ServerConfig {
  port: number;
  dataDir: string;
  /** Base directory for per-document git repos. Each doc lives at `<reposDir>/<uid>/`. */
  reposDir: string;
  blobDir: string;
  dbPath: string;
  webDir: string;
  sessionTtlMs: number;
  /** TTL for invite sessions created by POST /invites/:token/claim. Default 90 days. */
  namedInviteSessionTtlMs: number;
  /** Upload size ceiling for asset binaries. Defaults to 16 MiB. */
  maxAssetBytes: number;
  /**
   * Where blob bytes live. `fs` stores them under `dataDir/blobs/` — the
   * default, zero-config path. `s3` delegates to any S3-compatible
   * endpoint; credentials + bucket come from the `s3` field (or
   * MARGINALIA_S3_* env vars).
   */
  blobStorage: 'fs' | 's3';
  s3?: S3StorageConfig;
}

export interface S3StorageConfig {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  region?: string;
  /** Optional key prefix so one bucket can host multiple deployments. */
  prefix?: string;
  virtualHostedStyle?: boolean;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDir =
    overrides.dataDir ??
    process.env.MARGINALIA_DATA_DIR ??
    fileURLToPath(new URL('../../../.data', import.meta.url));
  const webDir =
    overrides.webDir ??
    process.env.MARGINALIA_WEB_DIR ??
    fileURLToPath(new URL('../../web/dist', import.meta.url));
  const blobStorage = overrides.blobStorage ?? parseBlobStorageEnv();
  const s3 = overrides.s3 ?? (blobStorage === 's3' ? loadS3ConfigFromEnv() : undefined);
  return {
    port: overrides.port ?? Number(process.env.PORT ?? 3434),
    dataDir,
    reposDir: overrides.reposDir ?? join(dataDir, 'repos'),
    blobDir: overrides.blobDir ?? join(dataDir, 'blobs'),
    dbPath: overrides.dbPath ?? join(dataDir, 'db.sqlite'),
    webDir,
    sessionTtlMs: overrides.sessionTtlMs ?? 24 * 60 * 60 * 1000, // 24h
    namedInviteSessionTtlMs: overrides.namedInviteSessionTtlMs ?? 90 * 24 * 60 * 60 * 1000, // 90d
    maxAssetBytes: overrides.maxAssetBytes ?? 16 * 1024 * 1024,
    blobStorage,
    ...(s3 ? { s3 } : {}),
  };
}

/**
 * Parse `MARGINALIA_BLOB_STORAGE`. Unset / empty → `fs` (the default).
 * `fs` / `s3` accepted case-insensitively with surrounding whitespace
 * tolerated — common shell/env-file mishaps (`S3`, `s3\n`, `fs `)
 * shouldn't silently land a production deploy on the wrong backend.
 * Anything else throws at startup so the misconfiguration is obvious.
 */
function parseBlobStorageEnv(): 'fs' | 's3' {
  const raw = process.env.MARGINALIA_BLOB_STORAGE;
  if (raw === undefined) return 'fs';
  const normalized = raw.trim().toLowerCase();
  if (normalized === '' || normalized === 'fs') return 'fs';
  if (normalized === 's3') return 's3';
  throw new Error(`MARGINALIA_BLOB_STORAGE must be "fs" or "s3" (got: ${JSON.stringify(raw)}).`);
}

/**
 * Read S3 credentials + bucket settings from env. Required when
 * `MARGINALIA_BLOB_STORAGE=s3`; throws early on startup with a clear
 * message if anything is missing. That's deliberately louder than a 500
 * on the first upload.
 */
function loadS3ConfigFromEnv(): S3StorageConfig {
  const bucket = requireEnv('MARGINALIA_S3_BUCKET');
  const accessKeyId = requireEnv('MARGINALIA_S3_ACCESS_KEY_ID');
  const secretAccessKey = requireEnv('MARGINALIA_S3_SECRET_ACCESS_KEY');
  const out: S3StorageConfig = { bucket, accessKeyId, secretAccessKey };
  if (process.env.MARGINALIA_S3_ENDPOINT) out.endpoint = process.env.MARGINALIA_S3_ENDPOINT;
  if (process.env.MARGINALIA_S3_REGION) out.region = process.env.MARGINALIA_S3_REGION;
  if (process.env.MARGINALIA_S3_PREFIX) out.prefix = process.env.MARGINALIA_S3_PREFIX;
  if (process.env.MARGINALIA_S3_VIRTUAL_HOSTED === '1') out.virtualHostedStyle = true;
  return out;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`MARGINALIA_BLOB_STORAGE=s3 requires ${name} (see README for S3 config).`);
  }
  return v;
}
