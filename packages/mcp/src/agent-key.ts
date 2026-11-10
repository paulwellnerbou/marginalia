import { createHash } from 'node:crypto';
import type { FetchLike } from './client.js';
import type { McpConfig } from './config.js';
import { normalizeAgentName } from './identity.js';

export const AGENT_KEY_HEADER = 'x-marginalia-agent-key';

/**
 * The client id an agent key acts under: stable across reconnects and
 * between the hosted and stdio servers, and distinct per key, so two
 * agents never share comment ownership just because they share a name.
 * One-way, so the id stored beside comments says nothing about the key.
 */
export function agentKeyClientId(key: string): string {
  const digest = createHash('sha256').update(`marginalia-agent-client:${key}`).digest('hex');
  return `mcp-${digest.slice(0, 28)}`;
}

/**
 * Take the display name from the key, so the name a document's invite was
 * minted under and the name the agent signs with cannot drift apart. A
 * key the server rejects leaves the config as it is: the tools then
 * report the rejection where it matters, instead of failing to start.
 */
export async function adoptAgentIdentity(
  config: McpConfig,
  fetchImpl: FetchLike = fetch,
): Promise<McpConfig> {
  if (!config.agentKey) return config;
  try {
    const res = await fetchImpl(new URL('/api/agent/self', config.baseUrl), {
      headers: { [AGENT_KEY_HEADER]: config.agentKey },
    });
    if (!res.ok) return config;
    const body = (await res.json()) as { display_name?: unknown };
    if (typeof body.display_name !== 'string') return config;
    return { ...config, displayName: normalizeAgentName(body.display_name) };
  } catch {
    return config;
  }
}
