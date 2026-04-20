import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { S3Client, type S3Options } from 'bun';

/**
 * Content-addressed blob store. Keys are sha256 of the bytes, so two
 * documents referencing the same image share one stored blob. Per-document
 * authorization lives on top (see `document_assets`) — this layer never
 * enforces access itself; it just moves bytes.
 *
 * `FsBlobStore` writes to a local directory (default; zero-config).
 * `S3BlobStore` targets any S3-compatible endpoint (AWS S3, Cloudflare R2,
 * MinIO, Backblaze B2). Both conform to the same interface.
 */
export interface BlobStore {
  /** Hash + store bytes. Returns the content hash (hex sha256). */
  put(bytes: Uint8Array): Promise<string>;
  /** Read bytes by hash. Throws if missing. */
  get(key: string): Promise<Uint8Array>;
  /** Returns true if a blob exists; false otherwise. No-throw. */
  has(key: string): Promise<boolean>;
  /** Best-effort delete; no error if the blob wasn't there. */
  delete(key: string): Promise<void>;
}

/** Shelf layout: `<root>/<sha[0:2]>/<sha>` — one level of sharding. */
export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  async put(bytes: Uint8Array): Promise<string> {
    const key = sha256Hex(bytes);
    const path = this.pathFor(key);
    if (!existsSync(path)) {
      mkdirSync(join(this.root, key.slice(0, 2)), { recursive: true });
      writeFileSync(path, bytes);
    }
    return key;
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(readFileSync(this.pathFor(key)));
  }

  async has(key: string): Promise<boolean> {
    return existsSync(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key);
    if (existsSync(path)) rmSync(path, { force: true });
  }

  private pathFor(key: string): string {
    return join(this.root, key.slice(0, 2), key);
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  const h = createHash('sha256');
  h.update(bytes);
  return h.digest('hex');
}

export interface S3BlobStoreOptions {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Custom endpoint (MinIO, R2, Backblaze…). Omit for AWS S3. */
  endpoint?: string;
  /** AWS region. Many S3-compatible providers don't care; pass 'auto'. */
  region?: string;
  /**
   * Optional key prefix applied to every blob path. Lets one bucket hold
   * multiple deployments without collision (e.g. `prefix: 'prod/blobs/'`).
   * Trailing slash is added automatically.
   */
  prefix?: string;
  /**
   * Force virtual-hosted URL style (`<bucket>.s3.region.amazonaws.com`).
   * Needed for some providers; most S3-compatible endpoints work with the
   * path-style default.
   */
  virtualHostedStyle?: boolean;
}

/**
 * Object-store backend. Keys become bucket object paths:
 * `<prefix><sha[0:2]>/<sha>`. Same sharding as the FS store so switching
 * between the two during a migration is a 1:1 mapping on the keys side.
 *
 * Reads the full object into memory before returning — fine for the
 * configured 16 MiB upload ceiling and the typical image/include sizes
 * this store sees. If we ever support large attachments, add a `stream()`
 * variant to the BlobStore interface rather than widening this one.
 */
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(opts: S3BlobStoreOptions) {
    const clientOpts: S3Options = {
      bucket: opts.bucket,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
    };
    if (opts.endpoint) clientOpts.endpoint = opts.endpoint;
    if (opts.region) clientOpts.region = opts.region;
    if (opts.virtualHostedStyle) clientOpts.virtualHostedStyle = true;
    this.client = new S3Client(clientOpts);
    this.prefix = normalizePrefix(opts.prefix);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const key = sha256Hex(bytes);
    const path = this.pathFor(key);
    // Skip the round-trip if the blob is already there — content-addressed
    // storage: identical bytes → identical key → no rewrite needed. Saves a
    // network PUT and avoids a latent race where two uploads compete for
    // the same key.
    if (await this.client.exists(path)) return key;
    await this.client.write(path, bytes);
    return key;
  }

  async get(key: string): Promise<Uint8Array> {
    const file = this.client.file(this.pathFor(key));
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  async has(key: string): Promise<boolean> {
    return this.client.exists(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    // S3 DELETE is idempotent — deleting a non-existent key is a 204. No
    // need to probe with exists() first.
    await this.client.delete(this.pathFor(key));
  }

  private pathFor(key: string): string {
    return `${this.prefix}${key.slice(0, 2)}/${key}`;
  }
}

function normalizePrefix(raw: string | undefined): string {
  if (!raw) return '';
  const stripped = raw.replace(/^\/+/, '');
  return stripped.endsWith('/') ? stripped : `${stripped}/`;
}

/**
 * Pick a BlobStore implementation from the server config. Kept here (not
 * in `app.ts`) so tests can swap in a test double via the same factory
 * without dragging Bun's S3 client into the import graph of pure-JS
 * renderer tests.
 */
export function createBlobStore(config: {
  blobStorage: 'fs' | 's3';
  blobDir: string;
  s3?: S3BlobStoreOptions;
}): BlobStore {
  if (config.blobStorage === 's3') {
    if (!config.s3) {
      throw new Error('blobStorage=s3 but no s3 config provided');
    }
    return new S3BlobStore(config.s3);
  }
  return new FsBlobStore(config.blobDir);
}
