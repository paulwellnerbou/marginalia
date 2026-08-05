import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_AGENT_NAME,
  MAX_DISPLAY_NAME_LENGTH,
  normalizeAgentName,
} from '@marginalia/mcp/identity';

/**
 * The MCP panel mints an agent's invite and writes its connection URL,
 * and the server normalizes the name again on the way in. These pin the
 * shared rule both sides use, because a disagreement would mint an
 * invite under one name and connect the agent under another.
 */
describe('agent name normalization', () => {
  test('strips control characters, so a disguised duplicate cannot slip through', () => {
    // The reason uniqueness is judged on the normalized value: these two
    // are the same agent to Marginalia, which keys ownership on a hash
    // of the name.
    expect(normalizeAgentName('Cla\r\nude')).toBe('Claude');
    expect(normalizeAgentName('Claude')).toBe('Claude');
  });

  test('trims and truncates the same way the server does', () => {
    expect(normalizeAgentName('  Codex  ')).toBe('Codex');
    const long = 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 20);
    expect(normalizeAgentName(long)).toHaveLength(MAX_DISPLAY_NAME_LENGTH);
  });

  test('falls back to the default rather than an empty name', () => {
    // An empty display name makes `readIdentity` reject the request, so
    // the panel must never mint one.
    expect(normalizeAgentName('')).toBe(DEFAULT_AGENT_NAME);
    expect(normalizeAgentName('\r\n\t ')).toBe(DEFAULT_AGENT_NAME);
    expect(normalizeAgentName(null)).toBe(DEFAULT_AGENT_NAME);
  });
});
