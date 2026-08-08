import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrustedProxyHops } from './rate-limit.js';

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
  /**
   * How long a device-pairing code stays redeemable. Short on purpose:
   * the code is displayed on screen and hands over a keyring, so its
   * window is the window in which a shoulder-surfed glance is worth
   * anything. Default 5 minutes.
   */
  keyringPairingTtlMs: number;
  /**
   * How long a keyring survives with no device pulling or changing it
   * before it is swept along with its copies of that person's invite
   * tokens. Long by design — this is a "nobody came back" signal, not a
   * session timeout, and the cost of guessing wrong is a re-pair rather
   * than lost access. Default 180 days.
   */
  keyringIdleTtlMs: number;
  /**
   * How many reverse proxies we control sit in front, and therefore how
   * far from the right of `X-Forwarded-For` the real client is. 0 means
   * trust nothing and key on the connecting address. See
   * `parseTrustedProxyHops`.
   */
  trustedProxyHops: number;
  /** Failed pairing redemptions tolerated per client per window. */
  pairingRedeemPerClient: number;
  /**
   * Failed pairing redemptions tolerated server-wide per window. The
   * backstop that survives a spoofed `X-Forwarded-For`, a misconfigured
   * `trustedProxyHops`, or a distributed attempt — none of which the per-client
   * limit can see.
   */
  pairingRedeemGlobal: number;
  pairingRedeemWindowMs: number;
  /** Keyring creations tolerated per client per window. */
  keyringCreatePerClient: number;
  keyringCreateWindowMs: number;
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
    keyringPairingTtlMs: overrides.keyringPairingTtlMs ?? 5 * 60 * 1000, // 5min
    keyringIdleTtlMs: overrides.keyringIdleTtlMs ?? 180 * 24 * 60 * 60 * 1000, // 180d
    trustedProxyHops:
      overrides.trustedProxyHops ??
      parseTrustedProxyHops(process.env.MARGINALIA_TRUSTED_PROXY_HOPS),
    // 10 wrong codes from one client per 10 minutes. A person mistyping
    // eight characters off a screen needs two or three; a search needs
    // billions.
    pairingRedeemPerClient: overrides.pairingRedeemPerClient ?? 10,
    // Generous enough that a real user is never blocked by other
    // people's failures, and still ~5 orders of magnitude below what
    // guessing a 40-bit code inside its 5-minute life would take.
    pairingRedeemGlobal: overrides.pairingRedeemGlobal ?? 200,
    pairingRedeemWindowMs: overrides.pairingRedeemWindowMs ?? 10 * 60 * 1000, // 10min
    keyringCreatePerClient: overrides.keyringCreatePerClient ?? 20,
    keyringCreateWindowMs: overrides.keyringCreateWindowMs ?? 60 * 60 * 1000, // 1h
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
