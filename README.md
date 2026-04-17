# Markdowner

Markdown → beautiful themed HTML, with a collaborative viewer.

See [REQUIREMENTS.md](REQUIREMENTS.md) and [PLAN.md](PLAN.md).

## Layout

- `packages/renderer` — core library: Markdown → HTML + metadata
- `packages/cli` — `markdowner` CLI
- `packages/element` — `<markdowner-doc>` web component (Shadow DOM)
- `packages/react` — thin React wrapper
- `packages/themes` — CSS themes
- `apps/server` — Hono + Bun collaborative server
- `apps/web` — Vite + React SPA viewer/editor

## Development

```sh
bun install
bun test
```
