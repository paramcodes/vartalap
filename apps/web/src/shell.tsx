/**
 * The shell behind the auth gate (ADR 0062, unit 6.0).
 *
 * Two states and nothing else — no router, no list, no transcript. Those
 * arrive with their units (routing in 6.2). This file proves the harness:
 * it boots, it asks the realtime service who the member is over the
 * same-origin `/api/me`, and it renders the answer.
 *
 * Relative URL on purpose: `fetch` defaults to `credentials: "same-origin"`,
 * and an absolute cross-origin URL silently drops the session cookie
 * (auth concept trap 7). There is nowhere else for an absolute URL to come
 * from — the dev proxy and the prod server both keep one origin.
 */

import { useEffect, useState } from 'react';
import { App } from './app.tsx';

export type ShellState =
  | { readonly status: 'checking' }
  | { readonly status: 'signed-out' }
  | { readonly status: 'signed-in'; readonly userId: string };

/** Overridable in tests. Production passes nothing and gets `globalThis.fetch`. */
export interface ShellDeps {
  readonly fetch?: typeof globalThis.fetch;
}

export function useShellState(deps: ShellDeps = {}): ShellState {
  const [state, setState] = useState<ShellState>({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;
    const send = deps.fetch ?? globalThis.fetch;

    send('/api/me', { credentials: 'include' })
      .then(async (response) => {
        if (cancelled) return;
        if (!response.ok) {
          setState({ status: 'signed-out' });
          return;
        }
        const body = (await response.json()) as { userId?: unknown };
        if (typeof body.userId === 'string' && body.userId.length > 0) {
          setState({ status: 'signed-in', userId: body.userId });
        } else {
          setState({ status: 'signed-out' });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'signed-out' });
      });

    return () => {
      cancelled = true;
    };
    // `deps.fetch` is a test double, stable per mount. Re-running the effect
    // on identity change would double-fetch in production StrictMode anyway.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}

function AuthForm({ onSuccess }: { onSuccess: (userId: string) => void }) {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      if (mode === 'signup') {
        const username = handle.trim().toLowerCase();
        const email = `${username}@example.com`;
        const res = await fetch('/api/auth/sign-up/email', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            name: name.trim() || username,
            username,
            email,
            password,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(data?.message || 'Sign up failed');
        }
        const data = (await res.json()) as { user?: { id: string } };
        onSuccess(data?.user?.id ?? '');
      } else {
        const username = handle.trim().toLowerCase();
        const res = await fetch('/api/auth/sign-in/username', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            username,
            password,
          }),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({}))) as { message?: string };
          throw new Error(data?.message || 'Invalid handle or password');
        }
        const data = (await res.json()) as { user?: { id: string } };
        onSuccess(data?.user?.id ?? '');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex w-full flex-col gap-3 text-left">
      <div className="flex rounded-xl bg-wash p-1 text-xs">
        <button
          type="button"
          onClick={() => {
            setMode('signin');
            setError(null);
          }}
          className={`flex-1 rounded-lg py-1.5 font-medium transition-colors ${
            mode === 'signin' ? 'bg-card text-ink shadow-xs' : 'text-ink-muted'
          }`}
        >
          Sign In
        </button>
        <button
          type="button"
          onClick={() => {
            setMode('signup');
            setError(null);
          }}
          className={`flex-1 rounded-lg py-1.5 font-medium transition-colors ${
            mode === 'signup' ? 'bg-card text-ink shadow-xs' : 'text-ink-muted'
          }`}
        >
          Sign Up
        </button>
      </div>

      {mode === 'signup' && (
        <div>
          <label className="text-xs text-ink-muted">Display Name</label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ada Lovelace"
            className="mt-1 w-full rounded-xl border border-hairline bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
          />
        </div>
      )}

      <div>
        <label className="text-xs text-ink-muted">Handle</label>
        <input
          type="text"
          required
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="ada"
          autoCapitalize="none"
          autoCorrect="off"
          className="mt-1 w-full rounded-xl border border-hairline bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
      </div>

      <div>
        <label className="text-xs text-ink-muted">Password (min 12 chars)</label>
        <input
          type="password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••••••"
          className="mt-1 w-full rounded-xl border border-hairline bg-card px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
      </div>

      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="mt-2 w-full rounded-xl bg-accent py-2.5 text-sm font-semibold text-ink-on-accent transition hover:brightness-95 disabled:opacity-50"
      >
        {loading ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
      </button>
    </form>
  );
}

export function Shell(deps: ShellDeps = {}) {
  const [manualUser, setManualUser] = useState<string | null>(null);
  const state = useShellState(deps);

  if (state.status === 'checking') {
    return <main aria-busy="true">Loading…</main>;
  }

  const userId = manualUser ?? (state.status === 'signed-in' ? state.userId : null);

  if (userId === null) {
    return (
      <main className="flex h-dvh items-center justify-center bg-wash p-4 text-ink">
        <div className="flex w-full max-w-sm flex-col items-center rounded-2xl border border-hairline bg-card p-6 text-center shadow-xs">
          <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-2xl font-bold text-ink-on-accent shadow-xs">
            V
          </span>
          <h1 className="text-xl font-bold tracking-tight">vartalap</h1>
          <p className="mt-1 text-sm text-ink-muted">Sign in to message.</p>
          <AuthForm onSuccess={(uid) => setManualUser(uid)} />
        </div>
      </main>
    );
  }

  return <App deps={{ viewerId: userId, fetch: deps.fetch }} />;
}
