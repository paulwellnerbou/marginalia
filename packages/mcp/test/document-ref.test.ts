import { describe, expect, test } from 'bun:test';
import { assertHostAllowed, documentUrl, parseDocumentRef } from '../src/document-ref.js';

const UID = 'AbCdEfGhIjKlMnOpQrStUv';
const TOKEN = 'ZzYyXxWwVvUuTtSsRrQqPp';

describe('parseDocumentRef', () => {
  test('reads uid and token from a share link', () => {
    expect(parseDocumentRef(`https://marg.example.com/d/${UID}/${TOKEN}`)).toEqual({
      baseUrl: 'https://marg.example.com',
      uid: UID,
      token: TOKEN,
    });
  });

  test('reads a viewer link without a token', () => {
    expect(parseDocumentRef(`https://marg.example.com/d/${UID}`)).toEqual({
      baseUrl: 'https://marg.example.com',
      uid: UID,
      token: null,
    });
  });

  test('does not mistake the /edit sub-route for a token', () => {
    expect(parseDocumentRef(`https://marg.example.com/d/${UID}/edit`).token).toBeNull();
    expect(parseDocumentRef(`https://marg.example.com/d/${UID}/${TOKEN}/edit`).token).toBe(TOKEN);
  });

  test('keeps the port and scheme of a local instance', () => {
    expect(parseDocumentRef(`http://localhost:3434/d/${UID}/${TOKEN}`).baseUrl).toBe(
      'http://localhost:3434',
    );
  });

  test('accepts an API path', () => {
    expect(parseDocumentRef(`https://marg.example.com/api/documents/${UID}/threads`).uid).toBe(UID);
  });

  test('accepts a bare uid, leaving the instance unset', () => {
    expect(parseDocumentRef(UID)).toEqual({ baseUrl: null, uid: UID, token: null });
  });

  test('accepts uid/token without a host', () => {
    expect(parseDocumentRef(`${UID}/${TOKEN}`)).toEqual({
      baseUrl: null,
      uid: UID,
      token: TOKEN,
    });
  });

  test('accepts a scheme-less host with a path', () => {
    expect(parseDocumentRef(`marg.example.com/d/${UID}`).baseUrl).toBe('https://marg.example.com');
  });

  test('reads a token from ?invite=', () => {
    expect(parseDocumentRef(`https://marg.example.com/d/${UID}?invite=${TOKEN}`).token).toBe(TOKEN);
  });

  test('rejects input with no document id', () => {
    expect(() => parseDocumentRef('')).toThrow();
    expect(() => parseDocumentRef('not a uid')).toThrow();
    expect(() => parseDocumentRef('https://marg.example.com/')).toThrow();
  });
});

describe('assertHostAllowed', () => {
  test('permits everything when no allowlist is configured', () => {
    expect(() => assertHostAllowed('https://anywhere.example', [])).not.toThrow();
  });

  test('blocks hosts outside the allowlist', () => {
    expect(() => assertHostAllowed('https://evil.example', ['marg.example.com'])).toThrow(
      /not in MARGINALIA_ALLOWED_HOSTS/,
    );
    expect(() => assertHostAllowed('https://marg.example.com', ['marg.example.com'])).not.toThrow();
  });
});

describe('documentUrl', () => {
  test('includes the token when one is known', () => {
    expect(documentUrl({ baseUrl: 'https://m.example', uid: UID, token: TOKEN })).toBe(
      `https://m.example/d/${UID}/${TOKEN}`,
    );
    expect(documentUrl({ baseUrl: 'https://m.example', uid: UID, token: null })).toBe(
      `https://m.example/d/${UID}`,
    );
  });
});
