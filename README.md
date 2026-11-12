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

When the link is on someone else's screen there is nothing to paste, so
the same field has a **scan** button that reads the QR code the Access
control dialog shows for every link (a pairing QR is accepted there too
and lands on the pair page). Decoding uses the browser's `BarcodeDetector`
where it exists and a bundled decoder (`qr-scanner`) where it does not —
which is every WebKit browser, so on iOS the fallback is the only path.
The button shows wherever the camera API exists; without it the field is
unchanged.

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

### Several rings: one per project

Someone working for several clients can hold a ring per client, which
the UI calls a **project**. Each has its own documents, devices and
agent keys, so pairing a device or connecting an agent hands over one
client's documents and never another's. A ring carries a `label`
("Acme"), synced like the display name; the browser keeps its rings as
a list in `marginalia.keyrings` (an older single `marginalia.keyring`
token becomes the first entry).

- **Which documents a ring holds** is recorded on each entry of the
  local list (`rings`), from that ring's last pull and from changes made
  here. The home page filters by it: every project, one, or the
  documents in none. The list has no cap: an entry is the way back to a
  document's access link, so only the card's ✕ removes one.
- **Filing.** A visit pushes a document only to the rings that already
  hold it. One in no ring goes into the project selected in that tab, or
  the only ring there is — and nowhere while every project is shown,
  since filing a client's document under another client is the mistake
  worth not making on a guess. A copy goes where its original is.
- **Moving** adds the document to the new ring before removing it from
  the old one, so an interruption leaves it in both rather than neither.
  Removal revokes the old ring's agent invites for it. A card moves its
  folder companions with it.
- **Identity.** Every ring authors under the same `clientId`: bookmarks
  and the right to edit your own comments hang off it. Pairing a second
  ring whose id differs keeps the browser's own (`keep_client_id` on the
  redeem). The display name can differ per ring; requests for a
  document carry the name of the ring it belongs to, set before the
  viewer's first request.
- **MCP.** An agent key belongs to one ring, and the setup snippet
  registers it as `marginalia-<project>`, so a second client's agent is
  added beside the first rather than replacing it.

### How a ring ends

Three doors, and they are not the same door:

- **Stop syncing here** drops the ring from `marginalia.keyrings` and
  nothing else. Local, on purpose — the other devices are still using
  the ring.
- **Replace keyring** rotates the token: this device keeps the ring, the
  others fall off it, and its agent keys are revoked. For a code shared
  by mistake or a lost device.
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

### Agent keys: one MCP connection for the whole ring

An MCP connection normally carries one document's invite. An **agent
key** carries the keyring instead — without carrying the keyring token,
which is the one secret the pairing flow keeps off screens and would
otherwise end up in agent config files and third-party connector
settings. *AI agents* in the **Your devices** panel mints one: a name the
agent signs with, a role (`collaborator` by default, at most `editor`),
and a URL, `/mcp?key=mak_…`, shown once. The server keeps only its
SHA-256.

The key authorizes nothing directly either. The agent exchanges it, one
document at a time, for an ordinary **named invite** the server mints at
the key's role from the admin link the ring holds. Those invites appear
in each document's access panel, noted *AI agent via keyring*, and
`authorize()` treats them like any other. Only documents the ring holds
an admin link for can be delegated — minting an invite is an admin act,
and passing on a lesser link of the ring's own would have the agent
acting under somebody else's invite with no way to take it back. One
admin link opens its whole folder, as it does for people.

Revoking is what the indirection buys. **Revoke** on a key deletes every
invite it was given, so the agent loses access wherever it cached them.
The same happens per document when the ring forgets that document or
stops holding its admin link, and for every key when the ring is
deleted, rotated or swept. Rotating revokes them because whoever held
the old token could have minted a key of their own. Deleting one agent
invite from a document's access panel removes that link only — the key
mints a new one on next use; revoke the key to stop it.

The key's role can be changed later from the same list, and its invites
move with it. An invite given another role — from a document's **MCP**
tab, which sets the key's role for that document (and its folder) and
mints the invite if the agent has none there yet, or from the access
panel — is marked as set apart and stays as it was; setting it back to
the key's role makes it follow again. While the ring's admin link for a
document is dead, its role can't be changed from the ring.

A device pushes the link it opened a document with, and an owner opening
their own document through a reviewer's link must not demote the ring:
while the ring holds a live admin link for a document, a lesser one does
not replace it. If the ring's only link is dead — rotated on a device
that has not synced since — the agent keeps an invite it already has but
is not minted a new one until a synced device opens the document again.

Documents the agent creates go into the ring under their admin link, so
they show up on every device, and the agent then works on them with its
own invite, at the role the user chose, rather than the creator's admin
link. Filing renames
that admin link to the ring's display name: an admin link's name seeds
whoever opens it first, and the owner opening it must not be signed as
the agent. Its client id is
derived from the key, so two keys never share comment ownership, and
using a key counts as using the ring for the idle sweep.

Managed with the keyring token (`X-Marginalia-Keyring`):

- `GET    /api/keyrings/self/agents` — the ring's keys, never the keys
  themselves
- `GET    /api/keyrings/self/agents?doc=:uid` — the same, each with its
  `document` role there (null where the ring cannot delegate it)
- `POST   /api/keyrings/self/agents` — `display_name` + `role`; returns
  the key once. Names are unique per ring
- `PATCH  /api/keyrings/self/agents/:id` — `role`; invites that follow
  the key move with it
- `PUT    /api/keyrings/self/agents/:id/documents/:uid` — `role` on one
  document, minting the invite if needed
- `DELETE /api/keyrings/self/agents/:id` — revoke it and its invites

Used with the key (`X-Marginalia-Agent-Key`), by the MCP server:

- `GET    /api/agent/self` — the name and the key's role
- `GET    /api/agent/documents` — the ring's documents, no tokens, with
  the role the agent has or would get on each (null where it cannot) and
  `link_stale` where the ring's only link no longer exists
- `POST   /api/agent/documents/:uid/access` — this agent's invite on that
  document, minted on first use
- `PUT    /api/agent/documents/:uid` — add a document's admin link to the
  ring; nothing else is accepted

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

The same count decides whether the hosted `/mcp` endpoint believes
`X-Forwarded-Proto` and `X-Forwarded-Host`. Behind a TLS-terminating
proxy the request arrives as `http`, and the endpoint needs the public
`https` origin to recognise the document links an agent is handed as its
own and to hand out working ones.

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
leave its own comments, suggest edits — rewrites of existing text, or
new chapters and sections — and download the document in any supported
format.

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
the setup for the agent's client — Claude Code, Codex, Gemini CLI,
Mistral Vibe (CLI or web) or a web app's connector form, as a command or
a config file entry where the client takes both — along
with an access link for the agent. Access works the same way it does for people — mint the agent its
own `collaborator` link, so it can suggest everything and decide nothing.
For every document at once, give it an
[agent key](#agent-keys-one-mcp-connection-for-the-whole-ring) from the
home page's **Your devices** panel instead.

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
- An MCP agent attaches them through the same endpoint:
  `create_document` takes `images` and uploads them right after
  creating the document, while it still holds the admin link — so an
  agent key at collaborator can still create a document with
  its figures — and `upload_image` adds one later, as editor or admin.
- Files an agent has on disk go by **upload URL** instead of base64
  in a tool call: `create_document`'s `image_uploads` and the
  `request_image_uploads` tool hand back one URL per name, sent with
  `curl -F file=@<path>`. Each URL is good for one file under its name
  for 15 minutes, needs no other credential, and keeps working after
  the agent's access drops to its key's cap — but not after the invite
  that minted it is deleted or the agent key behind the request is
  revoked. Minting needs what uploading needs, a document holds at most
  200 unused URLs, a URL whose file failed to store stays usable, and
  the server keeps only the URLs' hashes. `get_document` lists images
  the source still lacks.
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
- `POST   /api/documents/:uid/assets/uploads` — `{ names }` (up to 50);
  one single-use upload URL per name, valid 15 minutes
- `POST   /api/asset-uploads/:token` — multipart `file`, attached under
  the name the URL was minted for; no invite or identity needed

Upload size defaults to 16 MiB; override with `maxAssetBytes` in
[config.ts](apps/server/src/config.ts).

### Source upload URLs

The same idea for a document's text: `POST /api/documents/:uid/source-uploads`
(`editor`+, optional `{ commit_message }`) mints one URL bound to the
current source. `GET /api/source-uploads/:token` serves that source
exactly; `POST` takes the replacement as multipart `file` or a raw
body and saves it as a direct edit, attributed to whoever minted it.
If the document was saved in between, the upload is refused with
`409 document-changed` and the URL is dead. Single-use, 30 minutes,
at most 20 unused per document, same size limit and revocation as
asset upload URLs. The MCP tool `request_source_upload` wraps it, so
an agent can rewrite a long document on disk instead of retyping it
into a tool call.

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

## Folders

A **folder** keeps documents that belong together — a story, its
OUTLINE and its BACKGROUND — under one set of access links. One document
is the folder's **main document**, its entry point; the others are added
to it with `POST /api/documents` and a `folder` field naming any document
already in the folder, plus a required `name`. Admins and editors may add
one. A document added through another folder document joins the same
folder: folders are one level deep.

The viewer never says "folder". A document in one lists it at the top of
the left pane, above its contents: the main document first, the others
beneath it, the open one highlighted. **Add a document** — at the foot
of that list, and as an icon in the document toolbar for admins and
editors, where it starts a folder from a document that stands alone —
asks for a name and opens the new document in the editor, starting from
that name as a heading. The home page gives a folder one card, the main
document's, with the others listed on it; one whose main document this
browser has never opened keeps a card of its own.

A link in a document can name another document of its folder instead of
spelling out its uid: `[the outline](OUTLINE)`, `[notes](<My Notes>)`,
`[act two](outline.md#act-two)`, or in AsciiDoc `xref:OUTLINE.adoc[]`.
The name is matched without regard to case, spacing, punctuation or a
file extension, first against each document's name, then against its
title — which is how the main document, usually unnamed, is reached:
`[back to the story](the-long-night)`. The viewer and the editor preview
resolve these links, not the renderer, since a rename or a new folder
document changes where they lead without changing the source; a plain
click moves within the app (in the editor preview, to a new tab). A name
no folder document has is left as written. Exports and the rendered HTML
an agent fetches keep the names unresolved.

A folder document has no access of its own. Its password, invite-only
flag, invites and sessions are the main document's — `authorize()` reads
every gate off the main document and records only the visitor's identity
against the document itself. So the links people already hold for the
main document open the whole folder, an invite created later reaches
every document in it, and revoking one closes all of them. One password
session covers the folder too. That is the difference from **Copy with
access**, which re-mints links nobody holds yet: a folder shares the ones
that already exist.

It follows that a leaked link is the whole folder, not one document, and
that the access routes act on the main document whichever folder
document they are reached through. `GET /api/documents/:uid/invites` on
OUTLINE lists the story's invites, and a password or `invite_only` change
sent to a folder document is refused with `409 access-managed-by-folder`
rather than stored where nothing reads it. Access control there shows the
shared link list and points to the main document for the rest; on the
main document it names the documents its settings also cover.

The browser stores an invite token per document, so opening a folder
document stores the token it came with under the rest of the folder
(where none is stored yet), and the links between them work without one
in the URL. Rotating the admin link swaps the new token in everywhere
the old one was stored, or the rest of the folder would stop opening on
this device and every device its keyring reaches.

`GET /api/documents/:uid` carries the listing as `folder` — the main
document's uid and every document in the folder, main first, each with
its `title` (its name, or the title its content gives itself). It is
`null` for a document that is not in a folder. Anyone who can open one
document in the folder can open them all, so the listing reveals nothing
new. Keyring pulls carry `folder_uid`, so a device can group its list.

The MCP server lists the folder in every document header and remembers
the link that opened one document for all the others, so an agent that
has read the story can open its outline by uid without being told it
exists. `create_document` takes `folder` to add one — see the
[MCP README](packages/mcp/README.md#folders).

## Summary and about

A document can carry a **summary** (a blurb) and an **about** text (notes
for readers), like the fields a story platform lists beside a book. Both
live in the source, as marked regions near the top:

```markdown
<!-- summary -->
Frankfurt, October 2015. Felix has just learned …
<!-- /summary -->

<!-- about -->
The story is set in Frankfurt am Main in the *autumn of 2015*.
<!-- /about -->
```

In AsciiDoc it is an open block with the role, `[.summary]` or `[.about]`
over `--` … `--`. A region needs its closing marker and only counts at
the top level; other Markdown renderers just don't show the comments.

Nobody has to type the markers. The editor toolbar has a Summary and an
About button: each jumps to its region, or adds empty markers under the
title when there is none (not while editing a single chapter or
appending). Editors also see "Add summary" / "Add about" in the document
itself, where the folds would be, for whichever is missing, and ×
hides that for the document in this browser.

**Edit summary** / **Edit about** work like Edit chapter: on the fold's
header, or hovering a block inside the region. The editor then holds
only the region's text — markers and AsciiDoc delimiters stay out of it —
and Save puts it back, or Propose edit turns it into a proposal on the
region's blocks. Both go through `/d/<uid>/edit?meta=summary`; for a
document without that region yet, the same address opens the whole
document with empty markers added.

Since they are ordinary text, comments, edit proposals (including those
an agent makes over MCP), history and revert all work on them. The
viewer shows each as a fold above the text, closed until the reader
opens it and remembered per document; jumping to a thread inside one
opens it. Each fold shows how many characters its text has; there is
no limit. Statistics leave both out, and so do
the PDF, Word and EPUB exports; the EPUB takes the summary as its
description. Source downloads, chapter ZIPs, copies and JSON bundles
keep them as written. MCP's `get_document` says where each region is,
or how to add one.

## View settings

What the **View** menu sets — layout, reading, block and page width,
text size, theme, paper and ink — is remembered per document, in this
browser, and so are the open side tab, the pane widths, how comments
show and the Threads tab's sort and filters. Setting a book to large
type in pages leaves every other document as it was. **Interface size**
and the light/dark appearance apply to the whole app.

A document never changed in this browser starts from what the view
settings were when they still applied to every document.

## Full view

View → **Document only** shows the document with nothing of the app
around it: the contents on the left, the comment cards beside the text
(floating over it where the column has no room), and no app bar,
toolbar or Threads/History pane. Reading and commenting work as usual.

The mode is part of the address, `?view=full`, so a link can open
straight into it — an invite link too: `/d/<uid>/<token>?view=full`
keeps the parameter when the token is taken out of the address bar.
**Open links in full view** in Access control adds it to every access
link and QR code listed there.
**Exit full view** at the foot of the contents pane (or its collapsed
rail) goes back to the normal view and drops the parameter.

Paired with the **Report** theme (condensed headings, white cards on a
warm grey page, a lime accent and a guide line opening every section)
it reads like a standalone briefing.

## Document statistics

The bar-chart button in the document toolbar opens word counts for the
whole document and for each chapter: words, characters, sentences,
paragraphs, an estimated page count and a reading time. The two
conversions behind the estimates are adjustable and remembered per
browser — pages default to 250 words each (a printed novel page holds
roughly 250–300, and 250 is the manuscript convention), reading time to
240 words a minute.

Counts come from the rendered block map, so they describe what is on
the page: accepted proposals are in, frontmatter is out, and code blocks
and diagrams are left out of every number. A chapter is what the chapter
export calls one — a lone `# Book title` over `## Chapter` headings
unwraps to the chapters, with the title and any introduction shown as
"Before the first chapter"; otherwise the top-level headings are the
chapters. Each chapter expands to its subsections, and every title is a
link into the document.

The counting itself is the renderer's `computeDocumentStats`, a pure
function over `RenderResult`, so the CLI and MCP server can report the
same numbers if they ever need to.

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

A [folder](#folders)'s main document holds the access for the whole
folder, so deleting it deletes the folder. The server refuses with
`409 folder-not-empty` (listing the other documents) unless the request
says `?with_members=1`, so a client that means one document cannot empty
a folder by accident. Deleting any other folder document removes only
that document. Document settings names the documents that go with a
main document before it deletes them, and after deleting any other one
it lands on the main document instead of the home page.

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
