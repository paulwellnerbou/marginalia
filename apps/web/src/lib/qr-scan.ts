/**
 * Scanning a QR code into the "Open from a link" form.
 *
 * Decoding is left to the browser's own Shape Detection API, which is the
 * only decoder here — where it is missing the scan button is not shown,
 * and pasting the link still works. Bundling a JS decoder would buy
 * coverage for desktop Firefox, which has no camera pointed at another
 * screen anyway.
 */
import { parseDocumentLink } from './document-link.js';

/** The subset of `BarcodeDetector` this module uses; not in TS's DOM lib. */
export interface QrDetector {
  detect(source: ImageBitmapSource): Promise<Array<{ rawValue: string }>>;
}

interface QrDetectorCtor {
  new (options: { formats: string[] }): QrDetector;
  getSupportedFormats(): Promise<string[]>;
}

function detectorCtor(): QrDetectorCtor | null {
  const ctor = (globalThis as { BarcodeDetector?: QrDetectorCtor }).BarcodeDetector;
  return typeof ctor === 'function' ? ctor : null;
}

/**
 * Whether this browser can scan at all. Synchronous on purpose so a
 * render can decide whether to show the button; the format check that
 * needs a promise happens on the way into the dialog.
 */
export function canScanQr(): boolean {
  return (
    detectorCtor() !== null &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/** A QR detector, or null when the API is there but cannot read QR codes. */
export async function createQrDetector(): Promise<QrDetector | null> {
  const ctor = detectorCtor();
  if (!ctor) return null;
  const formats = await ctor.getSupportedFormats();
  if (!formats.includes('qr_code')) return null;
  return new ctor({ formats: ['qr_code'] });
}

export type ScannedRoute =
  | { ok: true; path: string }
  | { ok: false; reason: 'other-site'; host: string }
  | { ok: false; reason: 'unrecognized' };

/**
 * Where a scanned code should take the user. Document links go through
 * the same parser as pasted ones; a pairing QR (`/k/<code>`) from the
 * "Add a device" dialog is routed to the pair page rather than rejected,
 * since someone scanning from this form has just as likely been shown
 * that one.
 */
export function routeForScannedCode(text: string, currentHost: string): ScannedRoute {
  const pairing = pairingPath(text, currentHost);
  if (pairing) return { ok: true, path: pairing };
  const parsed = parseDocumentLink(text, currentHost);
  if (parsed.ok) return parsed;
  if (parsed.reason === 'other-site') return parsed;
  return { ok: false, reason: 'unrecognized' };
}

function pairingPath(text: string, currentHost: string): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.host !== currentHost) return null;
  const [kind, code, ...extra] = url.pathname.split('/').filter(Boolean);
  if (kind !== 'k' || !code || extra.length > 0 || !/^[A-Za-z0-9-]+$/.test(code)) return null;
  return `/k/${code}`;
}
