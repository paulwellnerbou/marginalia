/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { buildThreadCollapseState, reconcileThreadCollapseState } from './threadCollapseState.js';

test('initially collapses threads marked for auto-collapse', () => {
  const state = buildThreadCollapseState([
    { id: 'resolved-comment', autoCollapse: true },
    { id: 'pending-proposal', autoCollapse: false },
    { id: 'accepted-proposal', autoCollapse: true },
  ]);

  expect([...state.collapsed]).toEqual(['resolved-comment', 'accepted-proposal']);
});

test('preserves a manual expansion of an auto-collapsed thread', () => {
  const initial = buildThreadCollapseState([{ id: 'resolved-comment', autoCollapse: true }]);
  const manuallyExpanded = {
    ...initial,
    collapsed: new Set<string>(),
  };

  const state = reconcileThreadCollapseState(manuallyExpanded, [
    { id: 'resolved-comment', autoCollapse: true },
  ]);

  expect(state.collapsed.size).toBe(0);
});

test('collapses a thread when it becomes resolved or decided', () => {
  const initial = buildThreadCollapseState([{ id: 'thread-1', autoCollapse: false }]);

  const state = reconcileThreadCollapseState(initial, [{ id: 'thread-1', autoCollapse: true }]);

  expect([...state.collapsed]).toEqual(['thread-1']);
});

test('drops collapse state for threads that no longer exist', () => {
  const initial = buildThreadCollapseState([
    { id: 'resolved-comment', autoCollapse: true },
    { id: 'other-thread', autoCollapse: false },
  ]);
  const manuallyCollapsed = {
    ...initial,
    collapsed: new Set(['resolved-comment', 'other-thread']),
  };

  const state = reconcileThreadCollapseState(manuallyCollapsed, [
    { id: 'resolved-comment', autoCollapse: true },
  ]);

  expect([...state.collapsed]).toEqual(['resolved-comment']);
});
