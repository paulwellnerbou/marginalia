/**
 * Retry an idempotent GET a few times with exponential backoff.
 *
 * Reads that populate a pane the user can't refresh on their own need
 * this: a single dropped request (a redeploy landing mid-navigation, a
 * network blip) otherwise leaves that pane empty and self-consistent —
 * "0 threads" reads as a fact, not as a failure, so nobody reloads.
 *
 * Client errors are not retried: a 401/403/404 is an answer, and asking
 * again just delays the caller's error path. Everything else — 5xx, and
 * the `TypeError` fetch throws when the connection dies — is treated as
 * transient.
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

/** 4xx other than 408/429 is a verdict, not a hiccup. */
export function isTransientError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true;
  if (status === 408 || status === 429) return true;
  return status < 400 || status >= 500;
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
