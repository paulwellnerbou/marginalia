/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { routeForScannedCode } from './qr-scan.js';

const HOST = 'marginalia.example.com';
const UID = 'ad1Z3BJ7Fo0IBGOu_l5Qvg';
const TOKEN = 'Xy7Qs2LmNp0RtUvWzAbCd1';

test('routes a scanned access link like a pasted one', () => {
  expect(routeForScannedCode(`https://${HOST}/d/${UID}/${TOKEN}`, HOST)).toEqual({
    ok: true,
    path: `/d/${UID}/${TOKEN}`,
  });
});

test('routes a pairing QR to the pair page', () => {
  expect(routeForScannedCode(`https://${HOST}/k/ABCD-EFGH`, HOST)).toEqual({
    ok: true,
    path: '/k/ABCD-EFGH',
  });
});

test('pairing links must be on this host with exactly one code segment', () => {
  expect(routeForScannedCode('https://elsewhere.example/k/ABCD-EFGH', HOST)).toEqual({
    ok: false,
    reason: 'other-site',
    host: 'elsewhere.example',
  });
  expect(routeForScannedCode(`https://${HOST}/k/ABCD-EFGH/extra`, HOST)).toEqual({
    ok: false,
    reason: 'unrecognized',
  });
  expect(routeForScannedCode(`https://${HOST}/k`, HOST)).toEqual({
    ok: false,
    reason: 'unrecognized',
  });
});

test('anything else is unrecognized', () => {
  expect(routeForScannedCode('WIFI:S:cafe;T:WPA;P:hunter2;;', HOST)).toEqual({
    ok: false,
    reason: 'unrecognized',
  });
  expect(routeForScannedCode('', HOST)).toEqual({ ok: false, reason: 'unrecognized' });
});
