import { decodeNamedCharacterReference } from 'decode-named-character-reference';

/**
 * Decode HTML character references — every named one HTML defines, and
 * numeric ones. A reference that names nothing is left as written, and
 * one pass means `&amp;lt;` decodes to `&lt;`, not `<`.
 */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, ref: string) => {
    if (ref[0] !== '#') return decodeNamedCharacterReference(ref) || match;
    const code =
      ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}
