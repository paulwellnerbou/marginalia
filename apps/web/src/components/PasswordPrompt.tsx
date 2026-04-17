import { useState } from 'react';
import { ApiError } from '../lib/api.js';

export function PasswordPrompt({ onSubmit }: { onSubmit: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(password);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError('Wrong password');
      else setError('Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page">
      <form className="panel" onSubmit={handle}>
        <h1>Password required</h1>
        <p className="subtle">This document is password-protected.</p>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" className="primary" disabled={submitting || !password}>
          {submitting ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </div>
  );
}
