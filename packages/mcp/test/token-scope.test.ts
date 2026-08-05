import { describe, expect, test } from 'bun:test';
import { MarginaliaClient } from '../src/client.js';
import type { McpConfig } from '../src/config.js';
import { McpState } from '../src/state.js';

/**
 * A token is a capability for one instance. These assert what actually
 * goes on the wire, because the failure mode is silent: the request
 * succeeds either way, it just carries the agent's invite somewhere it
 * was never meant to go.
 */
describe('token scoping', () => {
  const UID = 'AAAAAAAAAAAAAAAAAAAAAA';
  const CONNECTION_TOKEN = 'CONNECTION_TOKEN_aaaa';

  function harness(overrides: Partial<McpConfig> = {}) {
    const sent: Array<{ host: string; invite: string | null }> = [];
    const config: McpConfig = {
      baseUrl: 'https://marg.example',
      displayName: 'Claude',
      clientId: 'cid-12345678',
      allowedHosts: [],
      password: null,
      defaultToken: CONNECTION_TOKEN,
      stateDir: null,
      downloadDir: '',
      ...overrides,
    };
    const client = new MarginaliaClient(
      config,
      new McpState(null, 'cid-12345678'),
      async (input, init) => {
        sent.push({
          host: new URL(String(input)).host,
          invite: new Headers(init?.headers).get('x-marginalia-invite'),
        });
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      },
    );
    const visit = async (ref: string) => {
      await client.json(client.resolve(ref), '/api/x');
      return sent[sent.length - 1] as { host: string; invite: string | null };
    };
    return { visit };
  }

  test('the connection token reaches its own instance', async () => {
    const { visit } = harness();
    expect(await visit(`https://marg.example/d/${UID}`)).toEqual({
      host: 'marg.example',
      invite: CONNECTION_TOKEN,
    });
    // A bare uid means the configured instance, so it travels there too.
    expect(await visit(UID)).toEqual({ host: 'marg.example', invite: CONNECTION_TOKEN });
  });

  test('it never reaches another host', async () => {
    const { visit } = harness();
    // A document's own text can talk an agent into fetching a URL, so a
    // tokenless absolute reference elsewhere must carry nothing.
    expect(await visit(`https://evil.example/d/${UID}`)).toEqual({
      host: 'evil.example',
      invite: null,
    });
  });

  test('a cross-host reference cannot make a later bare uid carry the token', async () => {
    const { visit } = harness();
    await visit(`https://marg.example/d/${UID}/REMEMBERED_TOKEN_aaa`);
    await visit(`https://evil.example/d/${UID}`);
    // The remembered entry followed the reference to the other origin;
    // the capability filed against it must not have come along.
    expect(await visit(UID)).toEqual({ host: 'evil.example', invite: null });
  });

  test('a remembered token still serves the instance it belongs to', async () => {
    const { visit } = harness();
    await visit(`https://marg.example/d/${UID}/REMEMBERED_TOKEN_aaa`);
    expect(await visit(`https://marg.example/d/${UID}`)).toEqual({
      host: 'marg.example',
      invite: 'REMEMBERED_TOKEN_aaa',
    });
  });

  test('an explicit token in the reference always wins', async () => {
    const { visit } = harness();
    expect(await visit(`https://marg.example/d/${UID}/EXPLICIT_TOKEN_aaaa`)).toEqual({
      host: 'marg.example',
      invite: 'EXPLICIT_TOKEN_aaaa',
    });
  });

  test('an allowlist stops the cross-host request outright', async () => {
    const { visit } = harness({ allowedHosts: ['marg.example'] });
    await expect(visit(`https://evil.example/d/${UID}`)).rejects.toThrow(
      /not in MARGINALIA_ALLOWED_HOSTS/,
    );
  });
});
