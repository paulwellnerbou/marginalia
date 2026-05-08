import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBlobStore, FsBlobStore, S3BlobStore, sha256Hex } from '../src/blob-store.js';

describe('FsBlobStore', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-blobs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('put round-trips through get + has + delete', async () => {
    const store = new FsBlobStore(dir);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const key = await store.put(bytes);
    expect(key).toBe(sha256Hex(bytes));
    expect(await store.has(key)).toBe(true);
    const read = await store.get(key);
    expect(read.length).toBe(bytes.length);
    for (let i = 0; i < bytes.length; i++) expect(read[i]).toBe(bytes[i]!);
    await store.delete(key);
    expect(await store.has(key)).toBe(false);
  });

  test('put is content-addressed: identical bytes → same key, one file', async () => {
    const store = new FsBlobStore(dir);
    const bytes = new Uint8Array([7, 7, 7]);
    const k1 = await store.put(bytes);
    const k2 = await store.put(bytes);
    expect(k1).toBe(k2);
    expect(await store.has(k1)).toBe(true);
  });

  test('delete on a missing key is a no-op', async () => {
    const store = new FsBlobStore(dir);
    await store.delete('0000000000000000000000000000000000000000000000000000000000000000');
  });
});

describe('createBlobStore factory', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mdn-blobs-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('blobStorage=fs picks FsBlobStore and works', async () => {
    const store = createBlobStore({ blobStorage: 'fs', blobDir: dir });
    expect(store).toBeInstanceOf(FsBlobStore);
    const key = await store.put(new Uint8Array([1]));
    expect(key).toHaveLength(64);
  });

  test('blobStorage=s3 constructs S3BlobStore when config is present', () => {
    const store = createBlobStore({
      blobStorage: 's3',
      blobDir: dir,
      s3: {
        bucket: 'test-bucket',
        accessKeyId: 'AKIA',
        secretAccessKey: 'SECRET',
        endpoint: 'http://localhost:9000',
      },
    });
    // We can't hit a real endpoint in CI — just check the factory wired
    // the right class. End-to-end S3 coverage lives with whoever runs a
    // MinIO instance.
    expect(store).toBeInstanceOf(S3BlobStore);
  });

  test('blobStorage=s3 with no s3 block throws a clear error', () => {
    expect(() => createBlobStore({ blobStorage: 's3', blobDir: dir })).toThrow(/blobStorage=s3/);
  });
});
