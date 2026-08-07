import { reportError } from './log.js';

/**
 * Registers the service worker that makes the app installable.
 *
 * Dev is deliberately excluded: a worker caching the shell across `bun run
 * dev` reloads makes Vite's output untrustworthy. Verify PWA behaviour
 * against a production build (`bun run build && bun run start`).
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (!('serviceWorker' in navigator)) return;

  // Registration competes with the app's own startup requests for
  // bandwidth; waiting for load keeps it off the critical path.
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      reportError('sw.register', err);
    });
  });
}
