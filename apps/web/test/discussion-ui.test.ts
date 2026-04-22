import { describe, expect, test } from 'bun:test';

import { avatarInitials } from '../src/components/DiscussionUi.tsx';

describe('avatarInitials', () => {
  test('single names keep their first two letters as typed', () => {
    expect(avatarInitials('Paul')).toBe('Pa');
    expect(avatarInitials('Mario')).toBe('Ma');
    expect(avatarInitials('PAUL')).toBe('PA');
  });

  test('multi-part names use uppercase initials from every part', () => {
    expect(avatarInitials('Paul Wellner Bou')).toBe('PWB');
    expect(avatarInitials('Martin Müller')).toBe('MM');
    expect(avatarInitials('paul wellner bou')).toBe('PWB');
  });

  test('blank names still fall back to a placeholder', () => {
    expect(avatarInitials('   ')).toBe('?');
  });
});
