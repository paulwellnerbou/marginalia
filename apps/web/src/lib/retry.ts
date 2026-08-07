/**
 * Retry an idempotent GET a few times with exponential backoff.
 *
 * Reads that populate a pane the user can't refresh on their own need
 * this: a single dropped request (a redeploy landing mid-navigation, a
 * network blip) otherwise leaves that pane empty and self-consistent —
 * "0 threads" reads as a fact, not as a failure, so nobody reloads.
 *
 * Only errors `isTransientError` accepts are retried; see there for
 * where that line falls. A retry ladder is for blips — an outage
 * outlasts any budget worth spending here, so callers that must survive
 * one need a recovery cue as well (the realtime reconnect, in this app).
 */
export interface RetryOptions {
  attempts?: number;
  /** Delay before the first retry; doubles per attempt. */
  baseDelayMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
  /** Return false to give up early on an error the caller knows is final. */
  isTransient?: (err: unknown) => boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Whether retrying `err` could plausibly produce a different answer.
 *
 * Transient means the transport failed, not the request: a numeric
 * `status` outside 4xx (an `ApiError`), the bare `TypeError` fetch
 * rejects with when the connection dies, or the `TimeoutError` an
 * expired `AbortSignal.timeout` raises. 4xx other than 408/429 is a
 * verdict, not a hiccup.
 *
 * Everything else — a caller's deliberate `AbortError`, a `SyntaxError`
 * from an unparseable body, any Error a bug in our own code threw — is
 * final. Retrying those only delays the caller's error path three times
 * over, and a defect that surfaces late is harder to place than one
 * that surfaces at once.
 */
export function isTransientError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    if (status === 408 || status === 429) return true;
    return status < 400 || status >= 500;
  }
  if (err instanceof TypeError) return true;
  return (err as { name?: unknown } | null)?.name === 'TimeoutError';
}

export async function retryRequest<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const baseDelayMs = options.baseDelayMs ?? 500;
  const sleep = options.sleep ?? defaultSleep;
  const isTransient = options.isTransient ?? isTransientError;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts - 1 || !isTransient(err)) break;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastError;
}
