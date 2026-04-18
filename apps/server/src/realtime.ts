import type { WSContext } from 'hono/ws';

/**
 * Per-document pub/sub for realtime updates. Holds a Set of connected
 * WebSocket contexts keyed by document UID. In-process only — fine for a
 * single-node deployment; swap for Redis pub/sub later if we go multi-node.
 */
export class Realtime {
  private channels = new Map<string, Set<Subscriber>>();

  subscribe(docUid: string, sub: Subscriber): () => void {
    let set = this.channels.get(docUid);
    if (!set) {
      set = new Set();
      this.channels.set(docUid, set);
    }
    set.add(sub);
    return () => this.unsubscribe(docUid, sub);
  }

  unsubscribe(docUid: string, sub: Subscriber): void {
    const set = this.channels.get(docUid);
    if (!set) return;
    set.delete(sub);
    if (set.size === 0) this.channels.delete(docUid);
  }

  /** Fan out an event to every subscriber of `docUid`, except `exceptClientId`. */
  broadcast(docUid: string, event: RealtimeEvent, exceptClientId?: string): void {
    const set = this.channels.get(docUid);
    if (!set) return;
    const payload = JSON.stringify(event);
    for (const sub of set) {
      if (exceptClientId && sub.clientId === exceptClientId) continue;
      try {
        sub.ws.send(payload);
      } catch {
        /* socket may have just closed; cleanup happens on onClose */
      }
    }
  }

  /** Diagnostics only. */
  subscriberCount(docUid: string): number {
    return this.channels.get(docUid)?.size ?? 0;
  }
}

export interface Subscriber {
  ws: WSContext;
  clientId: string;
}

export type RealtimeEvent =
  | { type: 'comment.created'; comment: Record<string, unknown> }
  | { type: 'comment.updated'; comment: Record<string, unknown> }
  | { type: 'comment.deleted'; comment_id: string }
  | { type: 'edit_proposal.created'; edit_proposal: Record<string, unknown> }
  | { type: 'edit_proposal.updated'; edit_proposal: Record<string, unknown> }
  | { type: 'edit_proposal.deleted'; edit_proposal_id: string }
  | { type: 'document.updated'; oid: string; author: string };
