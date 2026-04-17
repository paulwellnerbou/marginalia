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

This repo now ships the same basic deployment shape as `../mywebmail`:

- Docker image built and pushed to GHCR by [build-and-push.yml](.github/workflows/build-and-push.yml)
- dev auto-deploy via [deploy-dev.yml](.github/workflows/deploy-dev.yml)
- prod manual deploy via [deploy-prod.yml](.github/workflows/deploy-prod.yml)
- VPS-side rollout script at [deploy-instance.sh](deploy-scripts/deploy-instance.sh)
- one-time native Caddy setup at [migrate-caddy-layout.sh](deploy-scripts/migrate-caddy-layout.sh)

### Runtime environment

These are the main runtime env vars the container understands:

- `PORT` — HTTP listen port inside the container. Default: `3434`
- `MARGINALIA_DATA_DIR` — persistent data directory. Default: `/app/.data/`
- `MARGINALIA_WEB_DIR` — built SPA directory. Default: `/app/apps/web/dist`
- `APP_ENV_LABEL` — optional label appended to the browser title, e.g. `DEV`

### GitHub setup

Configure the same GitHub Actions secrets/vars pattern as `mywebmail`:

- Secrets: `VPS_HOST`, `VPS_USER`, `VPS_SSH_PRIVATE_KEY`, `DEPLOY_PATH`
- Variable: `DOMAIN`

On the VPS, the deploy script looks for:

- `$DEPLOY_PATH/.env.dev`
- `$DEPLOY_PATH/.env.prod`

Those files can define the runtime env vars above, plus optional deploy-time overrides like:

- `HOST_PORT` — host loopback port used by native Caddy
- `HOST_BIND_IP` — defaults to `127.0.0.1`
- `CONTAINER_NETWORK` — optional; not needed for native Caddy

### Native Caddy

With native host Caddy, each app container is published only on loopback:

- Marginalia prod: `127.0.0.1:3434`
- Marginalia dev: `127.0.0.1:3435`
- Noctua Mail prod: `127.0.0.1:3654`
- Noctua Mail dev: `127.0.0.1:3655`

Use [migrate-caddy-layout.sh](deploy-scripts/migrate-caddy-layout.sh) once to write native
Caddy site files under `/opt/caddy/sites`, copy the root config to `/etc/caddy/Caddyfile`,
validate it, and reload `caddy.service`.

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
