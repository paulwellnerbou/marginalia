import { describe, expect, test } from 'bun:test';
import { isTransientError, retryRequest } from './retry.js';

function failing(times: number, error: unknown, value = 'ok') {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    fn: async () => {
      calls++;
      if (calls <= times) throw error;
      return value;
    },
  };
}

const noSleep = async () => {};

describe('isTransientError', () => {
  test('treats a dead connection (no status) as transient', () => {
    expect(isTransientError(new TypeError('Failed to fetch'))).toBe(true);
  });

  test('treats 5xx as transient and plain 4xx as final', () => {
    expect(isTransientError({ status: 500 })).toBe(true);
    expect(isTransientError({ status: 502 })).toBe(true);
    expect(isTransientError({ status: 401 })).toBe(false);
    expect(isTransientError({ status: 403 })).toBe(false);
    expect(isTransientError({ status: 404 })).toBe(false);
  });

  test('retries the 4xx codes that mean "ask again"', () => {
    expect(isTransientError({ status: 408 })).toBe(true);
    expect(isTransientError({ status: 429 })).toBe(true);
  });
});

describe('retryRequest', () => {
  test('returns the first success without retrying', async () => {
    const target = failing(0, new Error('unused'));
    await expect(retryRequest(target.fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(target.calls).toBe(1);
  });

  test('recovers from a transient failure', async () => {
    const target = failing(2, { status: 502 });
    await expect(retryRequest(target.fn, { sleep: noSleep })).resolves.toBe('ok');
    expect(target.calls).toBe(3);
  });

  test('gives up after the attempt budget and rethrows the last error', async () => {
    const target = failing(9, { status: 503 });
    await expect(retryRequest(target.fn, { attempts: 3, sleep: noSleep })).rejects.toMatchObject({
      status: 503,
    });
    expect(target.calls).toBe(3);
  });

  test('does not retry a final error', async () => {
    const target = failing(9, { status: 403 });
    await expect(retryRequest(target.fn, { sleep: noSleep })).rejects.toMatchObject({
      status: 403,
    });
    expect(target.calls).toBe(1);
  });

  test('backs off exponentially between attempts', async () => {
    const delays: number[] = [];
    const target = failing(9, { status: 500 });
    await expect(
      retryRequest(target.fn, {
        attempts: 4,
        baseDelayMs: 100,
        sleep: async (ms) => {
          delays.push(ms);
        },
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(delays).toEqual([100, 200, 400]);
  });
});
