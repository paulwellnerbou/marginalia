/**
 * How an agent's name and client id are normalized.
 *
 * Deliberately dependency-free so every place that has to agree on the
 * answer can import it: the stdio server's env config, the hosted
 * endpoint's query string, and the browser panel that mints an agent's
 * invite and writes its connection URL. If the browser and the server
 * normalized differently, the panel would mint an invite under one name
 * and the agent would connect under another — which is exactly the
 * mismatch the panel exists to prevent.
 */

export const MAX_DISPLAY_NAME_LENGTH = 80;
export const MAX_CLIENT_ID_LENGTH = 200;

/** The name an agent is signed with when nothing else is given. */
export const DEFAULT_AGENT_NAME = 'Claude';

// Hoisted so the suppression sits directly above the pattern: biome
// applies `biome-ignore` to the following line only, and the formatter
// splits a long call chain between the two.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the intent
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * Clean a value that becomes an identity header.
 *
 * Control characters have to go before the value is used, not after.
 * `x-marginalia-client-name` is percent-encoded on the way out, so a
 * newline survives the trip and lands in the database as a raw CR/LF —
 * harmless to render, but it corrupts the line-oriented text the tools
 * emit and reads as a broken name in the viewer. `x-marginalia-client`
 * is sent verbatim, where `Headers.set` rejects the same characters and
 * takes the whole tool call down with it.
 */
export function sanitizeIdentityValue(raw: string | null | undefined, maxLength: number): string {
  return (raw ?? '').replace(CONTROL_CHARACTERS, '').trim().slice(0, maxLength);
}

/**
 * The name an agent will actually be known by, given what someone typed.
 *
 * Two agents sharing a name share a client id, and Marginalia decides
 * comment ownership by client id — so this is also the value uniqueness
 * has to be judged on. Comparing raw input would let "Cla<CR><LF>ude"
 * pass as distinct from "Claude" and then collapse onto it server-side.
 */
export function normalizeAgentName(raw: string | null | undefined): string {
  return sanitizeIdentityValue(raw, MAX_DISPLAY_NAME_LENGTH) || DEFAULT_AGENT_NAME;
}
