#!/usr/bin/env bun
import { main } from './main.js';

main().catch((err) => {
  console.error('[marginalia-mcp] fatal:', err);
  process.exit(1);
});
