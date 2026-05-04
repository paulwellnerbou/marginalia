// Shared lazy loader for the `@marginalia/renderer` chunk.
//
// Cached so callers don't re-import on every preview tick. The cache
// drops itself on rejection so a transient chunk-load failure doesn't
// pin every later attempt for the rest of the session — same pattern
// as `codemirror-loader.ts`.

type Renderer = typeof import('@marginalia/renderer');

let rendererPromise: Promise<Renderer> | null = null;

export function loadRenderer(): Promise<Renderer> {
  if (!rendererPromise) {
    const p = import('@marginalia/renderer');
    rendererPromise = p;
    p.catch(() => {
      if (rendererPromise === p) rendererPromise = null;
    });
  }
  return rendererPromise;
}
