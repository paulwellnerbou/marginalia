/** A request to bring one thread into view, from a highlight, Activities, History or a deep link. */
export interface ThreadFocusRequest {
  threadId: string;
  /** Distinguishes a new request from the one before it, however similar. */
  nonce: number;
}

export type ThreadFocusStep =
  /** No request, one already honoured, or a thread this list does not hold. */
  | { kind: 'ignore' }
  /** The filters or search hide its card: list that one card as an exception. */
  | { kind: 'reveal'; cardId: string }
  /** Collapsed: open the thread and, for a nested proposal, the card it renders in. */
  | { kind: 'expand'; ids: string[] }
  /** In view and open: scroll to it and flash. */
  | { kind: 'focus' };

/**
 * What the Threads list does next about a focus request. One step per
 * pass: each step changes state the next pass sees, until the thread is
 * in view.
 *
 * A hidden card is revealed on its own, never by widening the filters.
 * The reader asked for one thread by id — with thousands of settled
 * ones in the document, dropping "Unresolved" to show it would bury
 * the list, and the filters are remembered, so the loss would outlive
 * the request.
 */
export function planThreadFocus(args: {
  request: ThreadFocusRequest | null;
  /** Nonce of the request this list last honoured. */
  handledNonce: number | null;
  threadIds: readonly string[];
  /** Threads whose card is listed right now, nested ones included. */
  visibleIds: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  /** Nested proposal → the card it renders inside. */
  parentOf: ReadonlyMap<string, string>;
}): ThreadFocusStep {
  const { request, handledNonce, threadIds, visibleIds, collapsed, parentOf } = args;
  if (!request || handledNonce === request.nonce) return { kind: 'ignore' };
  if (!threadIds.includes(request.threadId)) return { kind: 'ignore' };
  const parentId = parentOf.get(request.threadId);
  if (!visibleIds.has(request.threadId)) {
    return { kind: 'reveal', cardId: parentId ?? request.threadId };
  }
  const ids = [request.threadId, ...(parentId ? [parentId] : [])].filter((id) => collapsed.has(id));
  if (ids.length > 0) return { kind: 'expand', ids };
  return { kind: 'focus' };
}
