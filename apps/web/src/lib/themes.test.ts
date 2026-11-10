import { describe, expect, test } from 'bun:test';
import { canOfferThemeAsDefault, themeOverrideFor } from './themes.js';

describe('themeOverrideFor', () => {
  test('picking the document default stores no override', () => {
    expect(themeOverrideFor('book', 'book')).toBeNull();
  });

  test('any other pick is stored', () => {
    expect(themeOverrideFor('article', 'book')).toBe('article');
  });
});

describe('canOfferThemeAsDefault', () => {
  test('an admin off the default is offered it', () => {
    expect(canOfferThemeAsDefault({ role: 'admin', theme: 'article', defaultTheme: 'book' })).toBe(
      true,
    );
  });

  test('not when the theme already is the default', () => {
    expect(canOfferThemeAsDefault({ role: 'admin', theme: 'book', defaultTheme: 'book' })).toBe(
      false,
    );
  });

  test.each(['editor', 'collaborator', 'reader'] as const)('never to a %s', (role) => {
    expect(canOfferThemeAsDefault({ role, theme: 'article', defaultTheme: 'book' })).toBe(false);
  });
});
