import { useEffect, useState } from 'react';
import { dismissToast, onToasts, type Toast } from '../lib/notifications.js';

/**
 * Renders the stack of active toasts at the bottom-right of the viewport.
 * Mount once at the app root.
 */
export function ToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => onToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-stack">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={t.variant === 'error' ? 'toast toast-error' : 'toast'}
          role={t.variant === 'error' ? 'alert' : 'status'}
        >
          <div className="toast-head">
            <strong>{t.title}</strong>
            <button type="button" className="toast-close" onClick={() => dismissToast(t.id)}>
              ×
            </button>
          </div>
          <div className="toast-body">{t.body}</div>
          {t.action && (
            <button
              type="button"
              className="link"
              onClick={() => {
                t.action?.onClick();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
