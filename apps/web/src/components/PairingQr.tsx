import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/**
 * A QR code as inline SVG.
 *
 * Drawn from the module grid rather than the library's own `createSvgTag`
 * so the plate can be sized and rounded to match the surrounding cards.
 *
 * Always dark-on-white, in both appearances. An inverted code scans on
 * most modern phones and fails on enough of the rest to not be worth it,
 * and the whole point of this element is that it works on the first try
 * while someone is holding a phone up to a screen.
 */
export function PairingQr({ value, size = 208 }: { value: string; size?: number }) {
  // One path for the whole grid rather than a rect per module: a code of
  // this size is several hundred modules, and they never change
  // independently of each other.
  const { path, extent } = useMemo(() => {
    // Level M tolerates ~15% damage — the usual choice for a code read off
    // a screen, where glare costs more than the extra modules do.
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    // The quiet zone is part of the spec, not padding — scanners use it to
    // find the code's edges.
    const quiet = 4;
    const segments: string[] = [];
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) segments.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
      }
    }
    return { path: segments.join(''), extent: count + quiet * 2 };
  }, [value]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${extent} ${extent}`}
      role="img"
      aria-label="Pairing QR code"
      style={{ borderRadius: 'var(--radius-3)', display: 'block' }}
      shapeRendering="crispEdges"
    >
      <rect width={extent} height={extent} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
