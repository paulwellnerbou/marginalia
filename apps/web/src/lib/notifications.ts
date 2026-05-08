/**
 * Browser notifications with an in-app toast fallback.
 *
 * - `ensureNotificationPermission()` asks politely the first time; after
 *   that it returns the cached result.
 * - `notify()` shows a native notification when granted + tab is hidden,
 *   falls back to a toast when the tab is visible (so the user isn't
 *   spammed with notifications they can already see) or when permission
 *   is denied.
 */

let permissionPromise: Promise<NotificationPermission> | null = null;

export function currentPermission(): NotificationPermission {
  if (typeof Notification === 'undefined') return 'denied';
  return Notification.permission;
}

export async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof Notification === 'undefined') return 'denied';
  if (Notification.permission !== 'default') return Notification.permission;
  if (!permissionPromise) permissionPromise = Notification.requestPermission();
  return permissionPromise;
}

export interface Toast {
  id: number;
  title: string;
  body: string;
  action?: { label: string; onClick: () => void };
}

type ToastListener = (toasts: Toast[]) => void;
const listeners = new Set<ToastListener>();
let toasts: Toast[] = [];
let nextId = 1;

export function onToasts(fn: ToastListener): () => void {
  listeners.add(fn);
  fn(toasts);
  return () => {
    listeners.delete(fn);
  };
}

function emit() {
  for (const fn of listeners) fn(toasts);
}

export function showToast(partial: Omit<Toast, 'id'>, ttlMs = 6000): void {
  const toast: Toast = { ...partial, id: nextId++ };
  toasts = [...toasts, toast];
  emit();
  window.setTimeout(() => dismissToast(toast.id), ttlMs);
}

export function dismissToast(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

/**
 * Deliver a realtime notification. When the tab is hidden and permission
 * is granted, fire a native notification; otherwise drop a toast.
 */
export function notify(title: string, body: string, action?: Toast['action']): void {
  const tabHidden = typeof document !== 'undefined' && document.hidden;
  if (tabHidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(title, { body, tag: 'marginalia' });
      if (action) n.addEventListener('click', action.onClick);
    } catch {
      // If the browser blocks the constructor, fall through to a toast.
      const t: Omit<Toast, 'id'> = { title, body };
      if (action) t.action = action;
      showToast(t);
    }
    return;
  }
  const t: Omit<Toast, 'id'> = { title, body };
  if (action) t.action = action;
  showToast(t);
}
