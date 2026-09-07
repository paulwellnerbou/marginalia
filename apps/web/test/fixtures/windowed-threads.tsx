import { Theme } from '@radix-ui/themes';
import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { InlineCommentsList } from '../../src/components/inline-comments/InlineCommentsList.js';
import { useWindowedList } from '../../src/components/inline-comments/useWindowedList.js';
import type { Thread } from '../../src/lib/api.js';

function thread(i: number): Thread {
  return {
    id: `t${i}`,
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
      start_offset: i,
      end_offset: i + 1,
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
        id: `c${i}`,
        body: `Comment ${i}`,
        created_at: i,
        updated_at: i,
        author: { client_id: 'reviewer', display_name: 'Reviewer' },
        capabilities: { edit: false, delete: false, react: false },
        reactions: [],
      },
    ],
  };
}

const initialCount = Number(new URLSearchParams(location.search).get('count') ?? 120);
const hookMode = new URLSearchParams(location.search).has('hook');
const noop = async () => {};
const action = async () => ({ ok: true as const });
const keys = Array.from({ length: 100 }, (_, i) => `t${i}`);

function HookList() {
  const ref = useRef<HTMLDivElement>(null);
  const win = useWindowedList({ keys, rootRef: ref, estimateHeight: 160 });
  return (
    <div ref={ref} id="rows">
      <div style={{ height: win.padTop }} />
      {keys.slice(win.start, win.end).map((key) => (
        <div key={key} ref={win.measure(key)} data-row={key} style={{ height: 100 }}>
          {key}
        </div>
      ))}
      <div style={{ height: win.padBottom }} />
    </div>
  );
}

function ThreadList() {
  const [threads, setThreads] = useState(() =>
    Array.from({ length: initialCount }, (_, i) => thread(i)),
  );
  const [focus, setFocus] = useState<{ threadId: string; nonce: number } | null>(null);
  Object.assign(window, {
    updateThreads(kind: 'append' | 'reply' | 'focus' | 'shrink' | 'proposal', id = 't90') {
      flushSync(() => {
        if (kind === 'focus') setFocus((prev) => ({ threadId: id, nonce: (prev?.nonce ?? 0) + 1 }));
        if (kind === 'append')
          setThreads((prev) => [
            ...prev,
            ...Array.from({ length: 100 }, (_, i) => thread(prev.length + i)),
          ]);
        if (kind === 'proposal')
          setThreads((prev) => [
            ...prev.map((t) => (t.id === id ? { ...t, answered_by_thread_ids: ['t1000'] } : t)),
            {
              ...thread(1000),
              proposal: {
                whole_document: false,
                answers_thread_ids: [id],
                proposed_text: 'An agent edit proposal.',
              },
            },
          ]);
        if (kind === 'shrink') setThreads((prev) => prev.slice(0, 65));
        if (kind === 'reply')
          setThreads((prev) =>
            prev.map((t) => ({
              ...t,
              comments: [
                ...t.comments,
                {
                  ...t.comments[0],
                  id: `${t.id}-reply-${t.comments.length}`,
                  body: 'An agent reply. '.repeat(80),
                },
              ],
            })),
          );
      });
    },
  });
  return (
    <InlineCommentsList
      uid="test"
      threads={threads}
      blockRanges={new Map()}
      canComment={false}
      focusedThread={focus}
      displayName="Reviewer"
      mentionCandidates={[]}
      onVisibleCountChange={() => {}}
      onReply={noop}
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
  );
}

const app = document.getElementById('app');
if (!app) throw new Error('Missing fixture root');
createRoot(app).render(
  <Theme>
    <div id="scroller" style={{ height: 600, width: 420, overflowY: 'auto' }}>
      {hookMode ? <HookList /> : <ThreadList />}
    </div>
  </Theme>,
);
