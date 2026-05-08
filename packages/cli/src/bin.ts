#!/usr/bin/env bun
import { main } from './main.js';

main(Bun.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(2);
  },
);
