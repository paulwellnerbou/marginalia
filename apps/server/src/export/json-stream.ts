/**
 * Serialization primitives for building a JSON response incrementally,
 * so a payload dominated by one huge field never exists as a whole
 * string.
 *
 * The JSON bundle export is the case that forced this: it embeds the
 * document's entire packed git history as base64, and assembling it the
 * obvious way held four full copies at once (pack bytes → base64 string
 * → `JSON.stringify` output → UTF-8 body). On a book-length document
 * that was enough to push the server past its container memory limit
 * and get it OOM-killed mid-request — which reaches the reader as a
 * bodiless 502 from the reverse proxy, not as an error the server ever
 * got to report.
 */

/**
 * Base64-encodes a byte stream across arbitrarily-sized chunks.
 *
 * Base64 maps 3 bytes to 4 characters, so only whole 3-byte groups can
 * be encoded independently — encoding a chunk whose length isn't a
 * multiple of 3 would pad in the middle of the stream and corrupt
 * everything after it. Leftover bytes are carried into the next chunk;
 * `flush()` emits the final, legitimately padded group.
 */
export class Base64StreamEncoder {
  private carry: Uint8Array = new Uint8Array(0);

  /** Base64 for every complete group available so far. May be empty. */
  push(chunk: Uint8Array): string {
    const pending = this.carry.length === 0 ? chunk : concat(this.carry, chunk);
    const encodable = pending.length - (pending.length % 3);
    if (encodable === 0) {
      // Copied for the same reason as below: `pending` is the caller's
      // chunk here, and holding a view of it outlives the call.
      this.carry = new Uint8Array(pending);
      return '';
    }
    // Copied, not a subarray: a view would pin the whole incoming chunk
    // in memory to hold at most two bytes.
    this.carry = new Uint8Array(pending.subarray(encodable));
    return Buffer.from(pending.buffer, pending.byteOffset, encodable).toString('base64');
  }

  /** The padded tail. Call once, after the last `push`. */
  flush(): string {
    if (this.carry.length === 0) return '';
    const tail = Buffer.from(this.carry.buffer, this.carry.byteOffset, this.carry.length).toString(
      'base64',
    );
    this.carry = new Uint8Array(0);
    return tail;
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Adapts an async generator of strings into a response body.
 *
 * `pull`-driven rather than pushed from `start`, so the generator only
 * advances when the consumer asks for more — the backpressure is the
 * whole point. Pushing eagerly would just relocate the buffering from
 * our code into the stream controller and undo the exercise.
 *
 * `cancel` returns into the generator so its `finally` blocks run: a
 * client that hangs up mid-download has to take the subprocess feeding
 * the stream down with it.
 */
export function jsonTextStream(source: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        // Loops because a generator step can legitimately produce
        // nothing — a pack chunk shorter than one whole base64 group
        // carries over instead of encoding. Enqueueing an empty buffer
        // would satisfy this pull without making progress.
        for (;;) {
          const { value, done } = await iterator.next();
          if (done) {
            controller.close();
            return;
          }
          if (value.length > 0) {
            controller.enqueue(encoder.encode(value));
            return;
          }
        }
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}
