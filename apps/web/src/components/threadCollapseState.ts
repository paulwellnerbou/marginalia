export interface ThreadCollapseDefaults {
  id: string;
  autoCollapse: boolean;
}

export interface ThreadCollapseState {
  collapsed: Set<string>;
  autoCollapseByThread: Map<string, boolean>;
}

export function buildThreadCollapseState(threads: ThreadCollapseDefaults[]): ThreadCollapseState {
  const collapsed = new Set<string>();
  const autoCollapseByThread = new Map<string, boolean>();

  for (const thread of threads) {
    autoCollapseByThread.set(thread.id, thread.autoCollapse);
    if (thread.autoCollapse) collapsed.add(thread.id);
  }

  return { collapsed, autoCollapseByThread };
}

export function reconcileThreadCollapseState(
  prev: ThreadCollapseState,
  threads: ThreadCollapseDefaults[],
): ThreadCollapseState {
  const collapsed = new Set<string>();
  const autoCollapseByThread = new Map<string, boolean>();

  for (const thread of threads) {
    autoCollapseByThread.set(thread.id, thread.autoCollapse);

    const autoCollapseJustActivated =
      thread.autoCollapse && prev.autoCollapseByThread.get(thread.id) !== true;

    if (prev.collapsed.has(thread.id) || autoCollapseJustActivated) {
      collapsed.add(thread.id);
    }
  }

  if (
    setsEqual(prev.collapsed, collapsed) &&
    mapsEqual(prev.autoCollapseByThread, autoCollapseByThread)
  ) {
    return prev;
  }

  return { collapsed, autoCollapseByThread };
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function mapsEqual(a: Map<string, boolean>, b: Map<string, boolean>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    if (b.get(key) !== value) return false;
  }
  return true;
}
