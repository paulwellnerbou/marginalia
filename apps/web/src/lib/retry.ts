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
 * Marker set on an error that came out of a `fetch` call rather than out
 * of our own code, so `isTransientError` can tell them apart.
 *
 * It has to be applied at the throw site: `fetch` rejects a dead
 * connection with a bare `TypeError`, which is the same shape as the
 * `TypeError` a "cannot read properties of undefined" bug produces one
 * line later. Downstream the two are indistinguishable — sniffing the
 * message would mean matching "Failed to fetch" / "Load failed" /
 * "NetworkError when attempting to fetch resource." per engine, and
 * being wrong on the next one.
 */
const TRANSPORT_FAILURE = Symbol.for('marginalia.transportFailure');

/**
 * Tag a rejection as transport-level and hand it back for rethrowing.
 * The original error is passed through untouched otherwise, so its
 * name, message and stack still reach the logs.
 */
export function markTransportFailure<E>(err: E): E {
  if (err !== null && typeof err === 'object') {
    (err as Record<symbol, unknown>)[TRANSPORT_FAILURE] = true;
  }
  return err;
}

/**
 * Whether retrying `err` could plausibly produce a different answer.
 *
 * Transient means the transport failed, not the request: a numeric
 * `status` outside 4xx (an `ApiError`), or a rejection `fetch` itself
 * produced — a dead connection, an expired timeout. 4xx other than
 * 408/429 is a verdict, not a hiccup.
 *
 * Everything else is final: a caller's deliberate `AbortError` (they
 * got what they asked for), a `SyntaxError` from an unparseable body,
 * and any error a bug in our own code threw. Retrying those only delays
 * the caller's error path three times over, and a defect that surfaces
 * late is harder to place than one that surfaces at once.
 */
export function isTransientError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status === 'number') {
    if (status === 408 || status === 429) return true;
    return status < 400 || status >= 500;
  }
  if ((err as { name?: unknown } | null)?.name === 'AbortError') return false;
  return (err as Record<symbol, unknown> | null)?.[TRANSPORT_FAILURE] === true;
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
