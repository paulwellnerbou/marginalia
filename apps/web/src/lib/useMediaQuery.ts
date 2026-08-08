import { useEffect, useState } from 'react';

/**
 * Live `matchMedia` result. Unlike a value read once at mount this
 * follows rotation and window resizes, so layout that has to react to
 * them (panes overlaying the document on a narrow screen) stays correct
 * without a reload.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener('change', update);
    // Belt and braces: `change` is the right signal, but a viewport that
    // moves without one (an embedded or remote-controlled browser) would
    // otherwise leave the layout describing a window that is gone.
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      mq.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, [query]);

  return matches;
}
