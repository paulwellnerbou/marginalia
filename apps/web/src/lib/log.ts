/**
 * Developer-facing error logging.
 *
 * Every caught error in the web app should flow through `reportError()` so
 * it shows up in the browser console — otherwise a UI "Could not create
 * document" message is all the user has to diagnose with.
 *
 * Call `installGlobalErrorLogging()` once from the app entry to also catch
 * uncaught exceptions and unhandled promise rejections.
 */

export function reportError(context: string, err: unknown, extra?: Record<string, unknown>): void {
  const prefix = `[marginalia:${context}]`;
  if (extra) {
    console.error(prefix, err, extra);
  } else {
    console.error(prefix, err);
  }
}

export function installGlobalErrorLogging(): void {
  window.addEventListener('error', (e) => {
    reportError('window.onerror', e.error ?? e.message, {
      filename: e.filename,
      line: e.lineno,
      col: e.colno,
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportError('unhandledrejection', e.reason);
  });
}
