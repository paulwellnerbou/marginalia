import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ListThreadsWire, ProposalDiffWire, ThreadWire } from '../api-types.js';
import {
  buildAnchor,
  type DocumentBlock,
  resolveBlock,
  resolveSection,
  sectionContains,
} from '../blocks.js';
import { commentUrl } from '../document-ref.js';
import { lineDiff, threadDetail, threadList, threadStatus } from '../format.js';
import {
  blockDriftNote,
  documentArg,
  failure,
  guard,
  type LoadedDocument,
  loadDocument,
  type ToolContext,
  text,
} from './context.js';

interface ThreadMutationWire {
  thread: ThreadWire;
  created_reply_id?: string | null;
  /** Set when accepting a proposal also closed the comment it answered. */
  resolved_answered_thread_id?: string | null;
}

const blockIdArg = z
  .string()
  .optional()
  .describe('Exact block id from list_blocks. Takes precedence over anchor_text.');

const anchorTextArg = z
  .string()
  .optional()
  .describe(
    'Instead of block_id: a verbatim snippet from the document that occurs in exactly one ' +
      'block. Matched against both the raw source and the rendered text.',
  );

export function registerReviewTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_threads',
    {
      title: 'List comments and edit proposals',
      description:
        'Every review thread on the document — plain comment threads and edit proposals alike ' +
        '— with the full discussion, the text each is anchored to, and what you are allowed to ' +
        'do with it. This is the starting point for working through a reviewer’s comments. ' +
        'Defaults to open threads; pass state="all" to include resolved ones.\n\n' +
        'Comments and the proposals written to answer them are shown linked in both ' +
        'directions. `needs_proposal: true` lists the comments still waiting for one.',
      inputSchema: {
        document: documentArg,
        state: z
          .enum(['open', 'resolved', 'all'])
          .optional()
          .describe(
            'Default "open". "resolved" covers resolved comments and accepted/rejected proposals.',
          ),
        kind: z.enum(['all', 'comments', 'proposals']).optional().describe('Default "all".'),
        thread_id: z
          .string()
          .optional()
          .describe(
            'Show just this one thread, in full. Accepts the id of any message in it, not only ' +
              'the opener — a `#comment-<id>` link from the viewer often names a reply. A ' +
              'document URL carrying such a fragment selects the thread on its own.',
          ),
        section: z
          .string()
          .optional()
          .describe(
            'Only threads anchored inside this section and its subsections — the way to work ' +
              'through a long document one chapter at a time. Heading text, `#slug`, or ' +
              '"Parent > Child".',
          ),
        author: z
          .string()
          .optional()
          .describe('Only threads opened by an author whose name contains this string.'),
        needs_proposal: z
          .boolean()
          .optional()
          .describe(
            'Only open comment threads that no edit proposal answers yet — the exact backlog ' +
              'when asked to turn comments into proposals. Unlike awaiting_my_response this ' +
              'stays true even after you have replied in words, until an actual proposal exists.',
          ),
        awaiting_my_response: z
          .boolean()
          .optional()
          .describe(
            `Only open threads whose latest message is from someone other than ` +
              `"${ctx.client.displayName}" — the work queue when asked to tackle a reviewer’s ` +
              'comments. Excludes threads you opened and nobody answered, and re-includes ones ' +
              'where the reviewer came back after your reply.',
          ),
        include_anchor_source: z
          .boolean()
          .optional()
          .describe('Include the anchored block’s current source under each thread. Default true.'),
        context_blocks: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe(
            'Also show this many blocks of source either side of the anchor — the surrounding ' +
              'paragraphs a comment argues about but does not quote. Default 0; worth raising ' +
              'once narrowed to one thread, since every thread pays for it. Nested blocks are ' +
              'stepped over, so context on a list item is the text around the whole list. ' +
              'Ignored when include_anchor_source is false.',
          ),
        limit: z.number().int().min(1).max(200).optional().describe('Max threads. Default 50.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const loaded = await loadDocument(ctx, args.document);
        const listed = await fetchThreads(ctx, loaded);

        const section = args.section ? resolveSection(loaded.blocks, args.section) : null;

        let threads = listed.threads;
        // A `#comment-<id>` fragment in the document URL means "this
        // thread", so honour it when no id was passed outright. Match on
        // any message in the thread: the viewer's copy-link button sits
        // on replies too, and matching only openers made those links
        // silently return nothing.
        const targetId = args.thread_id ?? loaded.ref.commentId ?? null;
        if (targetId) {
          threads = threads.filter(
            (t) => t.id === targetId || t.comments.some((c) => c.id === targetId),
          );
        }
        if (section) {
          const inSection = new Set(
            loaded.blocks.blocks.filter((b) => sectionContains(section, b)).map((b) => b.id),
          );
          // An orphaned thread has no block id left, so fall back to the
          // heading path it was captured under — otherwise a chapter's
          // orphans would silently vanish from its own review queue.
          threads = threads.filter((t) =>
            t.anchor.block_id
              ? inSection.has(t.anchor.block_id)
              : startsWithPath(t.anchor.heading_path, section.path),
          );
        }
        if (args.kind === 'comments') threads = threads.filter((t) => t.proposal === null);
        if (args.kind === 'proposals') threads = threads.filter((t) => t.proposal !== null);
        const state = args.state ?? 'open';
        if (state === 'open') threads = threads.filter((t) => t.state === 'open');
        else if (state === 'resolved') threads = threads.filter((t) => t.state !== 'open');
        if (args.author) {
          const needle = args.author.toLowerCase();
          threads = threads.filter((t) =>
            (t.comments[0]?.author.display_name ?? '').toLowerCase().includes(needle),
          );
        }
        if (args.needs_proposal) {
          threads = threads.filter(
            (t) =>
              t.proposal === null && t.state === 'open' && t.answered_by_thread_ids.length === 0,
          );
        }
        if (args.awaiting_my_response) {
          // "The last word is not mine." A thread I opened that nobody
          // answered is not waiting on me, and one where the reviewer
          // came back after my reply is — neither of which a
          // "have I posted in it at all" test gets right.
          threads = threads.filter((t) => {
            if (t.state !== 'open') return false;
            const last = t.comments[t.comments.length - 1];
            return last !== undefined && last.author.client_id !== ctx.client.clientId;
          });
        }

        const total = threads.length;
        threads = threads.slice(0, args.limit ?? 50);

        const counts = summarize(listed.threads);
        const header = [
          `document ${loaded.doc.uid} — ${counts}`,
          section ? `section: ${section.path.join(' › ')}` : null,
          !args.thread_id && loaded.ref.commentId
            ? `filtered to the thread named by the link's #comment-${loaded.ref.commentId}`
            : null,
          `showing ${threads.length} of ${total} matching thread(s)`,
          `you are "${ctx.client.displayName}" with role "${loaded.doc.role}"`,
          listed.pending_mentions.length > 0
            ? `you were @-mentioned in: ${listed.pending_mentions.join(', ')}`
            : null,
          listed.mention_candidates.length > 0
            ? `@-mentionable names: ${listed.mention_candidates.join(', ')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n');

        return text(
          header,
          blockDriftNote(loaded.blocks),
          threadList(threads, {
            includeAnchorSource: args.include_anchor_source !== false,
            contextBlocks: args.context_blocks ?? 0,
            blockMap: loaded.blocks,
            ref: loaded.ref,
          }),
        );
      }),
  );

  server.registerTool(
    'create_comment',
    {
      title: 'Comment on part of a document',
      description:
        'Open a new comment thread anchored to a specific block, signed with this server’s ' +
        'display name. Use it to raise a question or flag a knock-on effect elsewhere in the ' +
        'document. To answer an existing thread use reply_to_thread instead; to suggest ' +
        'concrete wording use create_proposal.',
      inputSchema: {
        document: documentArg,
        body: z
          .string()
          .describe('The comment. Markdown is fine; @Name mentions notify that participant.'),
        block_id: blockIdArg,
        anchor_text: anchorTextArg,
        quote: z
          .string()
          .optional()
          .describe(
            'Exact phrase inside the block to highlight. Defaults to anchor_text, or the whole ' +
              'block. Must be the rendered text, not markdown syntax.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const loaded = await loadDocument(ctx, args.document);
        const block = resolveBlock(loaded.blocks, {
          blockId: args.block_id,
          anchorText: args.anchor_text,
        });
        const anchor = buildAnchor(block, args.quote ?? args.anchor_text);
        const { thread } = await ctx.client.json<ThreadMutationWire>(
          loaded.ref,
          `/api/documents/${encodeURIComponent(loaded.ref.uid)}/threads`,
          { method: 'POST', body: { anchor, body: args.body } },
        );
        return text(
          `Commented as "${ctx.client.displayName}" on block ${block.id} (${block.kind}, lines ${block.startLine}-${block.endLine}).`,
          `thread_id: ${thread.id}`,
          `url: ${commentUrl(loaded.ref, thread.id)}`,
          `highlighted: ${JSON.stringify(anchor.quote.slice(0, 200))}`,
        );
      }),
  );

  server.registerTool(
    'create_proposal',
    {
      title: 'Propose a concrete edit',
      description:
        'Create an edit proposal: a suggested replacement the document owner can accept with ' +
        'one click, or comment on further.\n\n' +
        'IMPORTANT: `proposed_text` replaces the target block’s ENTIRE source range, not just ' +
        'the quoted phrase. Read the block with list_blocks first and send back the complete ' +
        'rewritten block, keeping its markdown structure (heading markers, list bullets, ' +
        'indentation). A list item’s range includes its bullet; a table cell’s is just the text ' +
        'between the pipes. The result is shown as a diff so you can verify it.\n\n' +
        'To revise a proposal that already exists, use update_proposal instead of creating a ' +
        'second one.',
      inputSchema: {
        document: documentArg,
        proposed_text: z
          .string()
          .describe('Complete replacement source for the targeted block(s).'),
        rationale: z
          .string()
          .describe('Why the change is proposed. Shown as the proposal’s opening comment.'),
        block_id: blockIdArg,
        anchor_text: anchorTextArg,
        end_block_id: z
          .string()
          .optional()
          .describe(
            'Last block of a multi-block span, to replace several consecutive blocks at once. ' +
              'Only valid for structurally compatible endpoints (e.g. two items of the same list).',
          ),
        whole_document: z
          .boolean()
          .optional()
          .describe(
            'Replace the entire document source with `proposed_text` on accept. Ignores ' +
              'block_id/anchor_text. Use only for sweeping rewrites.',
          ),
        answers_thread_id: z
          .string()
          .optional()
          .describe(
            'The comment thread this proposal answers. Records a real link both ways — the ' +
              'reviewer sees "Proposed change" on their comment — and posts a reply there. ' +
              'Accepting the proposal then resolves that comment automatically. Set this ' +
              'whenever the proposal comes from someone’s comment.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const loaded = await loadDocument(ctx, args.document);
        const first = loaded.blocks.blocks[0];
        let block: DocumentBlock;
        let endBlock: DocumentBlock | null = null;
        if (args.whole_document) {
          if (!first) return failure('The document has no blocks to anchor a proposal to.');
          block = first;
        } else {
          block = resolveBlock(loaded.blocks, {
            blockId: args.block_id,
            anchorText: args.anchor_text,
          });
          endBlock = args.end_block_id
            ? resolveBlock(loaded.blocks, { blockId: args.end_block_id }, 'end block')
            : null;
        }

        const anchor = buildAnchor(
          block,
          args.whole_document ? undefined : args.anchor_text,
          endBlock,
        );
        const { thread } = await ctx.client.json<ThreadMutationWire>(
          loaded.ref,
          `/api/documents/${encodeURIComponent(loaded.ref.uid)}/threads`,
          {
            method: 'POST',
            body: {
              anchor,
              body: args.rationale,
              proposal: {
                proposed_text: args.proposed_text,
                ...(args.whole_document ? { whole_document: true } : {}),
                ...(args.answers_thread_id ? { answers_thread_id: args.answers_thread_id } : {}),
              },
            },
          },
        );

        // The proposal already exists by now. If the courtesy back-link
        // fails — wrong thread id, thread deleted meanwhile — reporting
        // that as a tool error would invite a retry that creates a second
        // proposal. Report it as a partial success and name the one step
        // left to do by hand.
        let notice: string | null = null;
        if (args.answers_thread_id) {
          notice =
            `Linked to thread ${args.answers_thread_id}: it now shows this proposal, and ` +
            'accepting the proposal will resolve it.';
          try {
            await ctx.client.json<ThreadMutationWire>(
              loaded.ref,
              `/api/documents/${encodeURIComponent(loaded.ref.uid)}/threads/${encodeURIComponent(args.answers_thread_id)}/respond`,
              { method: 'POST', body: { body: `Addressed in edit proposal \`${thread.id}\`.` } },
            );
            notice += ' Replied there too.';
          } catch (err) {
            // The link is already stored server-side; only the courtesy
            // reply failed, so this is cosmetic rather than a lost link.
            notice += ` (Could not post the reply: ${err instanceof Error ? err.message : String(err)})`;
          }
        }

        const before = args.whole_document
          ? loaded.doc.source
          : spanSource(loaded.doc.source, block, endBlock);
        return text(
          args.whole_document
            ? 'Created a whole-document edit proposal.'
            : `Created an edit proposal on block ${block.id}${endBlock ? `…${endBlock.id}` : ''} (lines ${block.startLine}-${(endBlock ?? block).endLine}).`,
          `thread_id: ${thread.id}  status: open`,
          `url: ${commentUrl(loaded.ref, thread.id)}`,
          notice,
          `diff:\n${lineDiff(before, args.proposed_text)}`,
        );
      }),
  );

  server.registerTool(
    'update_proposal',
    {
      title: 'Revise an edit proposal in place',
      description:
        'Replace the proposed text of an open edit proposal you authored. The thread keeps its ' +
        'id, discussion, reactions and comment links — use this to act on feedback about a ' +
        'proposal instead of deleting and re-creating it.\n\n' +
        'The replacement is rebuilt against the CURRENT document source, so it also refreshes ' +
        'a proposal whose diff reports "conflict" or "stale". Same rule as create_proposal: ' +
        '`proposed_text` replaces the anchored block(s)’ ENTIRE source range, so send the ' +
        'complete rewritten block(s). The anchor itself cannot be moved.\n\n' +
        'Pass `comment` to leave a revision note in the discussion — say what you changed and ' +
        'why, so reviewers following the thread see how the proposal evolved.',
      inputSchema: {
        document: documentArg,
        thread_id: z.string().describe('Proposal thread id from list_threads.'),
        proposed_text: z
          .string()
          .describe('Complete replacement source for the proposal’s anchored block(s).'),
        rationale: z
          .string()
          .optional()
          .describe('New opening-comment text, when the reasoning changed too.'),
        comment: z
          .string()
          .optional()
          .describe(
            'Reply posted on the thread alongside this revision — a note on what changed. ' +
              'Unlike `rationale` it does not replace anything; it joins the discussion.',
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const res = await ctx.client.json<ThreadMutationWire>(
          ref,
          `/api/documents/${encodeURIComponent(ref.uid)}/threads/${encodeURIComponent(args.thread_id)}`,
          {
            method: 'PATCH',
            body: {
              proposal: { proposed_text: args.proposed_text },
              ...(args.rationale !== undefined ? { body: args.rationale } : {}),
              ...(args.comment !== undefined ? { comment: args.comment } : {}),
            },
          },
        );
        const proposal = res.thread.proposal;
        const diff =
          proposal?.source_snapshot != null && proposal.proposed_text != null
            ? lineDiff(proposal.source_snapshot, proposal.proposed_text)
            : '(diff unavailable)';
        return text(
          `Updated proposal ${args.thread_id} — same thread, new proposed text.`,
          args.rationale !== undefined ? 'Rationale updated too.' : null,
          res.created_reply_id ? `Revision note posted as comment ${res.created_reply_id}.` : null,
          `diff against the current document:\n${diff}`,
        );
      }),
  );

  server.registerTool(
    'reply_to_thread',
    {
      title: 'Reply to a comment or edit proposal',
      description:
        'Post a reply in an existing thread — a comment thread or an edit proposal. Use this ' +
        'to answer a reviewer’s question, explain what you changed, or discuss a proposal ' +
        'without accepting or rejecting it. To reply *and* close the thread in one step, use ' +
        'respond_to_thread.',
      inputSchema: {
        document: documentArg,
        thread_id: z.string().describe('Thread id from list_threads.'),
        body: z.string().describe('The reply. @Name mentions notify that participant.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const res = await ctx.client.json<ThreadMutationWire>(
          ref,
          `/api/documents/${encodeURIComponent(ref.uid)}/threads/${encodeURIComponent(args.thread_id)}/respond`,
          { method: 'POST', body: { body: args.body } },
        );
        return text(
          `Replied as "${ctx.client.displayName}" in thread ${args.thread_id} (now ${threadStatus(res.thread)}).`,
          `comment_id: ${res.created_reply_id ?? 'unknown'}`,
          `url: ${commentUrl(ref, res.created_reply_id ?? args.thread_id)}`,
        );
      }),
  );

  server.registerTool(
    'respond_to_thread',
    {
      title: 'Resolve, reopen, accept or reject a thread',
      description:
        'Close out a thread, optionally with a reply in the same step.\n\n' +
        '  resolve — mark a comment thread done (comment threads only)\n' +
        '  accept  — apply an edit proposal to the document (needs editor access)\n' +
        '  reject  — decline an edit proposal\n' +
        '  reopen  — undo a resolve/accept/reject\n\n' +
        'Accepting a proposal that names an `answers_thread_id` also resolves that comment — ' +
        'its request has been carried out. Rejecting leaves it open.\n\n' +
        'Accepting rewrites the document, which can orphan other open proposals that touched ' +
        'the same text; re-check list_threads afterwards.',
      inputSchema: {
        document: documentArg,
        thread_id: z.string().describe('Thread id from list_threads.'),
        action: z
          .enum(['resolve', 'accept', 'reject', 'reopen'])
          .describe('What to do with the thread.'),
        body: z.string().optional().describe('Optional reply posted alongside the action.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const res = await ctx.client.json<ThreadMutationWire>(
          ref,
          `/api/documents/${encodeURIComponent(ref.uid)}/threads/${encodeURIComponent(args.thread_id)}/respond`,
          {
            method: 'POST',
            body: { action: args.action, ...(args.body ? { body: args.body } : {}) },
          },
        );
        return text(
          `Thread ${args.thread_id}: ${args.action} → now ${threadStatus(res.thread)}.`,
          `url: ${commentUrl(ref, args.thread_id)}`,
          res.resolved_answered_thread_id
            ? `Also resolved comment thread ${res.resolved_answered_thread_id}, which this proposal answered.`
            : null,
          args.action === 'accept'
            ? 'The document source changed. Other open proposals may now be orphaned or conflicting — re-run list_threads.'
            : null,
        );
      }),
  );

  server.registerTool(
    'get_proposal_diff',
    {
      title: 'Diff an edit proposal',
      description:
        'The before/after text for an edit proposal, plus whether it still applies cleanly to ' +
        'the current document ("clean", "conflict", or "stale"). A conflicted or stale proposal ' +
        'of yours can be refreshed with update_proposal.',
      inputSchema: {
        document: documentArg,
        thread_id: z.string().describe('Proposal thread id from list_threads.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const diff = await ctx.client.json<ProposalDiffWire>(
          ref,
          `/api/documents/${encodeURIComponent(ref.uid)}/threads/${encodeURIComponent(args.thread_id)}/diff`,
          { query: { mergeable: '1' } },
        );
        return text(
          `proposal ${args.thread_id} — applies cleanly: ${diff.mergeable ?? 'not evaluated'}`,
          `url: ${commentUrl(ref, args.thread_id)}`,
          `diff:\n${lineDiff(diff.before, diff.after)}`,
        );
      }),
  );

  server.registerTool(
    'edit_comment',
    {
      title: 'Edit one of your own comments',
      description:
        'Rewrite the body of a comment you authored — the opener of a thread or any reply. ' +
        'Comments by other people cannot be edited.',
      inputSchema: {
        document: documentArg,
        thread_id: z.string().describe('Thread the comment belongs to.'),
        comment_id: z
          .string()
          .describe('Comment id from list_threads. Equal to thread_id for a thread opener.'),
        body: z.string().describe('Replacement text.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const base = `/api/documents/${encodeURIComponent(ref.uid)}/threads/${encodeURIComponent(args.thread_id)}`;
        const path =
          args.comment_id === args.thread_id
            ? base
            : `${base}/comments/${encodeURIComponent(args.comment_id)}`;
        await ctx.client.json<ThreadMutationWire>(ref, path, {
          method: 'PATCH',
          body: { body: args.body },
        });
        return text(
          `Updated comment ${args.comment_id}.`,
          `url: ${commentUrl(ref, args.comment_id)}`,
        );
      }),
  );

  server.registerTool(
    'delete_thread',
    {
      title: 'Delete a comment, reply, or proposal',
      description:
        'Permanently remove a thread you opened (or a single reply of yours). Deleting a ' +
        'thread removes its replies too. Prefer resolving or rejecting over deleting — those ' +
        'keep the discussion visible — and prefer update_proposal over delete + re-create ' +
        'when only a proposal’s text needs to change.',
      inputSchema: {
        document: documentArg,
        thread_id: z.string().describe('Thread id from list_threads.'),
        comment_id: z
          .string()
          .optional()
          .describe('Delete only this reply instead of the whole thread.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const base = `/api/documents/${encodeURIComponent(ref.uid)}/threads/${encodeURIComponent(args.thread_id)}`;
        const path =
          args.comment_id && args.comment_id !== args.thread_id
            ? `${base}/comments/${encodeURIComponent(args.comment_id)}`
            : base;
        await ctx.client.json<void>(ref, path, { method: 'DELETE' });
        return text(
          args.comment_id && args.comment_id !== args.thread_id
            ? `Deleted reply ${args.comment_id}.`
            : `Deleted thread ${args.thread_id} and its replies.`,
        );
      }),
  );

  server.registerTool(
    'react_to_comment',
    {
      title: 'Toggle an emoji reaction',
      description:
        'Add or remove an emoji reaction on any message in a thread — the opening comment, the ' +
        'opening rationale of an edit proposal, or any reply. A lightweight acknowledgement ' +
        'when a written reply would be noise ("👍 agreed", "👀 looking at it"). Calling it ' +
        'again with the same emoji removes it.',
      inputSchema: {
        document: documentArg,
        thread_id: z.string().describe('Thread the message belongs to.'),
        comment_id: z
          .string()
          .describe(
            'Message to react to, from list_threads. For the opener of a comment thread or an ' +
              'edit proposal this equals thread_id.',
          ),
        emoji: z.string().describe('A single emoji, e.g. 👍.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const ref = ctx.client.resolve(args.document);
        const res = await ctx.client.json<ThreadMutationWire>(
          ref,
          `/api/documents/${encodeURIComponent(ref.uid)}/threads/${encodeURIComponent(args.thread_id)}/comments/${encodeURIComponent(args.comment_id)}/reactions`,
          { method: 'POST', body: { emoji: args.emoji } },
        );
        const reactions =
          res.thread.comments.find((c) => c.id === args.comment_id)?.reactions ?? [];
        return text(
          `Reactions on ${args.comment_id}: ${
            reactions.length > 0 ? reactions.map((r) => `${r.emoji}×${r.count}`).join(' ') : 'none'
          }`,
        );
      }),
  );

  server.registerTool(
    'repair_proposal_anchor',
    {
      title: 'Re-anchor an orphaned proposal',
      description:
        'Try to re-attach an open edit proposal whose anchor text disappeared — typically ' +
        'because another proposal was accepted first. Succeeds when the original text is still ' +
        'findable; otherwise re-create the proposal against the current source.',
      inputSchema: {
        document: documentArg,
        thread_id: z.string().describe('Orphaned proposal thread id.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (args) =>
      guard(async () => {
        const loaded = await loadDocument(ctx, args.document);
        const res = await ctx.client.json<ThreadMutationWire>(
          loaded.ref,
          `/api/documents/${encodeURIComponent(loaded.ref.uid)}/threads/${encodeURIComponent(args.thread_id)}/repair`,
          { method: 'POST' },
        );
        return text(
          `Repaired proposal ${args.thread_id} — link status is now "${res.thread.link_status}".`,
          threadDetail(res.thread, 1, 1, {
            includeAnchorSource: true,
            contextBlocks: 0,
            blockMap: loaded.blocks,
            ref: loaded.ref,
          }),
        );
      }),
  );
}

/**
 * The source an accept will replace. For a span that is every block from
 * the first through the last, not just the anchor — mirroring the range
 * the server derives from the same two ids (`locateAnchorRange`), so the
 * diff shown here is the change that will actually be applied.
 */
function spanSource(source: string, block: DocumentBlock, endBlock: DocumentBlock | null): string {
  if (!endBlock || endBlock.id === block.id) return block.source ?? '';
  // A block the local source walk could not place has no offsets; the
  // anchor block's own source is then the best available answer.
  if (block.start === null || block.end === null) return block.source ?? '';
  if (endBlock.start === null || endBlock.end === null) return block.source ?? '';
  // min/max rather than assuming document order: the endpoints are two
  // ids from the caller, in whatever order they passed them.
  return source.slice(Math.min(block.start, endBlock.start), Math.max(block.end, endBlock.end));
}

async function fetchThreads(ctx: ToolContext, loaded: LoadedDocument): Promise<ListThreadsWire> {
  // `consume_mentions=false` keeps the server's pending-mention queue
  // intact: listing threads is a read, and a repeat call should still
  // surface "you were mentioned here".
  return ctx.client.json<ListThreadsWire>(
    loaded.ref,
    `/api/documents/${encodeURIComponent(loaded.ref.uid)}/threads`,
    { query: { consume_mentions: 'false' } },
  );
}

function summarize(threads: ThreadWire[]): string {
  const comments = threads.filter((t) => t.proposal === null);
  const proposals = threads.filter((t) => t.proposal !== null);
  const openComments = comments.filter((t) => t.state === 'open').length;
  const openProposals = proposals.filter((t) => t.state === 'open').length;
  const orphaned = threads.filter((t) => t.link_status === 'orphaned').length;
  const needProposal = comments.filter(
    (t) => t.state === 'open' && t.answered_by_thread_ids.length === 0,
  ).length;
  return (
    `${comments.length} comment thread(s) (${openComments} open, ${needProposal} with no ` +
    `proposal yet), ${proposals.length} edit proposal(s) (${openProposals} open)` +
    (orphaned > 0 ? `, ${orphaned} with a lost anchor` : '')
  );
}

/** Is `path` inside `prefix` (or equal to it)? */
function startsWithPath(path: string[] | null, prefix: string[]): boolean {
  if (!path || path.length < prefix.length) return false;
  return prefix.every((segment, i) => path[i] === segment);
}
