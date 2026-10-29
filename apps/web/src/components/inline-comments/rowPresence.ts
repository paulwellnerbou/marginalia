/**
 * Which rows a list should render while rows come and go, so a thread
 * that is resolved, deleted, or newly posted can grow into or shrink out
 * of the list instead of popping.
 *
 * A row that leaves the list stays rendered for one animation, in the
 * place it left, marked `exit`; a row that arrives is marked `enter` for
 * as long as its animation runs. Kept apart from the hook that drives it
 * so the ordering cases can be tested without React.
 */

export type PresencePhase = 'enter' | 'exit' | null;

export interface PresenceRow<T> {
  key: string;
  item: T;
  phase: PresencePhase;
  /** When the row's animation ends, on the `performance.now()` clock. */
  until: number;
}

export interface NextPresenceInput<T extends { id: string }> {
  /** Rows rendered last time, leaving ones included. */
  prev: readonly PresenceRow<T>[];
  /** The list as it now is. */
  items: readonly T[];
  now: number;
  duration: number;
  /**
   * False for a change the reader asked for wholesale — a filter, search
   * or sort — or the first load: those remake the list, and animating
   * every row in or out would only be noise.
   */
  animate: boolean;
  /**
   * More arrivals and departures than this at once is a bulk change (the
   * archive landing, a section filter), not one thread coming or going.
   */
  maxAnimated: number;
  /** A row that must appear at full height at once — a focus jump measures it. */
  instantKey?: string | null;
}

export function staticRows<T extends { id: string }>(items: readonly T[]): PresenceRow<T>[] {
  return items.map((item) => ({ key: item.id, item, phase: null, until: 0 }));
}

export function nextPresence<T extends { id: string }>({
  prev,
  items,
  now,
  duration,
  animate,
  maxAnimated,
  instantKey = null,
}: NextPresenceInput<T>): PresenceRow<T>[] {
  if (!animate) return staticRows(items);

  const prevByKey = new Map(prev.map((row) => [row.key, row]));
  const nextKeys = new Set(items.map((item) => item.id));

  let changes = 0;
  for (const item of items) {
    const was = prevByKey.get(item.id);
    if (!was || was.phase === 'exit') changes++;
  }
  for (const row of prev) {
    if (row.phase !== 'exit' && !nextKeys.has(row.key)) changes++;
  }
  if (changes > maxAnimated) return staticRows(items);

  const rows = items.map((item): PresenceRow<T> => {
    const was = prevByKey.get(item.id);
    if (item.id === instantKey) return { key: item.id, item, phase: null, until: 0 };
    if (!was || was.phase === 'exit') {
      return { key: item.id, item, phase: 'enter', until: now + duration };
    }
    // An arrival still growing keeps its deadline, so its class — and the
    // animation it drives — carries on uninterrupted.
    if (was.phase === 'enter' && was.until > now) {
      return { key: item.id, item, phase: 'enter', until: was.until };
    }
    return { key: item.id, item, phase: null, until: 0 };
  });

  // Each leaving row stays behind the row it followed last time; one that
  // led the list stays at the top.
  const leavingAfter = new Map<string | null, PresenceRow<T>[]>();
  let anchor: string | null = null;
  for (const row of prev) {
    if (nextKeys.has(row.key)) {
      anchor = row.key;
      continue;
    }
    if (row.phase === 'exit' && row.until <= now) continue;
    const leaving: PresenceRow<T> =
      row.phase === 'exit' ? row : { ...row, phase: 'exit', until: now + duration };
    const group = leavingAfter.get(anchor);
    if (group) group.push(leaving);
    else leavingAfter.set(anchor, [leaving]);
  }
  if (leavingAfter.size === 0) return rows;

  const merged = [...(leavingAfter.get(null) ?? [])];
  for (const row of rows) {
    merged.push(row);
    const group = leavingAfter.get(row.key);
    if (group) merged.push(...group);
  }
  return merged;
}

/**
 * Drop leaving rows whose animation is over and stop marking finished
 * arrivals. Returns `rows` itself when nothing finished.
 */
export function settlePresence<T>(
  rows: readonly PresenceRow<T>[],
  now: number,
): readonly PresenceRow<T>[] {
  if (!rows.some((row) => row.phase !== null && row.until <= now)) return rows;
  const settled: PresenceRow<T>[] = [];
  for (const row of rows) {
    if (row.phase === null || row.until > now) settled.push(row);
    else if (row.phase === 'enter') settled.push({ ...row, phase: null, until: 0 });
  }
  return settled;
}
