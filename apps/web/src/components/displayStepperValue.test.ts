/// <reference types="bun" />

import { expect, test } from 'bun:test';
import { stepForKey, stepValue } from './displayStepperValue.js';

/** Reading width: the range whose grid the old slider could miss. */
const WIDTH = { min: 40, max: 120, step: 4 };
const ZOOM = { min: 80, max: 220, step: 5 };

test('moves one step from a value already on the grid', () => {
  expect(stepValue(72, 1, WIDTH)).toBe(76);
  expect(stepValue(72, -1, WIDTH)).toBe(68);
});

test('snaps an off-grid value onto the grid, in the direction pressed', () => {
  // 61ch is the kind of value a slider drag left behind.
  expect(stepValue(61, 1, WIDTH)).toBe(64);
  expect(stepValue(61, -1, WIDTH)).toBe(60);
});

test('still moves when the nearest grid point is the other way', () => {
  // Rounding to nearest would answer 64 for both.
  expect(stepValue(63, 1, WIDTH)).toBe(64);
  expect(stepValue(63, -1, WIDTH)).toBe(60);
});

test('one snap is enough — stepping on lands a full step away', () => {
  expect(stepValue(stepValue(61, 1, WIDTH), 1, WIDTH)).toBe(68);
});

test('clamps at both ends', () => {
  expect(stepValue(40, -1, WIDTH)).toBe(40);
  expect(stepValue(120, 1, WIDTH)).toBe(120);
  // An off-grid maximum is still reachable: 120 is 40 + 20 steps.
  expect(stepValue(118, 1, WIDTH)).toBe(120);
});

test('arrow keys step on both axes', () => {
  for (const key of ['ArrowUp', 'ArrowRight']) {
    expect(stepForKey(key, 100, ZOOM)).toBe(105);
  }
  for (const key of ['ArrowDown', 'ArrowLeft']) {
    expect(stepForKey(key, 100, ZOOM)).toBe(95);
  }
});

test('page keys cover five steps, and clamp', () => {
  expect(stepForKey('PageUp', 100, ZOOM)).toBe(125);
  expect(stepForKey('PageDown', 130, ZOOM)).toBe(105);
  // 100 - 25 is under the floor.
  expect(stepForKey('PageDown', 100, ZOOM)).toBe(80);
  expect(stepForKey('PageUp', 210, ZOOM)).toBe(220);
});

test('home and end go to the ends', () => {
  expect(stepForKey('Home', 150, ZOOM)).toBe(80);
  expect(stepForKey('End', 150, ZOOM)).toBe(220);
});

test('leaves keys that are not the stepper’s alone', () => {
  for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape']) {
    expect(stepForKey(key, 100, ZOOM)).toBeNull();
  }
});
