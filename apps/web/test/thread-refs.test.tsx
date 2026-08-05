import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { InlineCommentMarkdown } from '../src/components/inline-comments/InlineCommentMarkdown.js';
import {
  describeThreadRef,
  parseThreadRefHref,
  splitThreadRefs,
  type ThreadRefApi,
  threadRefIndex,
} from '../src/components/inline-comments/threadRefs.js';
import type { Comment, Thread } from '../src/lib/api.js';

const PROPOSAL_ID = 'JZZdDBSASGweF1n_';
const COMMENT_ID = 'r4Nd0mC0mm3ntId0';
const REPLY_ID = 'r3plyC0mm3ntId00';

function comment(id: string, body: string, author = 'Claude'): Comment {
  return {
    id,
    body,
    author: { client_id: `client-${id}`, display_name: author },
    capabilities: { edit: false, delete: false, react: false },
    reactions: [],
    created_at: 0,
    updated_at: 0,
  };
}

function thread(overrides: Partial<Thread> & Pick<Thread, 'id' | 'comments'>): Thread {
  return {
    state: 'open',
    resolution: null,
    link_status: 'linked',
    anchor: {
      block_id: 'b1',
      quote: 'the anchored text',
      prefix: '',
      suffix: '',
      start_offset: 0,
      end_offset: 3,
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
    answered_by_thread_ids: [],
    proposal: null,
    ...overrides,
  };
}

const proposalThread = thread({
  id: PROPOSAL_ID,
  comments: [comment(PROPOSAL_ID, 'Tightens the wording.')],
  proposal: { whole_document: false, answers_thread_id: COMMENT_ID },
});

const commentThread = thread({
  id: COMMENT_ID,
  comments: [comment(COMMENT_ID, 'This reads awkwardly.', 'Paul'), comment(REPLY_ID, 'Agreed.')],
  answered_by_thread_ids: [PROPOSAL_ID],
});

const index = threadRefIndex([proposalThread, commentThread]);
const isRef = (id: string) => index.has(id);

function render(body: string, focus: (target: Thread) => void = () => {}): string {
  const refs: ThreadRefApi = { resolve: (id) => index.get(id) ?? null, focus };
  return renderToStaticMarkup(
    <InlineCommentMarkdown threadRefs={refs}>{body}</InlineCommentMarkdown>,
  );
}

describe('threadRefIndex', () => {
  test('resolves thread ids and the ids of replies inside them', () => {
    expect(index.get(PROPOSAL_ID)).toBe(proposalThread);
    expect(index.get(COMMENT_ID)).toBe(commentThread);
    expect(index.get(REPLY_ID)).toBe(commentThread);
    expect(index.get('nope')).toBeUndefined();
  });
});

describe('splitThreadRefs', () => {
  test('leaves text without a known id untouched', () => {
    expect(splitThreadRefs('Nothing to link here.', isRef)).toBeNull();
    expect(splitThreadRefs('An unrelated Zm9vYmFyYmF6cXV1eA token.', isRef)).toBeNull();
  });

  test('splits around a known id', () => {
    expect(splitThreadRefs(`Addressed in ${PROPOSAL_ID}.`, isRef)).toEqual([
      { text: 'Addressed in ', isRef: false },
      { text: PROPOSAL_ID, isRef: true },
      { text: '.', isRef: false },
    ]);
  });

  test('splits every id in the text, with no leading or trailing gap', () => {
    expect(splitThreadRefs(`${PROPOSAL_ID} answers ${COMMENT_ID}`, isRef)).toEqual([
      { text: PROPOSAL_ID, isRef: true },
      { text: ' answers ', isRef: false },
      { text: COMMENT_ID, isRef: true },
    ]);
  });

  test('ignores an id that is only part of a longer token', () => {
    expect(splitThreadRefs(`x${PROPOSAL_ID}`, isRef)).toBeNull();
    expect(splitThreadRefs(`${PROPOSAL_ID}extra`, isRef)).toBeNull();
  });
});

describe('parseThreadRefHref', () => {
  test('reads the id out of a comment hash link', () => {
    expect(parseThreadRefHref(`#comment-${PROPOSAL_ID}`)).toBe(PROPOSAL_ID);
    expect(parseThreadRefHref('#comment-')).toBeNull();
    expect(parseThreadRefHref('https://example.com/doc#comment-x')).toBeNull();
    expect(parseThreadRefHref('#section')).toBeNull();
  });
});

describe('describeThreadRef', () => {
  test('names the author and what kind of thread it is', () => {
    expect(describeThreadRef(commentThread)).toBe('Comment by Paul on "the anchored text"');
    expect(describeThreadRef(proposalThread)).toBe(
      'Edit proposal by Claude on "the anchored text"',
    );
  });

  test('flags a proposal that is no longer open', () => {
    const rejected = thread({
      ...proposalThread,
      state: 'resolved',
      resolution: { kind: 'reject', at: 0, by_name: 'Paul' },
    });
    expect(describeThreadRef(rejected)).toBe(
      'Edit proposal by Claude (rejected) on "the anchored text"',
    );
  });
});

describe('InlineCommentMarkdown thread references', () => {
  test('links the id the MCP server posts in an inline code span', () => {
    const html = render(`Addressed in edit proposal \`${PROPOSAL_ID}\`.`);
    expect(html).toContain(`<a href="#comment-${PROPOSAL_ID}" class="ic-thread-ref"`);
    expect(html).toContain('Edit proposal by Claude');
    expect(html).toContain(`>${PROPOSAL_ID}</a>`);
  });

  test('links a bare id in prose', () => {
    expect(render(`See ${COMMENT_ID} for the rationale.`)).toContain(
      `<a href="#comment-${COMMENT_ID}" class="ic-thread-ref"`,
    );
  });

  test('leaves ids that name nothing on screen as plain text', () => {
    const html = render('Addressed in edit proposal `Zm9vYmFyYmF6cXV1eA`.');
    expect(html).not.toContain('<a');
    expect(html).toContain('<code>Zm9vYmFyYmF6cXV1eA</code>');
  });

  test('leaves fenced code alone', () => {
    const html = render(`\`\`\`\nthread ${PROPOSAL_ID}\n\`\`\``);
    expect(html).not.toContain('<a');
  });

  test('keeps ordinary links working', () => {
    expect(render('[docs](https://example.com/docs)')).toContain(
      '<a href="https://example.com/docs">docs</a>',
    );
  });

  test('a hand-written link to a thread keeps what its author put on it', () => {
    const html = render(`[the proposal](#comment-${PROPOSAL_ID} "Claude's rewrite")`);
    expect(html).toContain(
      `<a href="#comment-${PROPOSAL_ID}" class="ic-thread-ref" title="Claude&#x27;s rewrite">the proposal</a>`,
    );
  });

  test('does not link a thread whose anchor is gone', () => {
    const orphan = thread({
      ...proposalThread,
      anchor: { ...proposalThread.anchor, block_id: null },
    });
    const refs: ThreadRefApi = { resolve: () => orphan, focus: () => {} };
    const html = renderToStaticMarkup(
      <InlineCommentMarkdown
        threadRefs={refs}
      >{`Addressed in ${PROPOSAL_ID}.`}</InlineCommentMarkdown>,
    );
    expect(html).not.toContain('<a');
  });
});
