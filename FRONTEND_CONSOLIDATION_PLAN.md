# Frontend Consolidation Plan — Comments & Edit-Proposals

**Status:** draft · **Owner:** —

The server DB and API are already unified around a single `thread` concept: a
thread is a rooted conversation that optionally carries proposal data
(`proposed_text`, `source_snapshot`, `anchor_kind`). Comments are threads
with `proposal === null`; edit-proposals are threads with `proposal !== null`.

The frontend has **not** caught up. `apps/web/src/lib/api.ts` calls the unified
`/threads` endpoint but immediately fans the response back out into legacy
`Comment[]` and `EditProposal[]` shapes, and the UI layer is still built
around that split: two item components, two composers, two arrays of state
in `DocumentLayout`, two sets of realtime event types, and two parallel
fetches on mount.

This plan merges the UI onto the server's thread model.

---

## 1. Goals and non-goals

### Goals

- Single source of truth in React state: `threads: Thread[]`.
- Single item renderer (`ThreadItem`) that conditionally shows proposal
  affordances (diff, accept/reject) when `thread.proposal !== null`.
- Single composer (`ThreadComposer`) that handles top-level comments,
  replies to both comments and proposals, and the proposal-creation form.
- Remove the legacy adapter layer in `api.ts`.
- Unified realtime event types (`thread.*`), coordinated with the server.

### Non-goals

- Changing the visual design. The split between "comment card" and
  "proposal card" stays — proposals still have a diff button, status
  badge, and accept/reject. The consolidation is structural.
- Changing the bundle export format in a breaking way. See §8.
- Server-side refactors beyond the event-type rename in §6.

---

## 2. Current state — reference map

Lines are approximate and reflect state at time of writing.

### UI components (`apps/web/src/components/`)

| File | LoC | Role |
|---|---|---|
| `CommentItem.tsx` | 118 | Renders a comment (root or reply) |
| `EditProposalItem.tsx` | 396 | Renders a proposal card (diff, accept/reject, replies via `CommentComposer`) |
| `CommentComposer.tsx` | 277 | `forwardRef` composer with @mention autocomplete, Ctrl/Cmd+Enter submit |
| `EditProposalComposer.tsx` | 163 | Dialog composer for new proposals (block source textarea + rationale) |
| `CommentsPane.tsx` | 782 | Groups `Comment[]` + `EditProposal[]` into threads, sorts, renders |
| `DiscussionUi.tsx` | — | Shared primitives (`DiscussionThread`, `DiscussionEntry`) — already unified |
| `SelectionToolbar.tsx` | — | Defines `ProposalTarget` type locally, fires `onPropose` or `onComment` |
| `DocumentLayout.tsx` | 1266 | Holds state, wires callbacks, subscribes to realtime events |
| `proposalDiff.ts` + `.test.ts` | — | Resolves "before" text for proposal diff viewer |
| `threadCollapseState.ts` + `.test.ts` | — | Unified collapse state (already thread-agnostic) |

### API & data (`apps/web/src/lib/`)

- `api.ts:677–710` — `CommentAnchor`, `Comment`, `CommentLinkStatus`,
  `ListCommentsResponse` (legacy public types).
- `api.ts:718–777` — `Thread`, `ThreadAnchor`, `ThreadCommentNode`,
  `ThreadProposalData`, `ThreadResolution`, `ThreadCapabilities`
  (internal — NOT exported).
- `api.ts:812–839` — `listThreads()` (private), with in-flight dedupe
  and a 10-doc LRU snapshot cache used by `updateComment`/`deleteComment`
  to find a comment's parent thread without a refetch.
- `api.ts:849–964` — `threadsToLegacyComments`, `threadsToLegacyProposals`,
  `threadRootToLegacyComment`, `threadReplyToLegacyComment`,
  `threadAnchorToLegacyAnchor`, `threadToLegacyProposal`,
  `threadToLegacyCommentById`, `threadToLegacyProposalStatus` —
  the adapter layer we are deleting.
- `api.ts:841` — `listComments()` (exported, legacy wrapper).
- `api.ts:1035` — `listEditProposals()` (exported, legacy wrapper).
- `api.ts:1041–1085` — `createComment()` (handles `parent_id` /
  `parent_proposal_id` fork client-side).
- `api.ts:1087–1120` — `updateComment`, `deleteComment`
  (resolve thread via `findCommentLocation`).
- `api.ts:1124–1250` — Edit-proposal CRUD + `getEditProposalDiff`.
- `api.ts:1252–1279` — `resolveComment` (thread-level `resolve`/`reopen`).
- `events.ts:12–22` — `RealtimeEvent` union, still split
  (`comment.created`, `edit_proposal.created`, …).

### State in `DocumentLayout.tsx`

```
comments:              Comment[]          (145)
proposals:             EditProposal[]     (146)
mentionSeedNames:      string[]           (147)
pendingAnchor:         CommentAnchor      (148)  comment composer open
pendingProposalTarget: ProposalTarget     (149)  proposal composer open
focusedThread:         { threadId, nonce} (150)  already unified by id
```

Two parallel fetches in the mount effect (312–332). `refreshThreads`
(499–512) does the same thing again for realtime refresh.

### Callbacks that will collapse

Current (11 callbacks, paired by concept):

- `onCreate` / `onCreateProposal`
- `onEdit` / `onEditProposalRationale`
- `onDelete` / `onDeleteProposal`
- `onResolve` (comment only)
- `onAcceptProposal` / `onRejectProposal`
- `onScrollToAnchor` — already unified

Target (thread-level):

- `onCreateThread(anchor, body, proposal?)`
- `onReply(threadId, body)`
- `onEditBody(threadId, nodeId, body)` — root or reply
- `onDeleteNode(threadId, nodeId)` — root (cascades) or reply
- `onResolveThread(threadId, kind: 'resolve' | 'accept' | 'reject' | 'reopen', body?)`
- `onScrollToAnchor(blockId)`

---

## 3. Target architecture

### 3.1 Types

Promote the internal `Thread` types in `api.ts` to exported, and delete the
legacy `Comment` / `EditProposal` / `CommentAnchor` / `ListCommentsResponse`
interfaces. Rename `CommentAnchor` → `ThreadAnchor` at the public surface
(it already exists internally), and keep `CommentLinkStatus` as
`ThreadLinkStatus`.

Callers import:

```ts
import type {
  Thread,
  ThreadAnchor,
  ThreadCommentNode,
  ThreadProposalData,
  ThreadLinkStatus,
  EditProposalStatus, // derived view, see §3.3
} from '../lib/api.js';
```

### 3.2 Component contract

```
ThreadItem
  thread: Thread
  viewerClientId: string
  canEdit: boolean
  isDocAdmin: boolean
  // callbacks as in §2 "target"
  // proposal-specific props (diff resolution, block ranges) are passed in
  // unconditionally; ThreadItem short-circuits on thread.proposal === null
```

`ThreadItem` renders:

- Root node via `DiscussionEntry`.
- If `thread.proposal !== null`: diff button, `proposed_text` viewer,
  status badge (from `thread.state` + `thread.resolution`), accept/reject
  buttons gated on `thread.capabilities.accept/reject`.
- If `thread.proposal === null`: resolve button gated on
  `thread.capabilities.resolve`.
- Replies list via `DiscussionEntry` per `thread.replies[i]`.
- Inline `ThreadComposer` for replies.

```
ThreadComposer
  mode: 'comment' | 'proposal' | 'reply'
  // 'comment'  → inline, anchor required, no proposed_text
  // 'proposal' → dialog, anchor required, proposed_text textarea required, rationale optional
  // 'reply'    → inline, threadId required, body required, no anchor
  initialAnchor?: ThreadAnchor           // mode 'comment' / 'proposal'
  initialBlockSource?: string            // mode 'proposal', prefills textarea
  threadId?: string                      // mode 'reply'
  mentionCandidates: string[]
  onSubmit: (input: SubmitInput) => Promise<void>
  onCancel: () => void
```

The dialog/inline distinction is a render-time prop, not a new component —
mention autocomplete, Ctrl/Cmd+Enter handling, and draft state are all
shared.

### 3.3 Derived views

Some UI decisions hang off derived predicates that were implicit in the
legacy shapes. Centralize them as helpers in `api.ts` or a new
`lib/thread-views.ts`:

```ts
export function isProposal(t: Thread): t is Thread & { proposal: ThreadProposalData };
export function isComment(t: Thread): boolean; // = !isProposal(t)
export function proposalStatus(t: Thread): EditProposalStatus;
export function isOrphan(t: Thread): boolean;       // link_status === 'orphaned'
export function isResolved(t: Thread): boolean;     // state === 'resolved'
export function rootAuthor(t: Thread): { client_id: string; display_name: string };
```

These replace the ~20 places that currently read
`proposal.comment.link_status`, `proposal.status === 'open'`,
`comment.parent_id === null`, etc.

---

## 4. Migration strategy — phase by phase

The migration is staged so the app stays shippable between phases. Phases
1–3 are behind a green build. Phases 4–7 progressively remove the shims.

### Phase 1 — Expose Thread types (no behavior change)

- `export` the `Thread`, `ThreadAnchor`, `ThreadCommentNode`,
  `ThreadProposalData`, `ThreadResolution`, `ThreadCapabilities` types
  from `api.ts`.
- Export `listThreads()` as a public API alongside the existing legacy
  wrappers.
- Add the `isProposal` / `proposalStatus` / etc. helpers from §3.3.
- No call sites change yet.

**Risk:** none.

### Phase 2 — Switch `DocumentLayout` state to `Thread[]`

- Replace `comments: Comment[]` + `proposals: EditProposal[]` with
  `threads: Thread[]`.
- Replace the two parallel mount fetches (312–332) with a single
  `listThreads(doc.uid)` call.
- Rewrite `refreshThreads` (499–512) to the same single call.
- Rewrite `commentHighlights` (703–760) to iterate `threads` once,
  branching on `isProposal(t)` for the range-vs-block-scope split.
- Rewrite `mentionCandidates` (391–399) to walk
  `threads.flatMap(t => [t.root, ...t.replies]).map(n => n.author.display_name)`.
- Rewrite `threadCount` (699–702) to `threads.length` (every thread
  has exactly one root).
- Pass `threads` to `CommentsPane` alongside the existing
  `comments`/`proposals` props — props coexist during migration.

**Tests:** update any tests touching `DocumentLayout` state. Run the
web test suite (`bun test -- apps/web`).

**Risk:** medium. `commentHighlights` logic is subtle (block vs range
scope). Pin behavior with a manual QA pass: open a doc with mixed
comments + open proposals, verify highlights match pre-change.

### Phase 3 — Update `CommentsPane` to consume `Thread[]`

- Add a `threads: Thread[]` prop; keep `comments` and `proposals` as
  deprecated optional props for one cycle.
- Rewrite the `AnchorGroup` / `ProposalThread` grouping logic to work
  off `threads`:
  - Group by `thread.anchor.block_id` + `section_index_path` for
    document-order sort.
  - Sort by `max(thread.root.created_at, ...replies.created_at)` for
    latest-activity mode.
  - Orphan bucket: `threads.filter(t => t.link_status === 'orphaned')`.
- Render each thread with `<ThreadItem thread={t} …/>` (new component,
  see Phase 4). Until then, branch inside `CommentsPane` on
  `isProposal(t)` and render the existing `<CommentItem>` / `<EditProposalItem>`
  by converting back via the adapters.
- `threadCollapseState` already works off thread IDs — no change.

**Risk:** medium. 782-line file. Land in a PR with screenshots.

### Phase 4 — Build `ThreadItem` and cut over

- Create `components/ThreadItem.tsx` combining `CommentItem` +
  `EditProposalItem`. Extract proposal-only subtrees
  (`ProposalDiffSection`, `ProposalActionsRow`) as internal components
  inside the file — not separate files.
- Reuse `proposalDiff.ts` unchanged (its contract is already thread-shaped
  — it takes a proposal's `source_snapshot` + `proposed_text` + a block
  source).
- `CommentsPane` now renders `<ThreadItem>` unconditionally.
- Delete the adapter-back-to-legacy bridge in `CommentsPane`.

**Tests:**
- `discussion-ui.test.ts` — retarget `avatarInitials` on thread authors.
- `proposalDiff.test.ts` — adapt the inline `Thread & { proposal }`
  fixtures (rename `EditProposal` → `Thread`, move `source_snapshot`
  / `proposed_text` under `thread.proposal`).
- `threadCollapseState.test.ts` — already works on thread IDs; may
  just need fixture shape updates.

**Risk:** medium-high. Longest-running PR of the migration. Split if
needed: land `ThreadItem` for comments-only first, then add proposal
branches, then wire up.

### Phase 5 — Build `ThreadComposer` and cut over

- Create `components/ThreadComposer.tsx` absorbing `CommentComposer`
  (inline, mentions, Ctrl+Enter) and `EditProposalComposer` (dialog,
  proposed_text textarea, rationale).
- Thread the `mode` prop through `CommentsPane` and `DocumentLayout`.
- `SelectionToolbar` keeps `onComment` / `onPropose` callbacks but both
  resolve to `setPendingThreadDraft({ mode, anchor })` in
  `DocumentLayout`. Consolidate `pendingAnchor` +
  `pendingProposalTarget` into one state:
  ```ts
  pendingDraft: { mode: 'comment' | 'proposal'; anchor: ThreadAnchor } | null
  ```
- `ProposalTarget` (the minimal `{ block_id, block_text }` local to
  `SelectionToolbar`) stays as an internal type; the toolbar still
  produces it, but `DocumentLayout` upgrades it to a full `ThreadAnchor`
  before storing in `pendingDraft`.

**Risk:** medium. Dialog-vs-inline layout is the tricky bit. Verify
existing proposal-composer behavior (Escape to close, textarea seeded
with block source, rationale field optional) survives.

### Phase 6 — Collapse `DocumentLayout` callbacks

- Replace the 11 paired callbacks with the 6 thread-level callbacks
  from §2.
- Update `createComment` call sites:
  - Top-level comment → `createThread({ anchor, body })`.
  - Reply → `replyToThread(threadId, body)`. **This requires the server
    to accept a single reply endpoint that doesn't care whether the
    parent is a comment or a proposal.** The server already does this:
    `/threads/:id/respond` accepts replies for any thread. The
    `parent_id` / `parent_proposal_id` client-side fork in
    `createComment` (api.ts:1041) is vestigial and can be deleted.
- Remove the `parent-conflict` ApiError guard (api.ts:1051) — it becomes
  unrepresentable once there's only `threadId`.

**Risk:** low once Phases 4–5 have landed. Mostly a rename pass.

### Phase 7 — Unify realtime events

**Server coordination required.** Rename event types:

| Old | New |
|---|---|
| `comment.created`, `edit_proposal.created` | `thread.created` |
| `comment.updated`, `edit_proposal.updated` | `thread.updated` |
| `comment.deleted`, `edit_proposal.deleted` | `thread.deleted` |
| `mention.created` | stays (payload becomes a thread or a `{thread_id, reply_id}` pair) |
| `reply.created` | new? or fold into `thread.updated`? — decide with server |

Two options:
1. **Big bang:** rename on both sides, deploy together.
2. **Compat window:** client listens for both old + new for one release;
   server emits both; after a week, client drops old, server drops old.

Recommend (2) for safety.

Payload shape: emit the full `Thread` on create/update. On delete,
emit `{ thread_id }`. The client's handler becomes:

```ts
case 'thread.created':
case 'thread.updated':
  setThreads(prev => upsertById(prev, event.thread));
  if (event.thread.root.author.client_id !== viewerClientId && event.reason === 'mention') {
    notifyMention(event.thread);
  }
  break;
case 'thread.deleted':
  setThreads(prev => prev.filter(t => t.id !== event.thread_id));
  break;
```

**Open question:** the current `mention.created` event duplicates
`comment.created` when the new comment includes an @mention of the
viewer. The cleanest consolidation is to add `reason: 'mention' | …`
to `thread.created`/`thread.updated` rather than a separate event.

### Phase 8 — Delete dead code

Once no imports remain:

- `CommentItem.tsx`, `EditProposalItem.tsx`, `CommentComposer.tsx`,
  `EditProposalComposer.tsx` — delete.
- `threadsToLegacyComments`, `threadsToLegacyProposals`,
  `threadRootToLegacyComment`, `threadReplyToLegacyComment`,
  `threadAnchorToLegacyAnchor`, `threadToLegacyProposal`,
  `threadToLegacyCommentById`, `threadToLegacyProposalStatus` in
  `api.ts` — delete.
- `listComments()`, `listEditProposals()` in `api.ts` — delete.
- `Comment`, `EditProposal`, `CommentAnchor`, `ListCommentsResponse`,
  `EditProposalStatus` (if fully replaced by helper) interfaces —
  delete or keep as re-exports aliased to thread shapes for one release.
- `findCommentLocation` / `findCommentLocationInThreads` in `api.ts`
  — keep; still useful for `updateComment` and `deleteComment` if we
  keep supporting "edit/delete by node id" without requiring the caller
  to know which thread it belongs to.

---

## 5. Work items not covered in the initial plan

These are the gaps I missed on the first pass. Each is a real task.

### 5.1 Tests

- `apps/web/test/discussion-ui.test.ts` — re-seat on `Thread` fixtures.
- `apps/web/src/components/proposalDiff.test.ts` — rewrite fixtures
  from the legacy `EditProposal` shape to `Thread & { proposal }`.
  Logic unchanged; inputs restructured.
- `apps/web/src/components/threadCollapseState.test.ts` — check fixture
  shape; logic already thread-keyed.

### 5.2 Bundle import/export

`apps/web/src/lib/api.ts:40–82` defines `ExportedComment` and
`DocumentBundle`. Today:

- `exportDocumentBundle()` returns `comments: ExportedComment[]` only —
  **proposals are not exported**.
- `importDocumentBundle()` imports comments only.

Decide:

- **(a) Keep bundle comment-only**, as today. Cheapest. But users lose
  edit-proposal history on export/import.
- **(b) Bump bundle version** from v3 → v4, add
  `edit_proposals: ExportedEditProposal[]` (or better:
  `threads: ExportedThread[]` encompassing both). Server + client
  coordinate.

Recommend (b) in a follow-up; **not on the critical path** for the UI
consolidation. Callers: `DocumentSettingsDialog.tsx:78` (export),
`HomePage.tsx:552–553` (import).

### 5.3 Mention notifications

`DocumentLayout.tsx:1234–1245` has `notifyPendingMentions(comments, ids)`
and `notifyMention(comment)` — both keyed to the legacy `Comment` shape.

Refactor to `notifyPendingMentions(threads, ids)` that walks
`thread.root` and `thread.replies` to find the mentioned node, and
`notifyMention(thread, nodeId)` so the toast can link to the right
permalink target.

### 5.4 CSS / styles

`apps/web/src/styles/app.css`:

- `.proposal-rationale-empty` (line 1352)
- `.proposal-review-actions` (line 2106)
- `.edit-proposal-composer` (line 2095)
- `.diff-view`, `.diff-line`, `.diff-add`, `.diff-remove`

All proposal-scoped. Rename per taste — suggest
`.thread-proposal-rationale-empty`, `.thread-proposal-actions`,
`.thread-composer--proposal`, keep diff-viewer classes. None are keyed
to JS logic; pure cosmetic rename.

### 5.5 `HistoryList` + revert flow

`components/HistoryList.tsx:320` has a "Open proposal" button that calls
`onOpenThread(proposal.id)`. `HistoryEntry.proposal` (api.ts:123) is a
small `{id, author, summary}` shape — fine to keep.

`DocumentLayout.tsx:781` — the `reopened_proposal_id` returned from
`revertHistoryVersion` is used to focus a reopened thread after a
revert. Keep as-is; rename variable to `reopenedThreadId` (already done
locally) but the API response field is server-owned. A follow-up could
rename `reopened_proposal_id` → `reopened_thread_id` in the server
response; not blocking.

### 5.6 `SelectionToolbar` — `ProposalTarget` vs `CommentAnchor`

The toolbar defines a minimal `ProposalTarget = { block_id, block_text }`
locally because at the moment of click it only knows the block, not a
full anchor. `DocumentLayout` later resolves this into a full anchor
via the block source lookup.

Options:

- **Keep `ProposalTarget` local, but feed through `pendingDraft` (§5, Phase 5).**
  Recommended. Minimal blast radius.
- Unify on `ThreadAnchor` by computing the full anchor at click time.
  Costs an extra parse per toolbar-open. Not worth it.

### 5.7 Parallel-fetch collapse

`DocumentLayout.tsx:312–332` currently fires `listComments` and
`listEditProposals` in parallel. Both hit the same underlying
`listThreads` with in-flight dedupe, so it's one HTTP request — but
two adapter passes. Collapsed to a single `listThreads` call in Phase 2.

### 5.8 Stale `CommentT` alias

`DocumentLayout.tsx:63` has `import type { Comment as CommentT }` that
only exists because of an old naming collision. Delete in Phase 8.

### 5.9 `parent-conflict` guard

`api.ts:1051` throws `ApiError(400, 'parent-conflict')` client-side if
both `parent_id` and `parent_proposal_id` are set. Becomes
unrepresentable once the payload is `{ parent_thread_id }`. Delete in
Phase 6.

### 5.10 Blocked: `blockRanges` prop plumbing

`blockRanges: Map<string, BlockSourceRange>` is computed in
`DocumentLayout` (164–168), passed to `CommentsPane`, which passes to
each `EditProposalItem` (for diff). With `ThreadItem`, this prop moves
to every item but is only read when `thread.proposal !== null`.
Acceptable — the prop is a `Map` reference, not a data copy.

---

## 6. Task list

Phase / task checkboxes. Each phase should be one PR unless noted.

### Phase 1 — Expose Thread types

- [ ] Export `Thread`, `ThreadAnchor`, `ThreadCommentNode`,
      `ThreadProposalData`, `ThreadResolution`, `ThreadCapabilities`,
      `ThreadLinkStatus` from `api.ts`.
- [ ] Export `listThreads(uid)` publicly.
- [ ] Add `isProposal`, `isComment`, `proposalStatus`, `isOrphan`,
      `isResolved`, `rootAuthor` helpers in `api.ts` or
      `lib/thread-views.ts`.
- [ ] Green build + existing tests pass.

### Phase 2 — DocumentLayout state → Thread[]

- [ ] Replace `comments`/`proposals` state with `threads: Thread[]`.
- [ ] Collapse two parallel fetches to one `listThreads` call.
- [ ] Rewrite `refreshThreads` around `setThreads`.
- [ ] Rewrite `commentHighlights` to iterate `threads` once.
- [ ] Rewrite `mentionCandidates` against thread nodes.
- [ ] Rewrite `threadCount`.
- [ ] Temporarily keep `comments`/`proposals` as `useMemo`-derived views
      to preserve downstream props; they disappear in Phase 3.
- [ ] Manual QA: highlights, mention dropdown, counts.

### Phase 3 — CommentsPane consumes Thread[]

- [ ] Add `threads: Thread[]` prop; deprecate `comments` + `proposals`.
- [ ] Rewrite grouping + sorting logic off `threads`.
- [ ] Rewrite orphan bucket off `t.link_status`.
- [ ] Delete derived `comments`/`proposals` memos from `DocumentLayout`.
- [ ] Visual regression: open a doc with mixed content, screenshot
      before/after.

### Phase 4 — ThreadItem

- [ ] Create `components/ThreadItem.tsx` with the unified contract.
- [ ] Extract `ProposalDiffSection`, `ProposalActionsRow` as internal
      subcomponents.
- [ ] Swap `CommentsPane` to render `<ThreadItem>` unconditionally.
- [ ] Update `discussion-ui.test.ts` fixtures.
- [ ] Update `proposalDiff.test.ts` fixtures to `Thread & { proposal }`.
- [ ] Update `threadCollapseState.test.ts` fixtures if needed.

### Phase 5 — ThreadComposer

- [ ] Create `components/ThreadComposer.tsx` with `mode: 'comment' | 'proposal' | 'reply'`.
- [ ] Consolidate `pendingAnchor` + `pendingProposalTarget` into
      `pendingDraft` in `DocumentLayout`.
- [ ] Route `SelectionToolbar.onComment` / `onPropose` through the
      unified draft.
- [ ] Delete `CommentComposer.tsx` and `EditProposalComposer.tsx`.

### Phase 6 — Callbacks & reply routing

- [ ] Collapse 11 paired callbacks in `DocumentLayout` to 6 thread-level
      callbacks.
- [ ] In `api.ts`, rewrite `createComment` so replies take a single
      `parent_thread_id` and post to `/threads/:id/respond`.
- [ ] Delete `parent-conflict` guard.
- [ ] Rename `createComment` → `createThreadReply`/`createThread`;
      keep one-line deprecated re-exports for one release.
- [ ] Refactor `notifyPendingMentions` / `notifyMention` to take
      `Thread` + optional `nodeId`.

### Phase 7 — Realtime events

- [ ] **Server:** emit new `thread.created` / `thread.updated` /
      `thread.deleted` events alongside existing ones.
- [ ] **Client:** teach `events.ts` the new types; `DocumentLayout`
      handler branches handle both old and new for one release.
- [ ] Fold `mention.created` into `thread.created` /`thread.updated`
      via a `reason: 'mention'` field (decide with server team).
- [ ] Release cycle gap.
- [ ] Remove old event types from both ends.

### Phase 8 — Dead code removal

- [ ] Delete `CommentItem.tsx`, `EditProposalItem.tsx`,
      `CommentComposer.tsx`, `EditProposalComposer.tsx`.
- [ ] Delete adapter fns in `api.ts` (`threadsToLegacyComments` and
      siblings).
- [ ] Delete `listComments`, `listEditProposals` from `api.ts`.
- [ ] Delete legacy `Comment`, `EditProposal`, `CommentAnchor`,
      `ListCommentsResponse` types (or keep as aliases for one
      release).
- [ ] Delete stale `CommentT` alias in `DocumentLayout`.
- [ ] Rename `.proposal-*` / `.edit-proposal-*` CSS classes per §5.4.
- [ ] Grep the repo for residual references.

### Follow-ups (not blocking)

- [ ] Bundle v4 with threads (§5.2).
- [ ] Server rename: `reopened_proposal_id` → `reopened_thread_id`
      in `revertHistoryVersion` response.
- [ ] Consider hoisting thread state into a `useThreads(uid)` hook
      (DocumentLayout is 1266 lines; threads ownership is a natural
      extraction).

---

## 7. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Highlight regressions in `commentHighlights` after Phase 2 rewrite | Medium | Manual QA with mixed doc; consider snapshot test of highlight output for a fixture |
| `ThreadItem` PR too large to review | Medium | Split: comment-only `ThreadItem` first, add proposal branches in a follow-up PR |
| Realtime event rename causes cross-client desync during rollout | High if big-bang, low with compat window | Use two-release compat window (Phase 7) |
| Bundle v3 docs in the wild break if we bump to v4 prematurely | Medium | Keep v3 import path working; feature-detect on bundle version |
| CSS rename breaks someone's custom stylesheet override | Low | Document the rename in changelog; these classes aren't part of a public API |

---

## 8. Open questions

1. **Reply event granularity.** Does the server emit a `thread.updated`
   when a reply is added, or a dedicated `reply.created`? Decide before
   Phase 7.
2. **Bundle format.** Commit to v4-with-threads or stay comment-only?
   Out of scope for this plan but worth a decision so we don't redo
   the adapter work.
3. **Proposal resolution on revert.** Today `revertHistoryVersion`
   reopens the proposal and returns its ID. With the thread model,
   does it "reopen" the thread (state: resolved → open) or keep the
   accepted resolution and just un-apply the source change? Verify the
   server behavior and document it.
4. **Comments on proposals vs comments on proposal _replies_.** The
   legacy `parent_proposal_id` let a reply attach to a proposal. With
   `parent_thread_id`, replies attach to the thread, not to the
   proposal specifically. Confirm this matches server semantics
   (spoiler: it does — the server endpoint is `/threads/:id/respond`).
