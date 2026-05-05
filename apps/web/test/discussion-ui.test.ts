import { describe, expect, test } from 'bun:test';

import {
  buildMentionOptions,
  filterMentionOptions,
  getActiveMention,
} from '../src/components/inline-comments/InlineComposer.js';
import { inlineAvatarInitials } from '../src/components/inline-comments/inlineUtils.js';

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
