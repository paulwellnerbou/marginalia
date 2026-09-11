import { Theme } from '@radix-ui/themes';
import { createRoot } from 'react-dom/client';
import { InlineCommentsList } from '../../src/components/inline-comments/InlineCommentsList.js';
import type { Thread } from '../../src/lib/api.js';

const thread: Thread = {
  id: 't0',
  state: 'open',
  resolution: null,
  link_status: 'linked',
  proposal: null,
  answered_by_thread_ids: [],
  anchor: {
    block_id: 'b1',
    quote: 'Review this sentence',
    prefix: '',
    suffix: '',
    start_offset: 0,
    end_offset: 1,
    heading_path: null,
    section_index: null,
    section_index_path: null,
  },
  capabilities: {
    reply: true,
    resolve: true,
    accept: false,
    reject: false,
    repair: false,
    reopen: false,
  },
  comments: [
    {
      id: 'c0',
      body: 'Opening comment',
      created_at: 0,
      updated_at: 0,
      author: { client_id: 'reviewer', display_name: 'Reviewer' },
      capabilities: { edit: false, delete: false, react: false },
      reactions: [],
    },
  ],
};

// The test flips `replyOutcome` to stand in for a server that is down
// and then back up; `replies` records every attempted body.
const hooks = { replyOutcome: false, replies: [] as string[] };
Object.assign(window, { replyDraft: hooks });

const noop = async () => {};
const action = async () => ({ ok: true as const });

const app = document.getElementById('app');
if (!app) throw new Error('Missing fixture root');
createRoot(app).render(
  <Theme>
    <InlineCommentsList
      uid="test"
      threads={[thread]}
      blockRanges={new Map()}
      canComment
      focusedThread={null}
      displayName="Reviewer"
      mentionCandidates={[]}
      onVisibleCountChange={() => {}}
      onReply={async (_threadId, body) => {
        hooks.replies.push(body);
        return hooks.replyOutcome;
      }}
      onEdit={noop}
      onSetHidden={noop}
      onDeleteNode={noop}
      onDeleteThread={noop}
      onResolveThread={action}
      onRepairThread={action}
      onResolveConflict={action}
      onReact={noop}
      onScrollToAnchor={() => {}}
    />
  </Theme>,
);
