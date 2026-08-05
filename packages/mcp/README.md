# @marginalia/mcp

An MCP server that lets Claude (or any MCP client) read, comment on,
propose edits to, and download Marginalia documents.

The point is the review loop: you read a draft in Marginalia's viewer and
leave comments where something is off, then hand the document URL to an
agent and say

> Tackle the comments I left and create edit proposals for them. If a
> change implies other changes elsewhere in the document, comment on
> those too.

The agent works through your comments, replies to each one, and leaves
edit proposals you can accept with one click — or comment on again.

## Setup

There are two ways to run this. Pick the first unless you have a reason not to.

### Over HTTP — nothing to install

Your Marginalia instance serves the tools itself, at `/mcp`. The agent needs a URL and
nothing else: no checkout of this repo, no Bun, no local process.

```bash
claude mcp add --transport http marginalia https://marginalia.example.com/mcp
```

or, in `.mcp.json` / your client's MCP settings:

```json
{
  "mcpServers": {
    "marginalia": {
      "type": "http",
      "url": "https://marginalia.example.com/mcp"
    }
  }
}
```

Codex: `codex mcp add marginalia --url https://marginalia.example.com/mcp`.

Everything the agent writes is signed "Claude". Append `?name=Codex` to the URL to change
that — the server sends it on every request as the same `x-marginalia-client-name` header
the browser sends, so nothing has to be configured on the agent's side. (The browser reads
that name from `localStorage`; the MCP server never touches a browser, and takes it from
the URL instead.)

The name also derives the `x-marginalia-client` id Marginalia uses to decide who may edit
or delete a comment, so it stays stable across reconnects — which also means two agents
connecting under the same name share one identity. Add `&client_id=…` to keep them apart.

Give the agent a **named** invite, and make `?name=` match the name on it. Naming the
invite is what puts the agent on the @-mention roster before it has ever connected, so you
can write "@Claude look at this" and let it find the mention on arrival. The catch is that
a named invite also seeds its own display name onto a client's first request: if the two
names disagree, the agent's first write is signed with the invite's name and everything
after it with the URL's. The MCP tab generates the connection string from the invite, so
they cannot drift.

Add `&token=<invite token>` and the connection carries the agent's access, so any reference
to that document works even without a token in it:

```bash
claude mcp add --transport http marginalia \
  'https://marginalia.example.com/mcp?name=Claude&token=<invite token>'
```

Quote it — an unquoted `&` in a shell backgrounds everything before it and runs the rest as
a separate command, so the token would go missing without a word of complaint.

The token applies to a reference that has none of its own, including a link copied from a
comment — which the viewer strips the token from once an invite has been claimed. A token
in a pasted URL still wins, and a token for one document simply resolves to nothing on
another.

The document viewer has an **MCP** tab that generates all of this for you, with an access
link for the agent alongside it.

To point an agent at one comment, hand it the link the viewer's "copy link to this comment"
button produces. The `#comment-<id>` fragment selects that thread — the id may belong to a
reply, which resolves to the thread containing it. `list_threads` also takes any message's
id as `thread_id`.

### Over stdio — for local development

Runs the server as a local process instead, against any instance you name. Useful when
you're working on this package, or pointing an agent at a Marginalia that isn't reachable
from where the agent runs.

```json
{
  "mcpServers": {
    "marginalia": {
      "command": "bun",
      "args": ["/absolute/path/to/marginalia/packages/mcp/src/bin.ts"],
      "env": {
        "MARGINALIA_BASE_URL": "https://marginalia.example.com",
        "MARGINALIA_DISPLAY_NAME": "Claude"
      }
    }
  }
}
```

`bun` is the command because this package is TypeScript run directly from source — Bun
executes it without a build step. That is the cost of the stdio route, and the reason the
HTTP one exists.

### Environment (stdio only)

The hosted endpoint takes its settings from the URL; these apply to the stdio server.

| Variable | Default | Purpose |
| --- | --- | --- |
| `MARGINALIA_BASE_URL` | `http://localhost:3434` | Instance used when a tool gets a bare document uid. A full document URL always wins. |
| `MARGINALIA_DISPLAY_NAME` | `Claude` | The name every comment and proposal is signed with. |
| `MARGINALIA_ALLOWED_HOSTS` | *(unset — any host)* | Comma-separated allowlist. When set, a URL pointing anywhere else is refused. |
| `MARGINALIA_PASSWORD` | *(unset)* | Password for password-protected documents, so it never has to be typed into a chat. |
| `MARGINALIA_INVITE_TOKEN` | *(unset)* | Invite token applied to a document reference that carries none — the stdio equivalent of `&token=`. |
| `MARGINALIA_CLIENT_ID` | *(generated once)* | Identity marker. Override to share one identity across machines. |
| `MARGINALIA_MCP_STATE_DIR` | `~/.config/marginalia-mcp` | Where the client id and per-document links are cached (mode 0600). |
| `MARGINALIA_MCP_NO_PERSIST` | *(unset)* | `1` keeps everything in memory. Document links must then be re-supplied each session, and older comments stop being editable. |
| `MARGINALIA_DOWNLOAD_DIR` | current directory | Default destination for `export_document`. |

### Filesystem access is stdio-only

Over stdio the server runs on your machine, so `export_document` saves where you asked and
`create_document`'s `source_path` reads the file you named.

The hosted endpoint withholds both. Its filesystem is the Marginalia host's, not yours: a
`source_path` there would read the server's files out to whoever connected, and an export
would write chosen bytes to a chosen path — neither behind any access check, since creating
a document needs no invite. The results would be unreachable by the caller anyway, so
nothing is lost. Use the stdio route when you want files on your own disk.

## Access: give the agent its own link

Marginalia has no accounts. Access comes from the URL:
`https://<host>/d/<uid>/<token>`, where the token grants a role.

| Role | Can |
| --- | --- |
| `reader` | read, download |
| `collaborator` | …and comment, create edit proposals |
| `editor` | …and edit the source, accept/reject proposals |
| `admin` | …and manage invites and settings |

Give the agent a **dedicated `collaborator` or `editor` link**, not your
admin link. Marginalia relabels an admin link with the display name of
whoever uses it, so an agent working through your admin link renames it
to "Claude". Mint one from the document's access panel, or:

```
create_invite  document=<your admin URL>  role=editor  display_name=Claude
```

Once any tool has seen a full URL, the token is cached and later calls
can pass the bare uid.

`collaborator` is the safer default: the agent can suggest everything and
decide nothing. `editor` additionally lets it accept proposals and write
to the document directly — useful, but then "suggest" and "apply" are one
approval apart.

## The tools

**Reading**

| Tool | |
| --- | --- |
| `get_identity` | Who the server acts as, which instance, which documents it has links for. |
| `get_document` | Metadata, your role, the outline, and the source — whole document or one `section`. |
| `list_blocks` | Every anchorable block with its id, section, line range and verbatim source. Filter with `section` or `query`. |
| `get_rendered_html` | The HTML the browser viewer shows. |
| `list_history` / `get_version_diff` | Revisions and their diffs. |

**Review**

| Tool | |
| --- | --- |
| `list_threads` | Comments and edit proposals with their discussion and anchored text. `awaiting_my_response: true` is the work queue — open threads whose latest message is somebody else's; `section` scopes it to one chapter. |
| `create_comment` | New comment anchored to a block (by `block_id` or a `anchor_text` snippet). |
| `create_proposal` | A suggested replacement. `answers_thread_id` links it to the comment it answers. |
| `reply_to_thread` | Answer a comment thread or an edit proposal. |
| `respond_to_thread` | `resolve` / `accept` / `reject` / `reopen`, with an optional reply. Accepting a linked proposal also resolves the comment it answers. |
| `react_to_comment` | Toggle an emoji on any message — a comment, a proposal's rationale, or a reply. |
| `get_proposal_diff` | Before/after, plus whether it still applies cleanly. |
| `repair_proposal_anchor` | Re-attach a proposal orphaned by an earlier accept. |
| `edit_comment`, `delete_thread` | Maintain your own contributions. |

**Writing and downloading**

| Tool | |
| --- | --- |
| `edit_document` | Search-and-replace edits saved as a revision. `dry_run` shows the diff first. |
| `update_document` | Replace the whole source. |
| `export_document` | Write `source`, `bundle`, `docx`, `pdf` to disk — `formats: ["all"]` for everything. **stdio only.** |
| `create_document` | Upload markdown/AsciiDoc and get links back. `source_path` reads a local file — **stdio only**. |
| `create_invite`, `list_invites`, `authenticate` | Access management. |

## Reading a chapter at a time

These are long documents, and pulling a whole book's source to work on one chapter spends
the context the work itself needs. `get_document` with `include_source: false` returns the
outline alone — every section with its line range and size:

```
- The Salt Road  #the-salt-road
    lines 1-40, 1.4k chars, 40 lines
  - Chapter One — Departure  #chapter-one-departure
    lines 5-14, 420 chars, 10 lines
  - Chapter Two — The Dunes  #chapter-two-the-dunes
    lines 16-30, 610 chars, 15 lines
```

`get_document`, `list_blocks` and `list_threads` then all take a `section` — the heading
text, its `#slug`, or a `Parent > Child` path — scoping them to that heading and everything
nested under it. Naming a parent pulls its children too, so `section: "The Salt Road"` is
the whole book and `section: "Chapter Two"` is one chapter.

A name that matches nothing gets the section list back; a name that matches several gets
their full paths, rather than a silently chosen wrong chapter.

## Comments become proposals

A comment says what is wrong; a proposal says what to write instead. Linking the two is
what turns a review into a work queue.

Pass `answers_thread_id` to `create_proposal` and Marginalia records a real link, not a
mention in prose: the comment shows **See proposed change**, the proposal shows
**Answers: “…”**, and each is one click from the other in the viewer. Accepting the
proposal then resolves the comment — its request has been carried out. Rejecting leaves it
open, because the request still stands.

The link lives on the proposal, so one comment can collect several: a first attempt you
reject and its replacement both point back at the same request.

`list_threads` with `needs_proposal: true` is the resulting backlog — open comment threads
that no proposal answers yet. It differs from `awaiting_my_response` in the case that
matters: replying *"good point, I'll think about it"* clears the response queue but leaves
the comment on the proposal backlog, where it belongs.

## Anchoring, and why `list_blocks` matters

Comments and proposals attach to *blocks* — a paragraph, a heading, a
list, a single list item, a table cell. Each has a content-hash id, and
`list_blocks` shows that id next to the block's exact source.

An edit proposal replaces a block's **entire source range**. So the
replacement text has to be the complete rewritten block, markdown
structure included: `## Chapter Two` keeps its `##`, a list item keeps
its `- `. A table cell's range excludes the surrounding pipes, so a
proposal on one cell cannot break the table.

Tools that take an anchor accept either an exact `block_id` or an
`anchor_text` snippet. A snippet matching two unrelated blocks is
reported as ambiguous with the candidate ids, rather than guessed at. A
snippet inside a list item resolves to the item, not the enclosing list.

## Downloads

`export_document` writes files locally:

- `source` — the raw markdown or AsciiDoc
- `bundle` — `.marginalia.json`: source plus every comment and proposal
- `docx` — themed Word document; `with_review_comments: true` turns the
  open comments and proposals into native Word review markup
- `pdf` — themed PDF (needs Chromium on the server)

`with_open_proposals_applied: true` exports the document as it *would*
read with every open proposal accepted, without changing the stored
document. `include_assets: true` also downloads attached images.

## Development

```sh
bun test packages/mcp
```

The integration suite starts a real Marginalia server over HTTP and
drives this MCP server through the real protocol, so a change to the API
surfaces as a failing tool call rather than a silently wrong tool.
