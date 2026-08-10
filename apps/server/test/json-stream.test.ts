import { describe, expect, test } from 'bun:test';
import { Base64StreamEncoder, jsonTextStream } from '../src/export/json-stream.js';

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = '';
  const decoder = new TextDecoder();
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    out += decoder.decode(chunk, { stream: true });
  }
  return out + decoder.decode();
}

describe('Base64StreamEncoder', () => {
  /**
   * The whole hazard: base64 maps 3 bytes to 4 characters, so encoding
   * chunks independently pads mid-stream and corrupts everything after.
   * Chunk sizes are chosen to straddle that boundary in every phase.
   */
  test('matches one-shot base64 across every chunk boundary', () => {
    const bytes = new Uint8Array(257);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 11) % 256;
    const expected = Buffer.from(bytes).toString('base64');

    for (const size of [1, 2, 3, 4, 5, 7, 16, 64, 256, 1024]) {
      const encoder = new Base64StreamEncoder();
      let got = '';
      for (let at = 0; at < bytes.length; at += size) {
        got += encoder.push(bytes.subarray(at, Math.min(at + size, bytes.length)));
      }
      got += encoder.flush();
      expect(`${size}:${got}`).toBe(`${size}:${expected}`);
    }
  });

  test('handles every remainder length in the tail', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 6]) {
      const bytes = new Uint8Array(length).fill(0xab);
      const encoder = new Base64StreamEncoder();
      const got = encoder.push(bytes) + encoder.flush();
      expect(got).toBe(Buffer.from(bytes).toString('base64'));
    }
  });

  test('a chunk shorter than one group emits nothing until it completes', () => {
    const encoder = new Base64StreamEncoder();
    expect(encoder.push(new Uint8Array([1]))).toBe('');
    expect(encoder.push(new Uint8Array([2]))).toBe('');
    expect(encoder.push(new Uint8Array([3]))).toBe(Buffer.from([1, 2, 3]).toString('base64'));
    expect(encoder.flush()).toBe('');
  });

  test('does not retain the chunk it carried bytes out of', () => {
    const encoder = new Base64StreamEncoder();
    const chunk = new Uint8Array(1024).fill(9);
    encoder.push(chunk.subarray(0, 4));
    chunk.fill(0);
    // The carried byte was copied, so overwriting the source cannot
    // change what the tail encodes to.
    expect(encoder.flush()).toBe(Buffer.from([9]).toString('base64'));
  });
});

describe('jsonTextStream', () => {
  test('concatenates fragments in order', async () => {
    async function* fragments() {
      yield '{"a":';
      yield '1,"b":';
      yield '"two"}';
    }
    expect(await readAll(jsonTextStream(fragments()))).toBe('{"a":1,"b":"two"}');
  });

  test('skips empty fragments without stalling', async () => {
    async function* fragments() {
      yield '';
      yield '{';
      yield '';
      yield '';
      yield '}';
      yield '';
    }
    expect(await readAll(jsonTextStream(fragments()))).toBe('{}');
  });

  test('surfaces a mid-stream failure instead of truncating', async () => {
    async function* fragments() {
      yield '{"partial":';
      throw new Error('pack died');
    }
    const stream = jsonTextStream(fragments());
    await expect(readAll(stream)).rejects.toThrow('pack died');
  });

  /**
   * A client that hangs up mid-download has to take the subprocess
   * feeding the stream down with it, which only happens if cancel
   * returns into the generator and lets its `finally` run.
   */
  test('running the generator to cleanup on cancel', async () => {
    let cleanedUp = false;
    async function* fragments() {
      try {
        yield 'first';
        yield 'second';
      } finally {
        cleanedUp = true;
      }
    }
    const stream = jsonTextStream(fragments());
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel('client hung up');
    expect(cleanedUp).toBe(true);
  });
});
