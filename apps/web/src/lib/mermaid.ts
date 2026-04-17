/**
 * Client-side mermaid renderer.
 *
 * Two subtleties worth keeping in mind while editing this file:
 *
 * 1. **React 18 Strict Mode re-applies `dangerouslySetInnerHTML`** when it
 *    simulates unmount-remount in dev, which detaches the mermaid block
 *    between our first scan and the `await` on the mermaid module. We
 *    therefore re-scan *after* the await — the initial scan exists only to
 *    short-circuit the mermaid module import when there's nothing to do.
 *
 * 2. **`mermaid.render(id, source)`** returns the SVG as a string that we
 *    inject ourselves. `mermaid.run({ nodes })` holds refs to the passed
 *    nodes across its internal async work and explodes with
 *    "Cannot read properties of null (reading 'parentElement')" when those
 *    nodes are swapped out mid-flight.
 */

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

async function getMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'loose',
        theme: 'default',
        fontFamily: 'inherit',
        // Mermaid diagrams are usually drawn into an intrinsic viewBox that
        // ends up scaled down by the browser to fit narrower containers,
        // which shrinks all text. Give mermaid more headroom on font sizes
        // so labels stay readable after the scale-down.
        themeVariables: {
          fontSize: '18px',
        },
        gantt: {
          fontSize: 16,
          sectionFontSize: 18,
          barHeight: 26,
        },
        flowchart: { htmlLabels: true },
      });
      console.log('[marginalia:mermaid] initialized');
      return mermaid;
    });
  }
  return mermaidPromise;
}

let idCounter = 0;

export async function renderMermaidIn(root: HTMLElement): Promise<void> {
  // Initial scan purely to decide whether to load the mermaid module.
  const initialCount = root.querySelectorAll('div.mermaid, pre.mermaid').length;
  console.log(`[marginalia:mermaid] initial scan: ${initialCount} block(s)`);
  if (initialCount === 0) return;

  let mermaid: Awaited<ReturnType<typeof getMermaid>>;
  try {
    mermaid = await getMermaid();
  } catch (err) {
    console.error('[marginalia:mermaid] failed to load module', err);
    return;
  }

  // Re-scan after the await — StrictMode may have re-applied the article's
  // innerHTML, so the nodes we captured before `await` can be detached.
  // Prefer the caller's root, fall back to a document-level lookup so the
  // current rendered article is found.
  const liveRoot: Element | Document = root.isConnected
    ? root
    : document.querySelector('article.marginalia') ?? document;

  const blocks = Array.from(
    liveRoot.querySelectorAll<HTMLElement>('div.mermaid, pre.mermaid'),
  ).filter(
    (el) => el.getAttribute('data-processed') !== 'true' && el.isConnected,
  );
  console.log(
    `[marginalia:mermaid] live scan: ${blocks.length} pending (root still connected: ${root.isConnected})`,
  );
  if (blocks.length === 0) return;

  for (const el of blocks) {
    if (!el.isConnected) {
      console.warn('[marginalia:mermaid] block detached between live scan and render, skipping');
      continue;
    }
    const source = (el.textContent ?? '').trim();
    if (!source) {
      console.warn('[marginalia:mermaid] block has no source text, skipping');
      continue;
    }

    const id = `mermaid-${++idCounter}`;
    console.log(`[marginalia:mermaid] rendering ${id}`, { sourceLength: source.length });
    try {
      const { svg, bindFunctions } = await mermaid.render(id, source);
      if (!el.isConnected) {
        console.warn(`[marginalia:mermaid] ${id} detached mid-render, skipping write`);
        continue;
      }
      el.innerHTML = svg;
      el.setAttribute('data-processed', 'true');
      bindFunctions?.(el);
      console.log(`[marginalia:mermaid] ${id} committed (svg length ${svg.length})`);
    } catch (err) {
      console.error('[marginalia:mermaid] render failed', err, { id, source });
      if (el.isConnected) {
        el.classList.add('mermaid-error');
        const msg = err instanceof Error ? err.message : String(err);
        el.setAttribute('title', msg);
      }
    }
  }
  console.log('[marginalia:mermaid] run complete');
}
