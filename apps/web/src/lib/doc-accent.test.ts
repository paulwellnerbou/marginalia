import { expect, test } from 'bun:test';
import { accentOverrideFor, accentResetTarget, resolveAccent } from './doc-accent.js';

const DOC = '#d6ec4e';
const PICK = '#2156a5';

test('a pick wins over the document default, which wins over the theme', () => {
  expect(resolveAccent(PICK, DOC).accent).toBe(PICK);
  expect(resolveAccent(null, DOC).accent).toBe(DOC);
  expect(resolveAccent(null, null).accent).toBeNull();
});

test("opting out of the document default shows the theme's accent", () => {
  const stored = accentOverrideFor(null, DOC);
  expect(resolveAccent(stored, DOC)).toEqual({ accent: null, override: 'theme', docDefault: DOC });
});

test('an opt-out ends when the document default changes or goes', () => {
  const stored = accentOverrideFor(null, DOC);
  expect(resolveAccent(stored, PICK)).toEqual({ accent: PICK, override: null, docDefault: PICK });
  expect(resolveAccent(stored, null)).toEqual({ accent: null, override: null, docDefault: null });
});

test('a garbled stored pick falls back to the document default', () => {
  expect(resolveAccent('lime', DOC).accent).toBe(DOC);
});

test('choosing what the document already shows stores nothing', () => {
  expect(accentOverrideFor(DOC, DOC)).toBeNull();
  expect(accentOverrideFor(null, null)).toBeNull();
});

test('a pick is stored lowercased', () => {
  expect(accentOverrideFor('#2156A5', DOC)).toBe(PICK);
});

test('reset steps down one level: pick → document → theme', () => {
  const at = (raw: string | null, docDefault: string | null) =>
    accentResetTarget(resolveAccent(raw, docDefault));
  expect(at(PICK, DOC)).toBe('document');
  expect(at(accentOverrideFor(null, DOC), DOC)).toBe('document');
  expect(at(null, DOC)).toBe('theme');
  expect(at(PICK, null)).toBe('theme');
  expect(at(null, null)).toBeNull();
});

test('a stale opt-out leaves nothing to reset', () => {
  expect(accentResetTarget(resolveAccent(accentOverrideFor(null, DOC), null))).toBeNull();
});
