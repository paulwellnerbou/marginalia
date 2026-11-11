/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { mcpServerName } from './mcp-connection.js';

test('each project gets an MCP server name of its own', () => {
  const acme = { id: 'ring-0000000a1b2c', label: 'Acme GmbH' };
  const beta = { id: 'ring-0000000d3e4f', label: 'Beta' };
  expect(mcpServerName(null)).toBe('marginalia');
  expect(mcpServerName(acme, [acme, beta])).toBe('marginalia-acme-gmbh');
  // No slug to be had: the id tells it apart from the plain default.
  expect(mcpServerName({ id: 'ring-000000009f8e', label: '株式会社' })).toBe('marginalia-9f8e');
  // Same slug as another project: both take a piece of their id.
  const shouting = { id: 'ring-000000007777', label: 'ACME gmbh!' };
  expect(mcpServerName(acme, [acme, shouting])).toBe('marginalia-acme-gmbh-1b2c');
  expect(mcpServerName(shouting, [acme, shouting])).toBe('marginalia-acme-gmbh-7777');
});
