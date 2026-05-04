# Threads API Contract

This document defines the unified backend contract for comment threads and
proposal threads.

The public resource is a thread root with:

- one root comment
- zero or more replies
- optional edit proposal data
- one workflow state
- one document-link state
- server-computed capabilities

`/api/documents/:uid/threads` is the authoritative read model.
`/api/documents/:uid/threads/:tid/respond` is the authoritative endpoint for
adding replies and changing thread workflow state.

## Concepts

Workflow state and document-link state are separate:

- thread workflow state: `open | resolved`
- resolution kind: `resolve | accept | reject | null`
- link state: `linked | low-confidence | orphaned`

Thread workflow answers: "is the discussion still open?"
Link state answers: "can the thread still be confidently located in the
document?"

## GET /api/documents/:uid/threads

Returns all thread roots, their replies, optional proposal data, and all
server-computed capabilities.

### Response schema

```ts
type ThreadState = 'open' | 'resolved';
type ThreadLinkStatus = 'linked' | 'low-confidence' | 'orphaned';
type ResolutionKind = 'resolve' | 'accept' | 'reject';

interface ThreadsListResponse {
  threads: Thread[];
  mention_candidates: string[];
  pending_mentions: string[];
}

interface Thread {
  id: string;
  state: ThreadState;
  resolution: ThreadResolution | null;
  link_status: ThreadLinkStatus;
  anchor: ThreadAnchor;
  capabilities: ThreadCapabilities;
  root: CommentNode;
  proposal: EditProposalData | null;
  replies: ReplyNode[];
}

interface ThreadResolution {
  kind: ResolutionKind;
  at: number;
  by_name: string | null;
}

interface ThreadAnchor {
  block_id: string | null;
  quote: string | null;
  prefix: string;
  suffix: string;
  start_offset: number | null;
  end_offset: number | null;
  heading_path: string[] | null;
  section_index: number | null;
  section_index_path: number[] | null;
}

interface ThreadCapabilities {
  reply: boolean;
  resolve: boolean;
  accept: boolean;
  reject: boolean;
  reopen: boolean;
}

interface CommentNode {
  id: string;
  body: string;
  author: {
    client_id: string;
    display_name: string;
  };
  capabilities: CommentCapabilities;
  created_at: number;
  updated_at: number;
}

type ReplyNode = CommentNode;

interface CommentCapabilities {
  edit: boolean;
  delete: boolean;
}

interface EditProposalData {
  whole_document?: boolean;
  // Content (before/after text) is no longer inlined here.
  // Fetch it on demand via GET /:uid/threads/:tid/diff. That endpoint
  // returns { before, after, mergeable }, where `mergeable` is one of
  // 'clean' | 'conflict' | 'stale' | null. The dry-run merge that powers
  // it serializes with all repo writes for the document, so it is only
  // computed when the caller has edit permission OR opts in explicitly
  // with `?mergeable=1`. All other cases return `null`.
}
```

### Response rules

- `threads` contains root threads only.
- `threads[i].root` is always the root comment node for the thread.
- `threads[i].proposal` is `null` for a plain comment thread.
- `threads[i].proposal` is present for a proposal thread.
- `threads[i].replies` contains every reply for the thread, regardless of
  whether the reply was historically stored via `parent_id` or
  `parent_proposal_id`.
- `threads` are returned in `root.created_at ASC`.
- `replies` are returned in `created_at ASC`.
- `mention_candidates` and `pending_mentions` preserve the current comment API
  behavior.

### Example: plain comment thread

```json
{
  "id": "thr_1",
  "state": "open",
  "resolution": null,
  "link_status": "linked",
  "anchor": {
    "block_id": "block_abc",
    "quote": "Original text",
    "prefix": "",
    "suffix": "",
    "start_offset": 10,
    "end_offset": 23,
    "heading_path": ["Section"],
    "section_index": 2,
    "section_index_path": [2]
  },
  "capabilities": {
    "reply": true,
    "resolve": true,
    "accept": false,
    "reject": false,
    "reopen": false
  },
  "root": {
    "id": "c_root",
    "body": "Please clarify this sentence.",
    "author": {
      "client_id": "u1",
      "display_name": "Alice"
    },
    "capabilities": {
      "edit": true,
      "delete": true
    },
    "created_at": 1710000000000,
    "updated_at": 1710000000000
  },
  "proposal": null,
  "replies": []
}
```

### Example: proposal thread

```json
{
  "id": "thr_2",
  "state": "open",
  "resolution": null,
  "link_status": "linked",
  "anchor": {
    "block_id": "block_def",
    "quote": "Old paragraph",
    "prefix": "",
    "suffix": "",
    "start_offset": null,
    "end_offset": null,
    "heading_path": null,
    "section_index": null,
    "section_index_path": null
  },
  "capabilities": {
    "reply": true,
    "resolve": false,
    "accept": true,
    "reject": true,
    "reopen": false
  },
  "root": {
    "id": "c_prop",
    "body": "Suggested rewrite.",
    "author": {
      "client_id": "u2",
      "display_name": "Bob"
    },
    "capabilities": {
      "edit": true,
      "delete": true
    },
    "created_at": 1710000000100,
    "updated_at": 1710000000100
  },
  "proposal": {
    "whole_document": false
  },
  "replies": []
}
```

## POST /api/documents/:uid/threads

Creates a new root thread on a document anchor.

This is the create-side companion to `POST /api/documents/:uid/threads/:tid/respond`.

The difference is:

- `POST /threads` creates the initial root thread
- `POST /threads/:tid/respond` operates on an existing thread

### Request schema

```ts
interface CreateThreadRequest {
  anchor: CreateThreadAnchor;
  body?: string;
  proposal?: CreateThreadProposal | null;
}

interface CreateThreadAnchor {
  block_id: string;
  quote: string;
  prefix?: string;
  suffix?: string;
  start_offset?: number;
  end_offset?: number;
  heading_path?: string[] | null;
  section_index?: number | null;
  section_index_path?: number[] | null;
}

interface CreateThreadProposal {
  proposed_text: string;
  whole_document?: boolean;
}
```

### Request rules

- `anchor` is required.
- `body` is the root comment body.
- `proposal == null` or absent means a plain comment thread.
- `proposal` present means a proposal thread.
- for a plain comment thread:
  - `body` is required
- for a proposal thread:
  - `proposal.proposed_text` is required
  - `body` is optional
  - missing or empty `body` means the root comment body is stored as an empty
    string
- `body`, when present, is trimmed server-side.
- empty `body` after trim is treated as absent.

### Response schema

```ts
interface CreateThreadResponse {
  thread: Thread;
}
```

### Validation rules

- plain comment thread creation is allowed only when:
  - caller has comment permission
- proposal thread creation is allowed only when:
  - caller has proposal permission
- `anchor.block_id` and `anchor.quote` are required for both thread types

### Error codes

These are the stable semantic errors for the endpoint:

- `not-found`
- `invalid-body`
- `forbidden`
- `anchor-required`
- `body-required`
- `proposal-text-required`

### Example: create plain comment thread

```json
{
  "anchor": {
    "block_id": "block_abc",
    "quote": "Original text",
    "prefix": "",
    "suffix": "",
    "start_offset": 10,
    "end_offset": 23
  },
  "body": "Please clarify this sentence."
}
```

### Example: create proposal thread

```json
{
  "anchor": {
    "block_id": "block_def",
    "quote": "Old paragraph"
  },
  "body": "Suggested rewrite.",
  "proposal": {
    "proposed_text": "New paragraph"
  }
}
```

## POST /api/documents/:uid/threads/:tid/respond

Adds a reply, changes thread state, or does both atomically.

This endpoint replaces:

- add-reply-to-comment
- add-reply-to-proposal
- resolve-comment
- accept-proposal
- reject-proposal
- reopen-thread

### Request schema

```ts
type RespondAction = 'resolve' | 'accept' | 'reject' | 'reopen';

interface RespondToThreadRequest {
  body?: string;
  action?: RespondAction;
}
```

### Request rules

- `body` is optional.
- `action` is optional.
- at least one of `body` or `action` must be present.
- `body`, when present, is trimmed server-side.
- empty `body` after trim is treated as absent.
- max `body` length: same as current reply/comment body limit.

### Action semantics

- no `action`, `body` present:
  add one reply only; this is allowed for both open and resolved threads
- `action = 'resolve'`, optional `body`:
  resolve a plain comment thread, optionally adding one reply
- `action = 'accept'`, optional `body`:
  accept a proposal thread, optionally adding one reply
- `action = 'reject'`, optional `body`:
  reject a proposal thread, optionally adding one reply
- `action = 'reopen'`, optional `body`:
  reopen a resolved thread, optionally adding one reply

### Response schema

```ts
interface RespondToThreadResponse {
  thread: Thread;
  created_reply_id: string | null;
}
```

### Response rules

- `thread` is the fully reloaded thread after all changes have been committed.
- `created_reply_id` is the reply id when a reply was created, else `null`.

### Validation rules

- `resolve` is allowed only when:
  - thread has no proposal
  - thread state is `open`
  - caller is root author or admin
- `accept` is allowed only when:
  - thread has a proposal
  - thread state is `open`
  - caller has edit permission
  - thread `link_status` is not `orphaned`
  - `anchor.block_id` is not `null`
- `reject` is allowed only when:
  - thread has a proposal
  - thread state is `open`
  - caller has edit permission, or caller is the root author of the proposal thread
- `reopen` is allowed only when:
  - thread state is `resolved`
  - for a plain comment thread:
    caller is root author or admin
  - for a rejected proposal thread:
    caller has edit permission, or caller is the root author of the proposal thread
  - for an accepted proposal thread:
    caller has edit permission
  - for an accepted proposal thread:
    the accepted change can be safely reverted through the history mechanism
- reply creation is allowed only when:
  - caller has comment permission

### Atomicity

The endpoint runs in one transaction:

1. load thread
2. validate requested action and reply permission
3. insert reply if `body` is present
4. apply workflow transition if `action` is present
5. commit
6. reload thread and return `RespondToThreadResponse`

### Error codes

These are the stable semantic errors for the endpoint:

- `not-found`
- `invalid-body`
- `empty-response`
- `forbidden`
- `not-open`
- `not-resolved`
- `proposal-required`
- `proposal-forbidden`
- `proposal-orphaned`
- `not-reopenable`

Suggested meanings:

- `proposal-required`:
  `accept` or `reject` requested for a plain thread
- `proposal-forbidden`:
  `resolve` requested for a proposal thread
- `proposal-orphaned`:
  `accept` requested, but the proposal thread is orphaned
- `not-reopenable`:
  `reopen` requested for an accepted proposal thread whose accepted change
  cannot be safely reverted through the history mechanism

## Implementation Notes For Current Storage

This section is not part of the public API contract.

Its only purpose is to explain how the server can build the new `/threads`
wire format from the tables that exist today.

Current persistence model:

- table `comments`
- table `comments_edit_proposals`

Schema source:

- [`comments` table in `src/db.ts`](./src/db.ts)
- [`comments_edit_proposals` table in `src/db.ts`](./src/db.ts)

- `comments`
  - stores root comments and replies
  - stores anchor/link data
  - stores authorship and comment body
  - stores `resolved_at` and `resolved_by_name`
- `comments_edit_proposals`
  - optional extension row for a proposal thread root
  - stores proposal payload and proposal workflow

### 1. Root thread selection

A thread root is every row in `comments` where:

- `parent_id IS NULL`
- `parent_proposal_id IS NULL`
- `deleted_at IS NULL`

### 2. Reply selection

Replies for thread `:tid` are every row in `comments` where:

- `deleted_at IS NULL`
- `parent_id = :tid`
  or
- `parent_proposal_id = :tid`

For the public API, both forms are equivalent: they are replies to the root
thread.

New writes for the unified API may currently persist replies using either
`parent_id = :tid` or `parent_proposal_id = :tid`, depending on thread type.
`parent_proposal_id` remains legacy storage and should not leak into the new
wire format.

### 3. Proposal extension lookup

`comments_edit_proposals` here means the current SQLite table named
`comments_edit_proposals`, defined in [`src/db.ts`](./src/db.ts).

It is the existing backend extension table for proposal threads.

It is not a public API object and it is not the canonical thread record.

The canonical thread root still lives in `comments`.

If `comments_edit_proposals.comment_id = thread.id` exists, the thread is a
proposal thread and the row only contributes proposal-specific data.

The public `proposal` object maps as:

```ts
proposal.whole_document <- comments_edit_proposals.is_whole_document == 1
```

Diff content (`before`/`after` text) is no longer inlined in the thread list.
Fetch it on demand via `GET /:uid/threads/:tid/diff`.

No proposal capabilities live inside `proposal`; workflow capabilities are
always exposed on `thread.capabilities`.

Important:

- the thread anchor does NOT come from `comments_edit_proposals`
- the thread anchor comes from the root `comments` row

### 4. Anchor and link state mapping

The public `thread.anchor` maps from the root `comments` row:

```ts
anchor.block_id           <- comments.anchor_block_id
anchor.quote              <- comments.anchor_quote
anchor.prefix             <- comments.anchor_prefix ?? ''
anchor.suffix             <- comments.anchor_suffix ?? ''
anchor.start_offset       <- comments.anchor_start_offset
anchor.end_offset         <- comments.anchor_end_offset
anchor.heading_path       <- parse(comments.anchor_heading_path)
anchor.section_index      <- comments.anchor_section_index
anchor.section_index_path <- parse(comments.anchor_section_index_path)
```

The public `thread.link_status` maps from:

```ts
thread.link_status <- comments.link_status
```

Legacy normalization:

- stored `'active'` must be normalized to `'linked'`

### 5. Workflow state mapping

For plain comment threads, the root comment resolution fields are authoritative:

```ts
if (proposal row does not exist) {
  state = comments.resolved_at == null ? 'open' : 'resolved'
  resolution =
    comments.resolved_at == null
      ? null
      : {
          kind: 'resolve',
          at: comments.resolved_at,
          by_name: comments.resolved_by_name
        }
}
```

For proposal threads, proposal workflow is authoritative:

```ts
if (proposal row exists) {
  if (proposal.status == 'open') {
    state = 'open'
    resolution = null
  } else if (proposal.status == 'accepted') {
    state = 'resolved'
    resolution = {
      kind: 'accept',
      at: proposal.decided_at ?? comments.resolved_at ?? comments.updated_at,
      by_name: proposal.decided_by_name ?? comments.resolved_by_name
    }
  } else if (proposal.status == 'rejected') {
    state = 'resolved'
    resolution = {
      kind: 'reject',
      at: proposal.decided_at ?? comments.resolved_at ?? comments.updated_at,
      by_name: proposal.decided_by_name ?? comments.resolved_by_name
    }
  }
}
```

Legacy normalization for proposal rows:

- stored `'pending'` must be normalized to `'open'`
- stored `'orphaned'` must be normalized to `'open'`
- proposal orphaning is represented only by `thread.link_status = 'orphaned'`

### 6. Comment node mapping

The public `root` and `replies[]` nodes map from `comments` rows:

```ts
node.id                    <- comments.id
node.body                  <- comments.body
node.author.client_id      <- comments.author_client_id
node.author.display_name   <- comments.author_display_name
node.created_at            <- comments.created_at
node.updated_at            <- comments.updated_at
```

### 7. Capability mapping

Per-comment capabilities:

```ts
comment.capabilities.edit =
  viewer.client_id == comments.author_client_id

comment.capabilities.delete =
  viewer.client_id == comments.author_client_id || viewer.role == 'admin'
```

Per-thread capabilities:

```ts
thread.capabilities.reply =
  canComment(viewer.role)

thread.capabilities.resolve =
  proposal row does not exist &&
  thread.state == 'open' &&
  (viewer.client_id == root.author_client_id || viewer.role == 'admin')

thread.capabilities.accept =
  proposal row exists &&
  thread.state == 'open' &&
  canEdit(viewer.role) &&
  thread.link_status != 'orphaned' &&
  thread.anchor.block_id != null

thread.capabilities.reject =
  proposal row exists &&
  thread.state == 'open' &&
  (canEdit(viewer.role) || viewer.client_id == root.author_client_id)

thread.capabilities.reopen =
  thread.state == 'resolved' &&
  (
    (
      proposal row does not exist &&
      (viewer.client_id == root.author_client_id || viewer.role == 'admin')
    ) ||
    (
      proposal row exists &&
      resolution.kind == 'reject' &&
      (canEdit(viewer.role) || viewer.client_id == root.author_client_id)
    ) ||
    (
      proposal row exists &&
      resolution.kind == 'accept' &&
      canEdit(viewer.role) &&
      accepted proposal change is safely revertible through the history mechanism
    )
  )
```

### 8. Write mapping for POST /threads/:tid/respond

If `body` is present:

- insert a new `comments` row
- `parent_id = :tid`
- `parent_proposal_id = NULL`
- `body = request.body`
- author fields from current identity
- `link_status = 'linked'`
- no anchor fields on the reply row

If `action = 'resolve'`:

- update root `comments.resolved_at`
- update root `comments.resolved_by_name`

If `action = 'accept'`:

- apply document change
- re-anchor comments/proposals
- update `comments_edit_proposals.status = 'accepted'`
- update decision metadata
- update root `comments.resolved_at`
- update root `comments.resolved_by_name`

If `action = 'reject'`:

- update `comments_edit_proposals.status = 'rejected'`
- update decision metadata
- update root `comments.resolved_at`
- update root `comments.resolved_by_name`

If `action = 'reopen'` for a plain comment thread:

- clear root `comments.resolved_at`
- clear root `comments.resolved_by_name`

If `action = 'reopen'` for a rejected proposal thread:

- update `comments_edit_proposals.status = 'open'`
- clear proposal decision metadata
- clear root `comments.resolved_at`
- clear root `comments.resolved_by_name`

### 9. Write mapping for POST /threads

If `proposal` is absent:

- insert a root row into `comments`
- `parent_id = NULL`
- `parent_proposal_id = NULL`
- anchor fields from `request.anchor`
- author fields from current identity
- `body = request.body`
- `link_status = 'linked'`
- `resolved_at = NULL`
- `resolved_by_name = NULL`

If `proposal` is present:

- insert the same root row into `comments`
- if `request.body` is absent, store `body = ''`
- insert one extension row into `comments_edit_proposals`
- `comment_id = root_comment.id`
- `branch_ref = refs/proposals/<id>` (one-commit branch in the doc repo)
- `base_oid = current main HEAD`
- `base_block_start`, `base_block_end` = character offsets of replaced block span
- `status = 'open'`
- decision metadata `NULL`

If `action = 'reopen'` for an accepted proposal thread:

- revert the accepted change through the history mechanism
- update `comments_edit_proposals.status = 'open'`
- clear proposal decision metadata
- clear root `comments.resolved_at`
- clear root `comments.resolved_by_name`

## Non-goals for this contract

These are intentionally left out:

- pagination or cursoring
- sort modes beyond the default response order
- bulk thread actions
