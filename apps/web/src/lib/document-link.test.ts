/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { parseDocumentLink } from './document-link.js';

const HOST = 'marginalia.example.com';
const UID = 'ad1Z3BJ7Fo0IBGOu_l5Qvg';
const TOKEN = 'Xy7Qs2LmNp0RtUvWzAbCd1';

test('keeps the invite token from a full URL', () => {
  const result = parseDocumentLink(`https://${HOST}/d/${UID}/${TOKEN}`, HOST);
  expect(result).toEqual({ ok: true, path: `/d/${UID}/${TOKEN}` });
});

test('accepts a document URL with no token', () => {
  const result = parseDocumentLink(`https://${HOST}/d/${UID}`, HOST);
  expect(result).toEqual({ ok: true, path: `/d/${UID}` });
});

test('keeps the edit suffix, with and without a token', () => {
  expect(parseDocumentLink(`https://${HOST}/d/${UID}/${TOKEN}/edit`, HOST)).toEqual({
    ok: true,
    path: `/d/${UID}/${TOKEN}/edit`,
  });
  expect(parseDocumentLink(`https://${HOST}/d/${UID}/edit`, HOST)).toEqual({
    ok: true,
    path: `/d/${UID}/edit`,
  });
});

test('drops query, hash and trailing slash', () => {
  const result = parseDocumentLink(`https://${HOST}/d/${UID}/${TOKEN}/?ref=mail#heading`, HOST);
  expect(result).toEqual({ ok: true, path: `/d/${UID}/${TOKEN}` });
});

test('accepts a bare path and a bare uid', () => {
  expect(parseDocumentLink(`/d/${UID}/${TOKEN}`, HOST)).toEqual({
    ok: true,
    path: `/d/${UID}/${TOKEN}`,
  });
  expect(parseDocumentLink(UID, HOST)).toEqual({ ok: true, path: `/d/${UID}` });
});

test('a bare path drops query, hash and trailing slash like a full URL does', () => {
  expect(parseDocumentLink(`/d/${UID}/${TOKEN}/?utm=mail#heading`, HOST)).toEqual({
    ok: true,
    path: `/d/${UID}/${TOKEN}`,
  });
  expect(parseDocumentLink(`/d/${UID}#heading`, HOST)).toEqual({ ok: true, path: `/d/${UID}` });
  expect(parseDocumentLink(`/d/${UID}/edit?from=mail`, HOST)).toEqual({
    ok: true,
    path: `/d/${UID}/edit`,
  });
});

test('ignores surrounding whitespace from a copied line', () => {
  const result = parseDocumentLink(`  https://${HOST}/d/${UID}/${TOKEN}  \n`, HOST);
  expect(result).toEqual({ ok: true, path: `/d/${UID}/${TOKEN}` });
});

test('a link copied as http from an https deployment is still this deployment', () => {
  const result = parseDocumentLink(`http://${HOST}/d/${UID}/${TOKEN}`, HOST);
  expect(result).toEqual({ ok: true, path: `/d/${UID}/${TOKEN}` });
});

test('reports another deployment by host rather than failing vaguely', () => {
  const result = parseDocumentLink(`https://other.example.org/d/${UID}/${TOKEN}`, HOST);
  expect(result).toEqual({ ok: false, reason: 'other-site', host: 'other.example.org' });
});

test('a port is part of the host, so it distinguishes deployments', () => {
  expect(parseDocumentLink(`http://localhost:3434/d/${UID}`, 'localhost:3434')).toEqual({
    ok: true,
    path: `/d/${UID}`,
  });
  expect(parseDocumentLink(`http://localhost:5173/d/${UID}`, 'localhost:3434')).toEqual({
    ok: false,
    reason: 'other-site',
    host: 'localhost:5173',
  });
});

test('rejects empty input separately so the field can stay silent', () => {
  expect(parseDocumentLink('   ', HOST)).toEqual({ ok: false, reason: 'empty' });
});

test('rejects links that are not documents', () => {
  for (const input of [`https://${HOST}/`, `https://${HOST}/settings`, '/d/', 'not a link']) {
    expect(parseDocumentLink(input, HOST)).toEqual({ ok: false, reason: 'unrecognized' });
  }
});

test('rejects a short word rather than treating it as a uid', () => {
  expect(parseDocumentLink('hello', HOST)).toEqual({ ok: false, reason: 'unrecognized' });
});

test('rejects extra path segments after edit', () => {
  expect(parseDocumentLink(`/d/${UID}/${TOKEN}/edit/more`, HOST)).toEqual({
    ok: false,
    reason: 'unrecognized',
  });
});

test('rejects a third segment that is not edit', () => {
  expect(parseDocumentLink(`/d/${UID}/${TOKEN}/history`, HOST)).toEqual({
    ok: false,
    reason: 'unrecognized',
  });
});

test('rejects a non-http scheme', () => {
  expect(parseDocumentLink(`javascript:alert(1)//${HOST}/d/${UID}`, HOST)).toEqual({
    ok: false,
    reason: 'unrecognized',
  });
});
