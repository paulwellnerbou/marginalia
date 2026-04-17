# Marginalia

Markdown → beautiful themed HTML, with a collaborative viewer.

See [REQUIREMENTS.md](REQUIREMENTS.md) and [PLAN.md](PLAN.md).

## Layout

- `packages/renderer` — core library: Markdown → HTML + metadata
- `packages/cli` — `marginalia` CLI
- `packages/element` — `<marginalia-doc>` web component (Shadow DOM)
- `packages/react` — thin React wrapper
- `packages/themes` — CSS themes
- `apps/server` — Hono + Bun collaborative server
- `apps/web` — Vite + React SPA viewer/editor

## Development

```sh
bun install
bun test

# Dev servers (server on :3434, Vite on :5173)
bun run dev

# Production build + runtime
bun run build
bun run start
```

## Deployment

This repo includes Docker-based deployment automation:

- Docker image built and pushed to GHCR by [build-and-push.yml](.github/workflows/build-and-push.yml)
- dev auto-deploy via [deploy-dev.yml](.github/workflows/deploy-dev.yml)
- prod manual deploy via [deploy-prod.yml](.github/workflows/deploy-prod.yml)
- host-side rollout script at [deploy-instance.sh](deploy-scripts/deploy-instance.sh)

### Runtime environment

These are the main runtime env vars the container understands:

- `PORT` — HTTP listen port inside the container. Default: `3434`
- `MARGINALIA_DATA_DIR` — persistent data directory. Default: `/app/.data/`
- `MARGINALIA_WEB_DIR` — built SPA directory. Default: `/app/apps/web/dist`
- `APP_ENV_LABEL` — optional label appended to the browser title, e.g. `DEV`

### GitHub setup

If you use the bundled GitHub Actions deploy workflows, configure:

- Secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY`, `DEPLOY_PATH`
- Variable: `DOMAIN`

On the deployment host, the deploy script looks for:

- `$DEPLOY_PATH/.env.dev`
- `$DEPLOY_PATH/.env.prod`

Those files can define the runtime env vars above, plus optional deploy-time overrides like:

- `HOST_PORT` — host port to publish the container on
- `HOST_BIND_IP` — defaults to `127.0.0.1`
- `CONTAINER_NETWORK` — optional Docker network name

### Local Docker

```sh
docker build -t marginalia .
docker run -d \
  --name marginalia \
  -p 3434:3434 \
  -v "$PWD/.data:/app/.data" \
  -e APP_ENV_LABEL=DEV \
  -e MARGINALIA_DATA_DIR=/app/.data \
  -e MARGINALIA_WEB_DIR=/app/apps/web/dist \
  marginalia
```

## Server-side state

All persistent server state lives in a single directory — `var/` by default,
or the path in `MARGINALIA_DATA_DIR` (see [config.ts](apps/server/src/config.ts)):

```
var/
├── db.sqlite          SQLite DB: documents, invites, sessions, comments
├── db.sqlite-wal      WAL file (journal mode)
├── db.sqlite-shm      Shared-memory index for the WAL
└── repo/              Git repo holding every document as <uid>.md
```

### Clear everything

Stop the server, then delete the data directory:

```sh
rm -rf apps/server/var/
```

Next startup recreates the directory, an empty SQLite schema, and a fresh
`git init`. Every document, invite, and comment is gone.

To reset while preserving the git history for manual inspection, delete
only the DB files:

```sh
rm -f apps/server/var/db.sqlite apps/server/var/db.sqlite-wal apps/server/var/db.sqlite-shm
```

Note that the git repo references documents by uid; dropping the DB
orphans the `.md` files (they're no longer accessible via any URL).

### Reset **client** state (invite tokens, display name, recent docs, theme)

Everything the web app persists lives in `localStorage` under the
`marginalia.*` prefix. Or just wipe the site in browser settings.
