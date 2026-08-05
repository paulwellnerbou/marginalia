import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMcpConfig } from '../src/config.js';
import { McpState } from '../src/state.js';

describe('McpState', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-state-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('keeps the same client id across restarts', () => {
    const first = new McpState(dir, null).getClientId();
    expect(new McpState(dir, null).getClientId()).toBe(first);
  });

  test('an explicit client id wins over the persisted one', () => {
    new McpState(dir, null);
    expect(new McpState(dir, 'forced-client-id').getClientId()).toBe('forced-client-id');
  });

  test('remembers a document’s instance and token', () => {
    const state = new McpState(dir, null);
    state.remember('doc1', { baseUrl: 'https://m.example', token: 'tok' });
    expect(new McpState(dir, null).recall('doc1')).toEqual({
      baseUrl: 'https://m.example',
      token: 'tok',
    });
  });

  test('a later tokenless reference does not erase the stored token', () => {
    const state = new McpState(dir, null);
    state.remember('doc1', { baseUrl: 'https://m.example', token: 'tok' });
    state.remember('doc1', { baseUrl: 'https://m.example', token: null });
    expect(state.recall('doc1')?.token).toBe('tok');
  });

  test('writes the state file owner-only', () => {
    new McpState(dir, null);
    const mode = statSync(join(dir, 'state.json')).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test('drops entries whose fields are not strings', async () => {
    const file = join(dir, 'state.json');
    await Bun.write(
      file,
      JSON.stringify({
        clientId: 'a-persisted-client-id',
        documents: {
          good: { baseUrl: 'https://m.example', token: 'tok' },
          numericToken: { baseUrl: 'https://m.example', token: 42 },
          noToken: { baseUrl: 'https://m.example' },
          badBase: { baseUrl: 7, token: 'tok' },
          notAnObject: 'nonsense',
        },
      }),
    );
    const state = new McpState(dir, null);
    expect(state.recall('good')?.token).toBe('tok');
    // A non-string token must never reach an HTTP header.
    expect(state.recall('numericToken')).toEqual({ baseUrl: 'https://m.example', token: null });
    expect(state.recall('noToken')?.token).toBeNull();
    expect(state.recall('badBase')).toBeNull();
    expect(state.recall('notAnObject')).toBeNull();
  });

  test('survives a corrupt state file by starting fresh', () => {
    const file = join(dir, 'state.json');
    Bun.write(file, 'not json');
    const state = new McpState(dir, null);
    expect(state.getClientId().length).toBeGreaterThan(8);
    expect(JSON.parse(readFileSync(file, 'utf8')).clientId).toBe(state.getClientId());
  });

  test('holds everything in memory when persistence is off', () => {
    const state = new McpState(null, null);
    state.remember('doc1', { baseUrl: 'https://m.example', token: 'tok' });
    expect(state.path).toBeNull();
    expect(state.recall('doc1')?.token).toBe('tok');
  });
});

describe('loadMcpConfig', () => {
  test('defaults to a local instance and the name Claude', () => {
    const config = loadMcpConfig({});
    expect(config.baseUrl).toBe('http://localhost:3434');
    expect(config.displayName).toBe('Claude');
    expect(config.allowedHosts).toEqual([]);
  });

  test('normalizes a base URL with a path or trailing slash to its origin', () => {
    expect(loadMcpConfig({ MARGINALIA_BASE_URL: 'https://m.example/d/x/' }).baseUrl).toBe(
      'https://m.example',
    );
    expect(loadMcpConfig({ MARGINALIA_BASE_URL: 'm.example' }).baseUrl).toBe('https://m.example');
  });

  test('parses the host allowlist', () => {
    expect(
      loadMcpConfig({ MARGINALIA_ALLOWED_HOSTS: 'A.example, b.example ,' }).allowedHosts,
    ).toEqual(['a.example', 'b.example']);
  });

  test('MARGINALIA_MCP_NO_PERSIST disables the state file', () => {
    expect(loadMcpConfig({ MARGINALIA_MCP_NO_PERSIST: '1' }).stateDir).toBeNull();
    expect(loadMcpConfig({}).stateDir).not.toBeNull();
  });
});
