import { afterEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const originalDataDir = process.env.MARGINALIA_DATA_DIR;
const originalReleaseVersion = process.env.MARGINALIA_RELEASE_VERSION;

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.MARGINALIA_DATA_DIR;
  } else {
    process.env.MARGINALIA_DATA_DIR = originalDataDir;
  }
  if (originalReleaseVersion === undefined) {
    delete process.env.MARGINALIA_RELEASE_VERSION;
  } else {
    process.env.MARGINALIA_RELEASE_VERSION = originalReleaseVersion;
  }
});

describe('loadConfig', () => {
  test('defaults dataDir to the repo-root .data directory', () => {
    delete process.env.MARGINALIA_DATA_DIR;

    const config = loadConfig();

    expect(config.dataDir).toBe(fileURLToPath(new URL('../../../.data', import.meta.url)));
  });

  test('exposes a normalized short release hash', () => {
    process.env.MARGINALIA_RELEASE_VERSION = ' ABCDEF0123456789 ';

    expect(loadConfig().releaseVersion).toBe('abcdef0');
  });

  test('normalizes an overridden release hash through the same path', () => {
    process.env.MARGINALIA_RELEASE_VERSION = '1111111111111111';

    expect(loadConfig({ releaseVersion: ' FEDCBA9876543210 ' }).releaseVersion).toBe('fedcba9');
  });
});
