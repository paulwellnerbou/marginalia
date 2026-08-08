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
    return () => mq.removeEventListener('change', update);
  }, [query]);

  return matches;
}
