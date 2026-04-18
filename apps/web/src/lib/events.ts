/**
 * WebSocket client for per-document realtime events.
 *
 * Connects to `/api/documents/:uid/events`, re-establishes on drop with
 * exponential backoff, and pushes decoded events into a callback. Identity
 * travels in the URL because browser WebSocket can't set custom headers.
 */
import { getClientId, getDisplayName } from './identity.js';
import { loadInviteToken } from './invite.js';
import { reportError } from './log.js';

export type RealtimeEvent =
  | { type: 'comment.created'; comment: Record<string, unknown> }
  | { type: 'comment.updated'; comment: Record<string, unknown> }
  | { type: 'mention.created'; comment: Record<string, unknown> }
  | { type: 'comment.deleted'; comment_id: string }
  | { type: 'document.updated'; oid: string; author: string }
  | { type: 'subscribed'; uid: string }
  | { type: 'error'; code: string };

export interface EventSubscription {
  close(): void;
}

export function subscribeToDocumentEvents(
  uid: string,
  onEvent: (event: RealtimeEvent) => void,
): EventSubscription {
  let ws: WebSocket | null = null;
  let closed = false;
  let retries = 0;
  let reconnectTimer: number | null = null;

  function connect() {
    if (closed) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const params = new URLSearchParams();
    params.set('client_id', getClientId());
    const name = getDisplayName();
    if (name) params.set('client_name', name);
    const inviteToken = loadInviteToken(uid);
    if (inviteToken) params.set('invite', inviteToken);
    const url = `${proto}://${window.location.host}/api/documents/${encodeURIComponent(uid)}/events?${params.toString()}`;

    try {
      ws = new WebSocket(url);
    } catch (err) {
      reportError('events.connect', err, { uid });
      scheduleReconnect();
      return;
    }

    ws.addEventListener('open', () => {
      retries = 0;
      console.log('[marginalia:events] connected', uid);
    });

    ws.addEventListener('message', (e) => {
      try {
        const parsed = JSON.parse(String(e.data)) as RealtimeEvent;
        onEvent(parsed);
      } catch (err) {
        reportError('events.parse', err, { data: e.data });
      }
    });

    ws.addEventListener('error', (e) => {
      reportError('events.ws-error', e);
    });

    ws.addEventListener('close', () => {
      ws = null;
      if (!closed) scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (closed) return;
    retries = Math.min(retries + 1, 6);
    // 250ms, 500ms, 1s, 2s, 4s, 8s, then capped
    const delay = 250 * 2 ** (retries - 1);
    console.log(`[marginalia:events] reconnecting in ${delay}ms (attempt ${retries})`);
    reconnectTimer = window.setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      ws?.close();
      ws = null;
    },
  };
}
