/**
 * Scanning a QR code into the "Open from a link" form.
 *
 * Decoding goes through `qr-scanner`, which uses the browser's own
 * `BarcodeDetector` where one exists and its own worker-based decoder
 * where it does not. The second case is the one that matters: WebKit
 * has never shipped the native API, so iOS Safari and the installed iOS
 * app — the devices this form exists for — would otherwise have no
 * scanner at all.
 */
import { parseDocumentLink } from './document-link.js';

export interface QrDetector {
  /** The first QR code in the video's current frame, or null. */
  detect(video: HTMLVideoElement): Promise<string | null>;
  /** Releases the decoder; `detect` must not be called afterwards. */
  close(): void;
}

/**
 * Decoding at full camera resolution costs more than it finds: the
 * longer side is capped here before the frame reaches the decoder.
 */
const MAX_DECODE_SIDE = 640;

/**
 * Whether this browser can scan at all. Synchronous on purpose so a
 * render can decide whether to show the button. Only the camera is
 * checked: decoding has a fallback, the camera does not.
 */
export function canScanQr(): boolean {
  return (
    typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/**
 * Loads the decoder on demand so the home page does not pay for it
 * until someone opens the scanner.
 */
export async function createQrDetector(): Promise<QrDetector> {
  const { default: QrScanner } = await import('qr-scanner');
  const engine = await QrScanner.createQrEngine();
  // Reused across frames: the library resizes it to the scan region.
  const canvas = document.createElement('canvas');
  return {
    async detect(video) {
      const { videoWidth: width, videoHeight: height } = video;
      const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(width, height));
      try {
        const result = await QrScanner.scanImage(video, {
          qrEngine: engine,
          canvas,
          scanRegion: {
            x: 0,
            y: 0,
            width,
            height,
            downScaledWidth: Math.round(width * scale),
            downScaledHeight: Math.round(height * scale),
          },
          returnDetailedScanResult: true,
        });
        return result.data;
      } catch (err) {
        // Rejects with this string, by identity, when the frame is empty.
        if (err === QrScanner.NO_QR_CODE_FOUND) return null;
        throw err;
      }
    },
    close() {
      // A native detector has nothing to release. The worker does, and
      // the library only shuts down engines it created itself.
      if (engine instanceof Worker) engine.terminate();
    },
  };
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
