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

That is the per-document path, and it is one paste per document. See
[Keyrings](#keyrings-your-documents-on-more-than-one-device) for carrying
the whole list at once.

The icons are generated, not hand-drawn — the mark, the rounded tile, the
full-bleed Apple variant, the Android maskable variants and the multi-size
`favicon.ico` all come from one set of geometry in
[`scripts/generate-icons.ts`](scripts/generate-icons.ts). Edit that file
and re-run:

```sh
bun run icons
```

## Keyrings: your documents on more than one device

"Your documents" is a per-browser list, and access is a per-document
bearer token. That combination is the right default — no accounts, no
profile store — and it stops being convenient the moment one person owns
a laptop and a phone. Every document mints its own admin invite, so
nothing created on one device is visible from the other, and there is no
"my documents" query to ask the server for: there is no *my*.

A **keyring** is the smallest thing that fixes it. It is a synchronised
copy of the invite tokens a person already holds, plus their `clientId`.

**It authorizes nothing.** `authorize()` does not read the keyring
tables, and presenting a keyring token where an invite is expected gets
you exactly what a stranger gets. Document access is still the invite
token in `X-Marginalia-Invite`; the keyring only spares you from
carrying each one to each device by hand. That is what keeps the feature
small — no grants, no per-document ACL, no migration of the links
already in the wild — and it is the security boundary worth stating: a
leaked keyring token is every access link inside it, leaked at once.

Carrying the `clientId` is the part that makes paired devices one
*person* rather than two users who happen to share a name. Without it
each browser is its own `doc_users` row, so a comment written on the
laptop cannot be edited from the phone, a 👍 from both devices counts
twice, and `propagateRename` stops rewriting `@mentions` because the
name is ambiguous between them. The keyring is authoritative for
`display_name` too — devices adopt it on pull rather than pushing their
own, or two devices would fight through the rename propagation.

### Pairing

Adding a device never shows the keyring token. It mints a **pairing
code** instead — eight characters of the same unambiguous alphabet as
the generated passwords, single-use, expiring in
`keyringPairingTtlMs` (default 5 minutes). The home page's **Add a
device** dialog shows it as a QR code (encoding `/k/<code>`) and as
typable text, because the installed app on iOS opens in its own storage
container and typing the code is the way in there. Minting a code drops
the previous one, so the code on screen is always the only one that
works.

On the receiving device the code goes into the **Your devices** panel on
the home page, next to *Sync my devices* — the same panel, showing its
other half. `/k` carries the same field for the QR to land on, but
nothing needs to link there: a device holding a code is a device with an
empty list, and the panel is already the first thing on it that mentions
devices. Codes are normalised on the way in (`normalizePairingCode`), so
any case, with or without the separator, is accepted.

`POST /api/keyrings` seeds the ring from what the creating browser
already holds — that device usually has the full list, and an empty
first keyring would look like the feature had eaten it.

### How a ring ends

Three doors, and they are not the same door:

- **Stop syncing here** clears `marginalia.keyring` and nothing else.
  Local, on purpose — the other devices are still using the ring.
- **Replace keyring** rotates the token: this device keeps the ring, the
  others fall off it. For a code shared by mistake or a lost device.
- **Delete keyring** destroys it for everyone, including the server's
  copies of the invite tokens. Documents keep opening on each device
  from its own `localStorage`; only the syncing ends.

Left alone, a ring is swept once nothing has pulled or changed it for
`keyringIdleTtlMs` (default 180 days). Explicit deletion only
reaches the people who ask for it, and the rings most worth clearing —
a wiped browser, a replaced phone — belong to nobody who is still
thinking about them. `updated_at` is the liveness signal: a pull
refreshes it, at most once a day so a page load isn't a write. The sweep
runs from `POST /api/keyrings`, since there is no scheduler here and
that is the endpoint whose traffic tracks the table's growth — the same
bargain the pairing sweep strikes. Losing a ring costs a re-pair, never
access: the next pull 404s, the device drops the dead token and offers
to sync again.

Both ends of that are said out loud. While connected, the panel quotes
the window (from `idle_ttl_ms` on the pull, so the copy cannot drift
from a deployment's config); when a pull comes back 404 the panel says
syncing has stopped and why, with the pairing field right underneath.
The notice offers causes as possibilities, never as a closed list — a
404 means only that the token names no ring, and *deleted from another
device*, *rotated away*, *swept for going unused* and *the server's data
was reset* are indistinguishable once the row is gone. The server cannot
tell them apart either. Naming one would be a guess dressed as a fact,
and an exhaustive "either/or" would be wrong the first time someone
pressed **Delete keyring** on their other device.

### Endpoints

All except the last take the keyring token in `X-Marginalia-Keyring`.

- `POST   /api/keyrings` — mint a ring, adopting the caller's identity;
  optional `docs[]` seeds it
- `GET    /api/keyrings/self` — identity + documents, joined against
  `documents` so a paired device gets titles, formats and covers in one
  request (rows for deleted documents drop out here). Also returns
  `idle_ttl_ms`, so the client can name the expiry window without
  hardcoding it
- `PATCH  /api/keyrings/self` — set the shared `display_name`
- `POST   /api/keyrings/self/rotate` — new token, same documents; for a
  ring you believe leaked. Outstanding pairing codes die with it
- `DELETE /api/keyrings/self` — destroy the ring, its documents and its
  outstanding code. Revokes nothing: every device keeps the invite
  tokens in its own `localStorage`
- `PUT    /api/keyrings/self/docs/:uid` — record `invite_token` (+
  `title`); the token must really be an invite on that document
- `DELETE /api/keyrings/self/docs/:uid` — forget one, ring-wide
- `POST   /api/keyrings/self/pairings` — mint a pairing code
- `POST   /api/pairings/redeem` — exchange a code for the ring.
  Unauthenticated by design: the redeeming device has nothing yet, and
  the code is the proof

### Rate limiting

`POST /api/pairings/redeem` is the only unauthenticated route where
guessing wins anything, so it carries two fixed-window counters
([rate-limit.ts](apps/server/src/rate-limit.ts)). Only *failures* count:
a real pairing succeeds first try and spends nothing, which is what lets
the limits sit low enough to matter without getting in anyone's way.

- **Per client** — 10 failures / 10 min (`pairingRedeemPerClient`)
- **Server-wide** — 200 failures / 10 min (`pairingRedeemGlobal`)
- **Keyring creation** — 20 / hour per client (`keyringCreatePerClient`),
  so one caller cannot fill the table

The global counter is the one that actually bounds a brute force:
per-client limits assume the client can be identified, and an attacker
picks their own source addresses. At 200 failures per 10 minutes,
guessing a 40-bit code inside its 5-minute life is around a 1-in-10¹⁰
proposition per window. The cost is that a deliberate flood can make
*pairing* unavailable for a few minutes — access links keep working
throughout, so the degraded state is "can't add a device right now",
not "locked out".

Identifying "a client" means deciding whether to believe
`X-Forwarded-For`, and both answers are wrong somewhere. Trusting it on a
directly-exposed port lets any caller forge a fresh identity per request
and skip the limit entirely. Ignoring it behind a proxy makes every
request carry the proxy's address, so the whole instance shares one
bucket — safe, but ten mistyped codes from anybody then block pairing for
everybody for ten minutes.

`MARGINALIA_TRUSTED_PROXY_HOPS` answers it: how many reverse proxies you
control sit in front. Each proxy *appends* the peer it actually saw, so
the Nth-from-last entry is the one your Nth proxy vouched for, and a
client forging a header only pollutes the entries to its left. Reading
the leftmost — the usual "original client" convention — is precisely the
spoofable choice.

A count rather than a flag because topologies chain. With Cloudflare in
front of Caddy the header reads `client, cf-edge` once Caddy appends;
trusting one hop would file every visitor under the same edge address.
Two hops gets the client. (This mirrors `TRUSTED_PROXY_HOPS` in
noctua-mail, so both services on the same host describe their topology
the same way.)

Everything that isn't a trusted hop falls back to the connecting address,
which cannot be forged at all: no header, no trusted hops, or a chain
shorter than configured — where a real hop can't be told from a spoof.
Behind a proxy that resolves to the proxy, one shared bucket, which is
the safe direction; with no proxy it is the real client.

Unset means 0, the safe answer for the bare `docker run` above, and
garbage fails closed to 0 rather than becoming a trusted topology. You
shouldn't need to set it though:
**[deploy-instance.sh](deploy-scripts/deploy-instance.sh) derives it**
from where it publishes — a loopback `HOST_BIND_IP` means nothing reaches
the container except something already on the host, so exactly one hop is
yours; any routable address means it's directly reachable and none are.
The deploy summary prints the value and where it came from:

```
Host port: 127.0.0.1:3435 -> 3434
Trusted proxy hops: 1 (derived from HOST_BIND_IP=127.0.0.1)
```

Set `MARGINALIA_TRUSTED_PROXY_HOPS` in `.env.dev` / `.env.prod` to
override — which is what you'd do for the Cloudflare case, since the
binding can't reveal a second hop.

Deliberately not in the Dockerfile: the image is also run bare, where the
safe answer is 0. Only a deploy knows its topology.

Both misconfigurations announce themselves once rather than degrading
quietly — a private peer sending an `X-Forwarded-For` that is being
discarded, and a chain shorter than the configured hop count.

Counters are in memory and per-process. That is the whole fleet for a
single-container deploy; under replicas the per-client limit dilutes by
the replica count and the global limit becomes per-replica.

Pushes happen on create, on every visit that carried a token, and after
an admin rotation — that last one matters most, since rotating a leaked
admin link otherwise leaves every other device holding a key that no
longer turns.

Syncing is opt-in and every push is best-effort and silent. The local
list still works on its own, offline and unpaired; a failed sync must
never become an error in front of someone who is just trying to read.

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

## Copying a document

**Copy document** — the copy icon in the per-document toolbar, next to the
gear — forks a document into a second one with its own URL and its own
admin link. `POST /api/documents/:uid/copy` is the endpoint behind it, and
it is admin-only.

There are two kinds, chosen in the dialog and sent as `mode`:

- **Copy with history** (`mode: "full"`) takes the document's whole
  working life: the complete revision history, and every thread, comment
  and edit proposal, open or settled.
- **Clean copy** (`mode: "clean"`) takes only the text as it stands. The
  history is cut to a single commit and the discussion is left behind.

Either way the name (yours to change in the dialog), theme and renderer
settings, and attachments come across — attachments being junction rows
onto content-addressed blobs, the copy points at the same bytes rather
than duplicating them. An unrecognised `mode` reads as `clean`, which is
the option that copies strictly less.

**Copy with history** is a whole-repository fork rather than a replay,
which is what keeps it honest: every commit oid the discussion refers to
— a proposal's `base_oid`, an accepted one's `accepted_oid` — still
resolves in the copy, and the text is identical so every anchor still
lands. Rebuilding from the source text, the way bundle import has to,
would invalidate both.

The one thing it cannot keep is comment ids. `comments.id` is a global
primary key, so the copy re-mints every one and rewrites each column
that names a comment — parentage, mention and reaction rows, the
proposal answers table, and each proposal's git ref, which is named after
the comment that owns it. `copies every column` in `server.test.ts` holds
the row copy to the schema, so a column added later cannot be silently
dropped.

**Include access and roles** carries the participant roster: every
non-admin invite is re-minted on the copy with its role, name and note
intact, and `invite_only` mirrors the source. The tokens themselves cannot
carry, being the credential and the primary key both — the source's links
keep opening the source, and the admin hands the new ones out. Leave it off
and the copy is closed with the copier as its only member.

The password gate travels either way: dropping it would quietly turn a
protected document into an open one. Only the hash is stored, so the
password itself can't come along — the copy gets a freshly generated one,
shown once, exactly like a new upload's.

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

Access control does not ride along. Tokens are tied to the deployment that
minted them, so the import drops the password and lands invite-only like
any other new document — the importer gets a fresh admin link, and anyone
else needs one minted for them.

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
- `MARGINALIA_TRUSTED_PROXY_HOPS` — how many reverse proxies you control
  sit in front, so per-client rate limits see the real caller instead of
  the proxy. Default: `0`, but the bundled deploy script derives it from
  `HOST_BIND_IP` and passes it for you; set it in `.env.<instance>` only
  to override (e.g. `2` for Cloudflare → Caddy → app). See
  [Rate limiting](#rate-limiting)

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
│                       assets, document_assets, keyrings, keyring_docs,
│                       keyring_pairings
├── db.sqlite-wal      WAL file (journal mode)
├── db.sqlite-shm      Shared-memory index for the WAL
├── repo/              Git repo holding every document as <uid>.md
└── blobs/             Content-addressed asset binaries (FS backend only;
                        absent when MARGINALIA_BLOB_STORAGE=s3)
```

### Delete one document

**Document settings → Delete document** (admins only, two-step confirm),
or `DELETE /api/documents/:uid` directly. Either way the document is
destroyed rather than hidden: its git repo — every revision, not just the
current text — is removed from disk, and every row keyed to it goes with
it, including comments, edit proposals, mentions, reactions, invites,
sessions, the per-document user registry, and its attachments (blobs are
GC'd when no other document references them). Copies of its access link
are swept from every keyring, so the deletion reaches the owner's other
devices instead of leaving them with a token for a document that no
longer exists.

The browser that issued the delete also drops its own leftovers: the
recent-documents entry, the invite token, any saved password, and the
per-document theme override.

There is no undo and no backup. Export a JSON bundle first if the content
might be wanted later.

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

Clearing `marginalia.keyring` only stops this browser syncing — it does
not delete the ring, since other devices are still using it. Use
**Replace keyring** to disconnect them all, or **Delete keyring** to
remove it and the server's copies of your access links outright.
