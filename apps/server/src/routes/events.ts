import { Hono } from 'hono';
import type { UpgradeWebSocket } from 'hono/ws';
import type { Database } from 'bun:sqlite';
import type { DocumentRow } from '../db.js';
import { authorize, parseCookie, SESSION_COOKIE } from '../auth.js';
import type { Realtime } from '../realtime.js';

export interface EventsDeps {
  db: Database;
  realtime: Realtime;
  upgradeWebSocket: UpgradeWebSocket;
}

/**
 * WebSocket route: `/api/documents/:uid/events`.
 *
 * Client auth — the browser WebSocket API can't send custom headers, so
 * identity arrives via query params (`?client_id=...&client_name=...`).
 * The session cookie (for password-protected docs) is sent automatically
 * because WS is same-origin.
 */
export function eventsRouter(deps: EventsDeps): Hono {
  const r = new Hono();

  r.get(
    '/:uid/events',
    deps.upgradeWebSocket((c) => {
      const uid = c.req.param('uid');
      const clientId = c.req.query('client_id') ?? '';
      const inviteToken = c.req.query('invite') ?? null;
      const sessionToken = parseCookie(c.req.raw.headers.get('cookie'), SESSION_COOKIE);
      const doc = uid ? loadDoc(deps.db, uid) : null;
      // The browser WebSocket API can't send custom headers, so we accept
      // the invite token via query param and synthesize a Headers object
      // for the shared authorize() helper.
      const headers = new Headers();
      if (inviteToken) headers.set('x-marginalia-invite', inviteToken);
      let unsubscribe: (() => void) | null = null;

      return {
        onOpen(_evt, ws) {
          if (!doc || !uid) {
            ws.send(JSON.stringify({ type: 'error', code: 'not-found' }));
            ws.close();
            return;
          }
          const decision = authorize(deps.db, doc, headers, sessionToken);
          if (!decision.ok) {
            ws.send(JSON.stringify({ type: 'error', code: decision.reason }));
            ws.close();
            return;
          }
          unsubscribe = deps.realtime.subscribe(uid, { ws, clientId });
          ws.send(JSON.stringify({ type: 'subscribed', uid }));
        },
        onClose() {
          unsubscribe?.();
        },
      };
    }),
  );

  return r;
}

function loadDoc(db: Database, uid: string): DocumentRow | null {
  const row = db.prepare('SELECT * FROM documents WHERE uid = ?').get(uid) as
    | DocumentRow
    | undefined;
  return row ?? null;
}
