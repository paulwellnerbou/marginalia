import { describe, expect, test } from 'bun:test';
import { ApiError, UNKNOWN_ERROR_CODE } from './api.js';
import { apiErrorMessage } from './apiErrorMessage.js';
import { markTransportFailure } from './retry.js';

const FALLBACK = 'Could not export the JSON bundle';
/** Kept verbatim so the assertion fails if the mapping is dropped, not just reworded. */
const MESSAGES_PROPOSAL_MERGE_UNAVAILABLE =
  'The server could not run the merge it needs to apply this proposal. That is a server problem, not a problem with the proposal — try again later.';

describe('apiErrorMessage', () => {
  test('prefers the prose mapped to a known code', () => {
    expect(apiErrorMessage(new ApiError(403, 'forbidden'), FALLBACK)).toBe(
      'You do not have permission to do that.',
    );
  });

  // The failure this file exists for: the server process dies mid-export
  // and the reverse proxy answers with a bodiless 502, so there is no
  // code to map and the reader used to be shown the literal "unknown".
  test('explains a bodiless gateway failure instead of naming the placeholder', () => {
    for (const status of [502, 503, 504]) {
      const message = apiErrorMessage(new ApiError(status, UNKNOWN_ERROR_CODE), FALLBACK);
      expect(message).toStartWith(FALLBACK);
      expect(message).toContain('stopped responding');
      expect(message).not.toContain(UNKNOWN_ERROR_CODE);
    }
  });

  /**
   * The server uses the gateway statuses itself and means something
   * specific by them, so the wording above must not apply on status
   * alone. These two are the real cases: the PDF export answers 503
   * `export-busy` and 504 `export-timeout`, and neither is in MESSAGES,
   * so both reach the tail of the function with a code worth keeping.
   */
  test('leaves a gateway status alone when the server named the failure', () => {
    for (const [status, code] of [
      [503, 'export-busy'],
      [504, 'export-timeout'],
    ] as const) {
      const message = apiErrorMessage(new ApiError(status, code), FALLBACK);
      expect(message).toBe(`${FALLBACK} — the server reported an error (${code}).`);
      expect(message).not.toContain('stopped responding');
    }
  });

  test('prefers mapped prose over the gateway wording on a 503', () => {
    expect(apiErrorMessage(new ApiError(503, 'proposal-merge-unavailable'), FALLBACK)).toBe(
      MESSAGES_PROPOSAL_MERGE_UNAVAILABLE,
    );
  });

  test('names the status when a failure carried no error code', () => {
    expect(apiErrorMessage(new ApiError(500, UNKNOWN_ERROR_CODE), FALLBACK)).toBe(
      `${FALLBACK} — the server returned HTTP 500.`,
    );
  });

  test('blames the server for an unmapped 5xx code', () => {
    expect(apiErrorMessage(new ApiError(500, 'internal'), FALLBACK)).toBe(
      `${FALLBACK} — the server reported an error (internal).`,
    );
  });

  test('keeps status and code visible for an unmapped 4xx', () => {
    expect(apiErrorMessage(new ApiError(418, 'teapot'), FALLBACK)).toBe(
      `${FALLBACK} (418: teapot)`,
    );
  });

  test('distinguishes a dropped connection from an unexplained failure', () => {
    const dropped = apiErrorMessage(markTransportFailure(new TypeError('Load failed')), FALLBACK);
    expect(dropped).toContain('connection to the server dropped');
    // An untagged throw is a bug in our own code, not the network — it
    // must not be dressed up as a connectivity problem.
    expect(apiErrorMessage(new TypeError('x is not a function'), FALLBACK)).toBe(FALLBACK);
  });
});
