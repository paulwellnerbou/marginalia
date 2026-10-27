/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { externalLinkUrl } from './external-links.js';

const ORIGIN = 'https://marginalia.example';

test('a link to another site opens externally', () => {
  expect(externalLinkUrl('https://example.org/a?b#c', ORIGIN)).toBe('https://example.org/a?b#c');
  expect(externalLinkUrl('http://example.org', ORIGIN)).toBe('http://example.org/');
});

test('links within the app stay in place', () => {
  expect(externalLinkUrl(`${ORIGIN}/d/abc`, ORIGIN)).toBeNull();
  expect(externalLinkUrl('/d/abc', ORIGIN)).toBeNull();
  expect(externalLinkUrl('#section', ORIGIN)).toBeNull();
});

test('the same host on another port or scheme is another site', () => {
  expect(externalLinkUrl('http://marginalia.example/d/abc', ORIGIN)).not.toBeNull();
  expect(externalLinkUrl('https://marginalia.example:8443/', ORIGIN)).not.toBeNull();
});

test('non-web schemes keep their default handling', () => {
  expect(externalLinkUrl('mailto:someone@example.org', ORIGIN)).toBeNull();
  expect(externalLinkUrl('tel:+49123', ORIGIN)).toBeNull();
  expect(externalLinkUrl('javascript:void(0)', ORIGIN)).toBeNull();
});
