import { describe, expect, test } from 'bun:test';

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
