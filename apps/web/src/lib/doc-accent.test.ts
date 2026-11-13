import { expect, test } from 'bun:test';
import { accentOverrideFor, accentResetTarget, effectiveAccent } from './doc-accent.js';

const DOC = '#d6ec4e';
const PICK = '#2156a5';

test('a pick wins over the document default, which wins over the theme', () => {
  expect(effectiveAccent(PICK, DOC)).toBe(PICK);
  expect(effectiveAccent(null, DOC)).toBe(DOC);
  expect(effectiveAccent(null, null)).toBeNull();
});

test('the theme override hides a document default', () => {
  expect(effectiveAccent('theme', DOC)).toBeNull();
});

test('a garbled stored pick falls back to the document default', () => {
  expect(effectiveAccent('lime', DOC)).toBe(DOC);
});

test('choosing what the document already shows stores nothing', () => {
  expect(accentOverrideFor(DOC, DOC)).toBeNull();
  expect(accentOverrideFor(null, null)).toBeNull();
});

test("choosing the theme's accent over a document default is stored", () => {
  expect(accentOverrideFor(null, DOC)).toBe('theme');
});

test('a pick is stored lowercased', () => {
  expect(accentOverrideFor('#2156A5', DOC)).toBe(PICK);
});

test('reset steps down one level: pick → document → theme', () => {
  const at = (override: string | null, docDefault: string | null) =>
    accentResetTarget({ override, docDefault, accent: effectiveAccent(override, docDefault) });
  expect(at(PICK, DOC)).toBe('document');
  expect(at('theme', DOC)).toBe('document');
  expect(at(null, DOC)).toBe('theme');
  expect(at(PICK, null)).toBe('theme');
  expect(at(null, null)).toBeNull();
});
