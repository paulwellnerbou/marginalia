import { type DependencyList, type RefObject, useLayoutEffect, useRef } from 'react';

/**
 * Runs `measure` now and whenever the theme on screen may have changed
 * without `deps` changing: theme stylesheets load async, and Radix flips
 * its `dark` class a render after the appearance changes. For reading the
 * theme's own colors off the live DOM.
 */
export function useThemeMeasure(
  measure: () => void,
  anchor: RefObject<HTMLElement | null>,
  deps: DependencyList,
): void {
  const latest = useRef(measure);
  latest.current = measure;
  useLayoutEffect(() => {
    const run = () => latest.current();
    run();
    document.head.addEventListener('load', run, true);
    const appRoot = anchor.current?.closest('.radix-themes');
    const observer = new MutationObserver(run);
    if (appRoot) observer.observe(appRoot, { attributes: true, attributeFilter: ['class'] });
    return () => {
      document.head.removeEventListener('load', run, true);
      observer.disconnect();
    };
  }, [anchor, ...deps]);
}
