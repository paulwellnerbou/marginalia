import { describe, expect, test } from 'bun:test';
import { isClipped } from '../src/components/inline-comments/CollapsibleCommentBody.js';
import {
  filterShortcodes,
  getActiveShortcode,
} from '../src/components/inline-comments/emojiShortcodes.js';
import {
  buildMentionOptions,
  filterMentionOptions,
  getActiveMention,
} from '../src/components/inline-comments/InlineComposer.js';
import {
  inlineAvatarInitials,
  threadCountLabel,
} from '../src/components/inline-comments/inlineUtils.js';
import {
  ALL_THREAD_FILTERS,
  activeThreadFilterLabels,
  cardMatchesFilters,
  isFilteringThreads,
  type ThreadFilters,
} from '../src/components/inline-comments/threadFilters.js';
import type { Thread } from '../src/lib/api.js';

describe('inlineAvatarInitials', () => {
  test('single names use their first two letters', () => {
    expect(inlineAvatarInitials('Paul')).toBe('PA');
    expect(inlineAvatarInitials('Mario')).toBe('MA');
    expect(inlineAvatarInitials('PAUL')).toBe('PA');
  });

  test('multi-part names use uppercase initials from every part', () => {
    expect(inlineAvatarInitials('Paul Wellner Bou')).toBe('PW');
    expect(inlineAvatarInitials('Martin Müller')).toBe('MM');
    expect(inlineAvatarInitials('paul wellner bou')).toBe('PW');
  });

  test('blank names still fall back to a placeholder', () => {
    expect(inlineAvatarInitials('   ')).toBe('?');
  });
});

describe('threadCountLabel', () => {
  test('counts threads while the reader is above the first one', () => {
    expect(threadCountLabel(7)).toBe('7 threads');
    expect(threadCountLabel(7, -1)).toBe('7 threads');
    expect(threadCountLabel(0)).toBe('0 threads');
  });

  test('names the reader position once they are on a thread', () => {
    expect(threadCountLabel(7, 0)).toBe('1 of 7 threads');
    expect(threadCountLabel(7, 5)).toBe('6 of 7 threads');
    expect(threadCountLabel(7, 6)).toBe('7 of 7 threads');
  });

  test('stays a plain count for a single thread', () => {
    expect(threadCountLabel(1)).toBe('1 thread');
    expect(threadCountLabel(1, 0)).toBe('1 thread');
  });

  test('drops a position the thread list no longer has', () => {
    expect(threadCountLabel(3, 3)).toBe('3 threads');
  });
});

describe('inline comment mention autocomplete', () => {
  test('detects an active @ mention at the caret', () => {
    expect(getActiveMention('Please ask @Bo', 'Please ask @Bo'.length)).toEqual({
      start: 11,
      end: 14,
      query: 'Bo',
    });
    expect(getActiveMention('email me@example.com', 'email me@example.com'.length)).toBeNull();
    expect(getActiveMention('@Bob\nnext', '@Bob\nnext'.length)).toBeNull();
  });

  test('dedupes candidates and always includes all', () => {
    expect(buildMentionOptions([' Bob ', 'bob', '', 'Alice'])).toEqual(['all', 'Bob', 'Alice']);
  });

  test('filters candidates by typed query', () => {
    const options = buildMentionOptions(['Alice Adams', 'Bob Baker', 'Carol']);
    expect(filterMentionOptions(options, '', 8)).toEqual([
      'all',
      'Alice Adams',
      'Bob Baker',
      'Carol',
    ]);
    expect(filterMentionOptions(options, 'ali', 8)).toEqual(['Alice Adams']);
    expect(filterMentionOptions(options, 'bak', 8)).toEqual(['Bob Baker']);
  });
});

describe('emoji shortcode autocomplete', () => {
  test('detects `:foo` at the caret', () => {
    expect(getActiveShortcode('hi :thu', 'hi :thu'.length)).toEqual({
      start: 3,
      end: 7,
      query: 'thu',
    });
    expect(getActiveShortcode(':smile', ':smile'.length)).toEqual({
      start: 0,
      end: 6,
      query: 'smile',
    });
  });

  test('lowercases the query so case-insensitive matches work', () => {
    expect(getActiveShortcode(':THUMB', ':THUMB'.length)?.query).toBe('thumb');
  });

  test('ignores `:` mid-word (URLs, ratios, times)', () => {
    expect(getActiveShortcode('https://example.com', 8)).toBeNull();
    expect(getActiveShortcode('1:1 sync', 3)).toBeNull();
    expect(getActiveShortcode('12:30 PM', 5)).toBeNull();
  });

  test('triggers after punctuation, brackets, and quotes', () => {
    expect(getActiveShortcode('(:tada', 6)?.query).toBe('tada');
    expect(getActiveShortcode('"":star', 7)?.query).toBe('star');
    expect(getActiveShortcode('[:rocket', 8)?.query).toBe('rocket');
  });

  test('returns null for an empty query (bare `:`)', () => {
    expect(getActiveShortcode(':', 1)).toBeNull();
  });

  test('returns null when the query contains spaces or punctuation', () => {
    expect(getActiveShortcode(':foo bar', 8)).toBeNull();
    expect(getActiveShortcode(':foo.', 5)).toBeNull();
  });

  test('filterShortcodes ranks prefix matches before substring matches', () => {
    const results = filterShortcodes('star', 4);
    // Both `star` and `star_struck` start with `star`; `star_struck`
    // also lives under the prefix bucket. They should land before any
    // substring-only match.
    const codes = results.map((r) => r.shortcode);
    expect(codes).toContain('star');
    expect(codes.indexOf('star')).toBeLessThan(4);
  });

  test('filterShortcodes scans the full map (no early break)', () => {
    // Regression: an earlier short-circuit on `prefix.length >= limit`
    // made narrow queries miss later prefix matches. With ~100+
    // shortcodes starting with `s`, `:star` lives well past the first
    // 8 entries — and yet should still surface for the bare query `s`.
    const results = filterShortcodes('s', 50);
    const codes = results.map((r) => r.shortcode);
    expect(codes).toContain('star');
    expect(codes).toContain('star_struck');
    expect(codes).toContain('smile');
  });

  test('filterShortcodes promotes exact matches to the top', () => {
    // `star` is the exact match; `star2` and `star_struck` are prefix
    // matches that come from the same scan. The exact match must lead.
    const results = filterShortcodes('star', 3);
    expect(results[0]?.shortcode).toBe('star');
  });

  test('filterShortcodes matches `+1` and `-1` aliases', () => {
    expect(filterShortcodes('+1', 2).map((r) => r.emoji)).toContain('👍');
    expect(filterShortcodes('-1', 2).map((r) => r.emoji)).toContain('👎');
  });

  test('filterShortcodes respects the limit', () => {
    expect(filterShortcodes('a', 3).length).toBeLessThanOrEqual(3);
  });
});

describe('threads-tab filters', () => {
  function makeThread(over: {
    id: string;
    state?: Thread['state'];
    resolution?: Thread['resolution'];
    proposal?: Thread['proposal'];
    /** client_ids of the messages, oldest first. */
    authors?: [string, ...string[]];
    /** created_at of the first message; the rest follow one apart. */
    at?: number;
  }): Thread {
    return {
      id: over.id,
      state: over.state ?? 'open',
      resolution: over.resolution ?? null,
      link_status: 'linked',
      anchor: {
        block_id: 'b1',
        quote: 'quote',
        prefix: '',
        suffix: '',
        start_offset: 0,
        end_offset: 5,
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
      comments: (over.authors ?? ['c']).map((clientId, i) => ({
        id: `${over.id}-c${i + 1}`,
        body: 'hi',
        author: { client_id: clientId, display_name: clientId === 'me' ? 'Me' : 'Bob' },
        capabilities: { edit: true, delete: true, react: true },
        reactions: [],
        created_at: (over.at ?? 1) + i,
        updated_at: (over.at ?? 1) + i,
      })) as [Thread['comments'][0], ...Thread['comments'][0][]],
      answered_by_thread_ids: [],
      proposal: over.proposal ?? null,
    };
  }

  const openComment = makeThread({ id: 'open-comment' });
  const resolvedComment = makeThread({
    id: 'resolved-comment',
    state: 'resolved',
    resolution: { kind: 'resolve', at: 2, by_name: 'Bob' },
  });
  const openProposal = makeThread({
    id: 'open-proposal',
    proposal: { whole_document: false, answers_thread_ids: [] },
  });
  const acceptedProposal = makeThread({
    id: 'accepted-proposal',
    state: 'resolved',
    resolution: { kind: 'accept', at: 3, by_name: 'Bob' },
    proposal: { whole_document: false, answers_thread_ids: [] },
  });

  const all = [openComment, resolvedComment, openProposal, acceptedProposal];
  const matching = (filters: ThreadFilters, viewer: string | null = 'me') =>
    all.filter((t) => cardMatchesFilters(t, [], filters, viewer)).map((t) => t.id);

  test('the default filters keep every thread', () => {
    expect(matching(ALL_THREAD_FILTERS)).toEqual([
      'open-comment',
      'resolved-comment',
      'open-proposal',
      'accepted-proposal',
    ]);
    expect(isFilteringThreads(ALL_THREAD_FILTERS)).toBe(false);
  });

  test('unresolved drops resolved comments and decided proposals alike', () => {
    expect(matching({ ...ALL_THREAD_FILTERS, status: 'unresolved' })).toEqual([
      'open-comment',
      'open-proposal',
    ]);
  });

  test('edit proposals drops plain comments, decided ones included', () => {
    expect(matching({ ...ALL_THREAD_FILTERS, kind: 'proposals' })).toEqual([
      'open-proposal',
      'accepted-proposal',
    ]);
  });

  test('both filters apply together', () => {
    expect(matching({ ...ALL_THREAD_FILTERS, status: 'unresolved', kind: 'proposals' })).toEqual([
      'open-proposal',
    ]);
    expect(isFilteringThreads({ status: 'unresolved', kind: 'proposals', replies: 'all' })).toBe(
      true,
    );
    expect(isFilteringThreads({ status: 'all', kind: 'proposals', replies: 'all' })).toBe(true);
    expect(isFilteringThreads({ status: 'all', kind: 'all', replies: 'unanswered' })).toBe(true);
  });

  describe('unanswered', () => {
    const unanswered: ThreadFilters = { ...ALL_THREAD_FILTERS, replies: 'unanswered' };
    const keeps = (t: Thread, viewer: string | null = 'me') =>
      cardMatchesFilters(t, [], unanswered, viewer);

    test('keeps a thread another author had the last word in', () => {
      expect(keeps(makeThread({ id: 't', authors: ['me', 'c'] }))).toBe(true);
      expect(keeps(makeThread({ id: 't', authors: ['c'] }))).toBe(true);
    });

    test('drops a thread the viewer replied to last, however it opened', () => {
      expect(keeps(makeThread({ id: 't', authors: ['c', 'me'] }))).toBe(false);
      expect(keeps(makeThread({ id: 't', authors: ['me'] }))).toBe(false);
      // Only the last word counts — an earlier reply of the viewer's does not.
      expect(keeps(makeThread({ id: 't', authors: ['c', 'me', 'c'] }))).toBe(true);
    });

    test('an unidentified viewer has answered nothing', () => {
      expect(keeps(makeThread({ id: 't', authors: ['c', 'me'] }), null)).toBe(true);
    });

    test('composes with the other filters', () => {
      const resolvedByViewer = makeThread({
        id: 'resolved-by-me',
        state: 'resolved',
        resolution: { kind: 'resolve', at: 3, by_name: 'Me' },
        authors: ['c', 'me'],
      });
      expect(cardMatchesFilters(resolvedByViewer, [], unanswered, 'me')).toBe(false);
      expect(
        cardMatchesFilters(resolvedByViewer, [], { ...unanswered, replies: 'all' }, 'me'),
      ).toBe(true);
    });
  });

  describe('a merged card of a comment and the proposals nested in it', () => {
    const unanswered: ThreadFilters = { ...ALL_THREAD_FILTERS, replies: 'unanswered' };
    // The shape the pane merges: a comment answered by a proposal, whose
    // "Addressed in edit proposal …" reply leaves the proposer with the
    // comment thread's last word.
    const comment = makeThread({ id: 'comment', authors: ['me', 'c'], at: 1 });
    const proposal = (authors: [string, ...string[]]) =>
      makeThread({
        id: 'proposal',
        authors,
        at: 10,
        proposal: { whole_document: false, answers_thread_ids: ['comment'] },
      });

    test('a reply on the nested proposal answers the whole card', () => {
      expect(cardMatchesFilters(comment, [proposal(['c', 'me'])], unanswered, 'me')).toBe(false);
    });

    test('a later word of someone else’s keeps the card waiting', () => {
      expect(cardMatchesFilters(comment, [proposal(['me', 'c'])], unanswered, 'me')).toBe(true);
      // Answered in the comment thread, then reopened on the proposal.
      const answered = makeThread({ id: 'comment', authors: ['c', 'me'], at: 1 });
      expect(cardMatchesFilters(answered, [proposal(['c'])], unanswered, 'me')).toBe(true);
    });

    test('the newest message wins, whichever thread it sits in', () => {
      // The proposal predates the comment's last word.
      const late = makeThread({ id: 'comment', authors: ['c', 'me'], at: 20 });
      expect(cardMatchesFilters(late, [proposal(['c'])], unanswered, 'me')).toBe(false);
    });

    test('the other filters still keep a card any part of it matches', () => {
      const proposals: ThreadFilters = { ...ALL_THREAD_FILTERS, kind: 'proposals' };
      expect(cardMatchesFilters(comment, [proposal(['c'])], proposals, 'me')).toBe(true);
      expect(cardMatchesFilters(comment, [], proposals, 'me')).toBe(false);
    });
  });

  test('a collapsed filter row can name what is active', () => {
    expect(activeThreadFilterLabels(ALL_THREAD_FILTERS)).toEqual([]);
    expect(activeThreadFilterLabels({ ...ALL_THREAD_FILTERS, status: 'unresolved' })).toEqual([
      'Unresolved',
    ]);
    expect(
      activeThreadFilterLabels({ status: 'unresolved', kind: 'proposals', replies: 'unanswered' }),
    ).toEqual(['Unresolved', 'Proposals', 'Unanswered']);
  });
});

describe('comment body clipping', () => {
  // Illustrative pixels, not the real metrics — the decision is pure
  // arithmetic on whatever the browser measured.
  const LINE = 20;
  const CLAMP = 3 * LINE;

  test('a body that fits its clamp offers no toggle', () => {
    expect(isClipped(LINE, CLAMP)).toBe(false);
    expect(isClipped(CLAMP, CLAMP)).toBe(false);
  });

  test('sub-pixel rounding of a full-height body is not an overflow', () => {
    expect(isClipped(CLAMP + 0.6, CLAMP)).toBe(false);
  });

  test('a body taller than its clamp is clipped', () => {
    expect(isClipped(CLAMP + LINE, CLAMP)).toBe(true);
  });

  test('an unmeasurable clamp reports nothing clipped', () => {
    // Height 0 is what a body that has not been laid out yet reports —
    // treating that as an overflow would flash a toggle on every mount.
    expect(isClipped(0, 0)).toBe(false);
    expect(isClipped(500, 0)).toBe(false);
  });
});
