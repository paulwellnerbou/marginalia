# Marginalia

Markdown → beautiful themed HTML, with a collaborative viewer.

Documents, comments, invites, sessions, and assets are persisted on the
server. The browser only stores local auth/session helpers and UI state
such as invite tokens, display name, recent docs, and theme.

## Layout

- `packages/renderer` — core library: Markdown → HTML + metadata
- `packages/cli` — `marginalia` CLI
- `packages/mcp` — MCP server so AI agents can review documents
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

## Installable app (PWA)

The viewer installs as a standalone app. `apps/web/public` holds the
manifest, the service worker, and the icon set.

The service worker (`apps/web/public/sw.js`) is dependency-free and
deliberately narrow. It precaches the SPA shell and the bundles it boots
from, serves navigations network-first so a new deploy is always picked
up, and treats `/assets/*` as immutable because Vite content-hashes those
filenames. **Nothing under `/api` is ever cached** — documents are
authorized per request, so a cached copy would be both stale and a way to
read a document after access was revoked. Offline you get the app shell
and a clear message, not the browser's error page.

It only registers in production builds, so verify PWA behaviour against
`bun run build && bun run start` rather than the Vite dev server.

### Getting access into the installed app

Auth lives in the browser, and on iOS an installed app gets a storage
container of its own — so a freshly installed Marginalia starts with an
empty document list no matter what the browser already holds, and no link
the browser offers can hand it over. (Android and desktop share the
browser's storage, so this only bites on iOS.)

The way across is the invite URL: `claimInvite` deliberately keeps the
invite row so the same link can be re-claimed from another browser, which
is exactly what the installed app looks like. So the home page has an
**Open from a link** field that takes a pasted invite URL — full URL, bare
path, or just a document id — and routes to it.

Since `ViewPage` strips the token from the address bar on arrival, the
link cannot be recovered from the URL later. **Copy access link** — on
each document card and in the per-document user menu — hands it back. It
is deliberately an explicit action and names the role it grants, because
that link is a bearer credential.

The icons are generated, not hand-drawn — the mark, the rounded tile, the
full-bleed Apple variant, the Android maskable variants and the multi-size
`favicon.ico` all come from one set of geometry in
[`scripts/generate-icons.ts`](scripts/generate-icons.ts). Edit that file
and re-run:

```sh
bun run icons
```

## AI review (MCP)

[`packages/mcp`](packages/mcp/README.md) is an MCP server that gives an
agent the same review surface a human reviewer has: it can read a
document, read the comments and edit proposals on it, reply to them,
leave its own comments, suggest edits, and download the document in any
supported format.

The loop it exists for: read a draft in the viewer, comment where
something is off, then hand the agent the document URL and ask it to
work through your comments and turn them into edit proposals you can
accept or push back on.

The server hosts the tools itself at `/mcp`, so connecting an agent is a
URL — nothing to install, nothing running locally:

```bash
claude mcp add --transport http marginalia https://marginalia.example.com/mcp
```

Every document has an **MCP** tab in its right-hand pane that generates
that command (and the JSON equivalent) along with an access link for the
agent. Access works the same way it does for people — mint the agent its
own `collaborator` link, so it can suggest everything and decide nothing.

`packages/mcp` also runs standalone over stdio, which is what you want
while developing it. See the
[package README](packages/mcp/README.md) for that, the full tool list,
and configuration.

## Document assets

Documents reference images and (planned) include files by a name that
appears in the source — `![cat](cat.png)` in markdown, `image::cat.png[]`
in AsciiDoc. Those names resolve against a per-document *asset store*.

- Uploads happen through the editor: drop or paste an image into the
  editor pane, or click the dropzone that replaces a missing-image
  reference. The file is bound to the exact name used in source.
- Viewers request assets through `/api/documents/:uid/assets/:refName`,
  which goes through the same authorization check as the document
  itself — a user without access to the document cannot fetch its
  assets, even with a direct URL.
- Blobs are content-addressed (sha256). The same bytes uploaded under
  two different names — or to two different documents — are stored
  once. Detaching the last reference garbage-collects the blob.

Asset endpoints (all gated by per-document authz; writes require
`editor`+):

- `GET    /api/documents/:uid/assets` — list attached assets
- `POST   /api/documents/:uid/assets` — multipart upload (`file`,
  `ref_name`, optional `kind`)
- `GET    /api/documents/:uid/assets/:refName` — fetch bytes (ETag +
  `Cache-Control: private, max-age=0, must-revalidate` so access is
  re-checked on every hit; non-image mimes are served as
  `Content-Disposition: attachment`)
- `DELETE /api/documents/:uid/assets/:refName` — detach (and GC the
  blob if nothing else references it)

Upload size defaults to 16 MiB; override with `maxAssetBytes` in
[config.ts](apps/server/src/config.ts).

### Book cover

A document can carry one **cover image**, used for its EPUB export and
shown as a thumbnail on the document card on the home page. It's stored
like any other asset — a content-addressed blob plus a `document_assets`
row under the reserved ref name `cover.<ext>` — with
`documents.cover_ref` pointing at it. So the cover inherits the asset
store's per-document authorization, ETag revalidation, and blob GC, and
is fetched through the usual `/assets/:refName` proxy.

- `PUT    /api/documents/:uid/cover` — multipart (`file`), `editor`+
- `DELETE /api/documents/:uid/cover` — detach and clear the pointer

The format is decided by sniffing magic bytes, never by the declared
MIME type: PNG, JPEG, GIF, or WebP, up to 10 MB. SVG is rejected — it
can carry script, and EPUB readers vary in how they sandbox it. Since
the extension in the ref name determines the served `Content-Type`,
replacing a PNG cover with a JPEG moves it to a different ref and
detaches the old one. The ref name is a normal one, so a document whose
source already references `cover.png` shares that asset with its cover —
uploading a cover replaces the image the source points at.

Upload happens in the **Download → EPUB** dialog, which previews the
picked image before it's sent. Editors' uploads are saved on the
document, so one upload serves every later export — **Save cover**
stores it without building a book, and downloading the EPUB stores it on
the way. Readers and collaborators can still attach a one-off cover to a
single export (multipart `cover` on the export request), which is never
persisted.
Without any cover, the exporter generates a typographic SVG from the
book title.

### Blob storage backend

Two backends; same interface, one config switch.

**Filesystem** (default, zero-config). Blobs land under
`MARGINALIA_DATA_DIR/blobs/<sha[0:2]>/<sha>`. Good for self-hosting,
Docker volumes, and local development.

**S3-compatible** (any of AWS S3, Cloudflare R2, MinIO, Backblaze B2,
DigitalOcean Spaces…). Enable with `MARGINALIA_BLOB_STORAGE=s3` plus:

```sh
MARGINALIA_BLOB_STORAGE=s3
MARGINALIA_S3_BUCKET=marginalia-blobs
MARGINALIA_S3_ACCESS_KEY_ID=...
MARGINALIA_S3_SECRET_ACCESS_KEY=...
# Optional — AWS S3 picks the right endpoint from the region if omitted.
MARGINALIA_S3_ENDPOINT=http://localhost:9000       # e.g. MinIO
MARGINALIA_S3_REGION=auto
MARGINALIA_S3_PREFIX=prod/blobs/                   # key prefix inside the bucket
MARGINALIA_S3_VIRTUAL_HOSTED=1                     # if your endpoint needs it
```

Credentials must be readable at startup; the server fails loudly if any
required S3 var is missing. All reads still go through the per-document
proxy — never share bucket credentials or pre-signed URLs with end
users.

## JSON Bundles

Documents can be exported and imported as versioned JSON bundles through the
server API:

- `GET /api/documents/:uid/export` downloads a `.marginalia.json` bundle
- `POST /api/documents/import` creates a new document from a previously exported bundle

The bundle includes:

- document metadata and markdown source
- comment threads
- renderer metadata (`frontmatter`, TOC, assets, mermaid blocks, block map, warnings)

That makes the export readable by external tools while still round-tripping
back into Marginalia.

## Deployment

This repo includes Docker-based deployment automation:

- Docker image built and pushed to GHCR by [build-and-push.yml](.github/workflows/build-and-push.yml)
- dev auto-deploy via [deploy-dev.yml](.github/workflows/deploy-dev.yml)
- prod manual deploy via [deploy-prod.yml](.github/workflows/deploy-prod.yml)
- host-side rollout script at [deploy-instance.sh](deploy-scripts/deploy-instance.sh)

### Runtime environment

These are the main runtime env vars the container understands:

- `PORT` — HTTP listen port inside the container. Default: `3434`
- `MARGINALIA_DATA_DIR` — persistent data directory. Default:
  repo-root `.data/` in local dev, `/app/.data/` in Docker
- `MARGINALIA_WEB_DIR` — built SPA directory. Default: `/app/apps/web/dist`
- `APP_ENV_LABEL` — optional label appended to the browser title, e.g. `DEV`
- `MARGINALIA_BLOB_STORAGE` — `fs` (default) or `s3`. See
  [Blob storage backend](#blob-storage-backend) for the S3 env vars.

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

All persistent server state lives in a single directory — the repo-root
`.data/` by default in local development, or the path in
`MARGINALIA_DATA_DIR` (see [config.ts](apps/server/src/config.ts)):

```
.data/
├── db.sqlite          SQLite DB: documents, invites, sessions, doc_users,
│                       comments, comment_mentions, edit_proposals,
│                       assets, document_assets
├── db.sqlite-wal      WAL file (journal mode)
├── db.sqlite-shm      Shared-memory index for the WAL
├── repo/              Git repo holding every document as <uid>.md
└── blobs/             Content-addressed asset binaries (FS backend only;
                        absent when MARGINALIA_BLOB_STORAGE=s3)
```

### Clear everything

Stop the server, then delete the data directory:

```sh
rm -rf .data/
```

Next startup recreates the directory, an empty SQLite schema, and a fresh
`git init`. Every document, invite, and comment is gone.

To reset while preserving the git history for manual inspection, delete
only the DB files:

```sh
rm -f .data/db.sqlite .data/db.sqlite-wal .data/db.sqlite-shm
```

Note that the git repo references documents by uid; dropping the DB
orphans the `.md` files (they're no longer accessible via any URL).
The `blobs/` directory is similarly orphaned — those files are
addressable only through the `assets` / `document_assets` tables, so
once the DB is gone they're dead weight and safe to remove.

### Reset **client** state (invite tokens, display name, recent docs, theme)

This only clears browser-held auth/session helpers and UI state. It does
not remove any server-stored documents, comments, history, invites, or
assets.

Everything the web app persists locally lives in `localStorage` under the
`marginalia.*` prefix. Password-protected docs also use the
`marginalia_session` cookie. Or just wipe the site in browser settings.
