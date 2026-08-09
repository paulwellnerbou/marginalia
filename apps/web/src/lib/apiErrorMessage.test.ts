import { describe, expect, test } from 'bun:test';
import { ApiError, UNKNOWN_ERROR_CODE } from './api.js';
import { apiErrorMessage } from './apiErrorMessage.js';
import { markTransportFailure } from './retry.js';

const FALLBACK = 'Could not export the JSON bundle';

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
