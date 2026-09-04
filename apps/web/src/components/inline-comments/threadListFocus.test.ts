/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { planThreadFocus } from './threadListFocus.js';

/** t1 listed; t2 hidden by the filters, with proposal p1 nested in it. */
const list = {
  threadIds: ['t1', 't2', 'p1'],
  visibleIds: new Set(['t1']),
  collapsed: new Set<string>(),
  parentOf: new Map([['p1', 't2']]),
};

test('a hidden thread is revealed on its own; the filters are never touched', () => {
  expect(
    planThreadFocus({ ...list, request: { threadId: 't2', nonce: 1 }, handledNonce: null }),
  ).toEqual({ kind: 'reveal', cardId: 't2' });
});

test('a hidden nested proposal reveals the card it renders in', () => {
  expect(
    planThreadFocus({ ...list, request: { threadId: 'p1', nonce: 1 }, handledNonce: null }),
  ).toEqual({ kind: 'reveal', cardId: 't2' });
});

test('a request already honoured is not replayed on remount', () => {
  expect(
    planThreadFocus({ ...list, request: { threadId: 't2', nonce: 3 }, handledNonce: 3 }),
  ).toEqual({ kind: 'ignore' });
  expect(
    planThreadFocus({ ...list, request: { threadId: 't2', nonce: 4 }, handledNonce: 3 }),
  ).toEqual({ kind: 'reveal', cardId: 't2' });
});

test('no request, or a thread this list does not hold, is ignored', () => {
  expect(planThreadFocus({ ...list, request: null, handledNonce: null })).toEqual({
    kind: 'ignore',
  });
  expect(
    planThreadFocus({ ...list, request: { threadId: 'elsewhere', nonce: 1 }, handledNonce: null }),
  ).toEqual({ kind: 'ignore' });
});

test('a listed thread is expanded with its card first, then focused', () => {
  const visibleIds = new Set(['t2', 'p1']);
  const request = { threadId: 'p1', nonce: 1 };
  expect(
    planThreadFocus({
      ...list,
      visibleIds,
      collapsed: new Set(['t2', 'p1']),
      request,
      handledNonce: null,
    }),
  ).toEqual({ kind: 'expand', ids: ['p1', 't2'] });
  expect(planThreadFocus({ ...list, visibleIds, request, handledNonce: null })).toEqual({
    kind: 'focus',
  });
});
