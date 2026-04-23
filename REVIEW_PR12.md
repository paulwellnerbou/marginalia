# Code Review: PR #12 — Unify comments and proposals under threads

## Overview

This PR unifies two separate routers (`/comments`, `/edit-proposals`) and their
front-end shims into a single `/threads` API surface. A compatibility layer in
`api.ts` maps thread responses back to the legacy comment/proposal shapes so the
existing React components require minimal changes. The DB migration is solid —
idempotent column renames, data migration wrapped in transactions, and sensible
fallbacks for imported data.

The overall approach is sound and the code quality is high. The issues below are
ordered by severity.

---

## Issues

### ~~#1 🔴 `findBlockBySourceSpan` and `locateDocumentBlocks` duplicated verbatim~~ ✅ Fixed in 42a6de2

~~Both functions appeared in full in `apps/server/src/routes/threads.ts` and
`apps/server/src/routes/edit-proposals.ts`. They were identical.~~

Both functions are now exported from `edit-proposals.ts` and imported by
`threads.ts`. The verbatim copies in `threads.ts` have been removed.

---

### ~~#2 🔴 `store.read` inside an open SQLite transaction in `createThread`~~ ✅ Fixed in 673b224

~~`store.read` was called inside the `BEGIN`/`COMMIT` block, holding a SQLite write
lock during filesystem I/O.~~

`store.read` (and the `readProposalBlockSource` call that depends on it) are now
performed before `db.exec('BEGIN')`, consistent with the accept/reopen paths.

---

### ~~#3 🟡 `acceptEditProposal` always returned `oid: null` but the type said `string | null`~~ ✅ Fixed in 42a6de2

~~The return type `Promise<{ edit_proposal: EditProposal; oid: string | null }>` was
misleading — `oid` was always `null`.~~

`oid` has been dropped from the return type and return value entirely.

---

### ~~#4 🟡 `threadSnapshots` cache is never evicted~~ ✅ Fixed in 4d6712f

~~This module-level Map grows every time a document is visited and is never cleared.
In a long-running tab it accumulates stale data for every document opened. It also
means a missed WebSocket event (e.g. after a reconnect) can cause `findCommentLocation`
to serve stale results.~~

`snapshotGet`/`snapshotSet` helpers now implement an LRU cap of 10 documents using
Map insertion-order. `snapshotGet` bumps an entry to the back on read; `snapshotSet`
evicts the oldest entry when the map exceeds the cap. All four call sites updated.

---

### ~~#5 🟡 Three unconditional table scans on every startup~~ ✅ Fixed

~~These run on every startup even once the migration is complete.~~

Each normalisation UPDATE is now guarded by a `SELECT 1 … LIMIT 1` existence check.
The two proposal-status updates share a single combined check (`status IN ('pending',
'orphaned')`). The `commentor → collaborator` invite migration received the same
treatment for consistency.

---

## Minor observations

### #6 ⚪ `resolveProposalDiffBefore` fallback needs an explanatory comment

The `findBlockBySourceSpan` logic in `edit-proposals.ts` for locating the
pre-accept block when the block ID has shifted is non-trivial. It would benefit
from a comment explaining what the before/after span matching is doing and why
it's needed.

### #7 ⚪ `submitAction` in `CommentComposer` clears draft on failure

The `submitAction` helper clears the textarea after the action runs regardless of
success or failure. If an accept/reject/reopen network call fails, the user's draft
reply is lost. The `send()` path doesn't have this problem because it clears inside
the `try` block before `finally`. Consider the same pattern for `submitAction`.

### #8 ⚪ Test suite lacks direct assertions on thread-shape responses

`flattenThreadComments` in `comments.test.ts` reconstructs the old flat-comment
shape and tests against it. This validates the mapping logic, which is valuable,
but the test suite has no direct assertions on the raw thread-shape responses.
Adding a small set of thread-first assertions would catch regressions in the new
API independently of the compatibility shim.

---

## Summary

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 1 | 🔴 | `findBlockBySourceSpan` / `locateDocumentBlocks` duplicated between `threads.ts` and `edit-proposals.ts` | ✅ Fixed in 42a6de2 |
| 2 | 🔴 | `store.read` inside `BEGIN` transaction in `createThread` | ✅ Fixed in 673b224 |
| 3 | 🟡 | `acceptEditProposal` return type included `oid: string \| null` but always returned `null` | ✅ Fixed in 42a6de2 |
| 4 | 🟡 | `threadSnapshots` module-level cache is never evicted | ✅ Fixed in 4d6712f |
| 5 | 🟡 | Three value-normalisation `UPDATE`s run unconditionally on every startup | ✅ Fixed |
| 6 | ⚪ | `resolveProposalDiffBefore` fallback logic needs an explanatory comment | Open |
| 7 | ⚪ | `submitAction` in `CommentComposer` clears draft on failure | Open |
| 8 | ⚪ | Test suite lacks direct assertions on thread-shape responses | Open |
