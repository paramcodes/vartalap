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

export function Shell(deps: ShellDeps = {}) {
  const state = useShellState(deps);

  if (state.status === 'checking') {
    return <main aria-busy="true">Loading…</main>;
  }

  if (state.status === 'signed-out') {
    return (
      <main className="flex h-dvh items-center justify-center bg-wash p-4 text-ink">
        <div className="flex w-full max-w-sm flex-col items-center rounded-2xl border border-hairline bg-card p-6 text-center shadow-xs">
          <span className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-2xl font-bold text-ink-on-accent shadow-xs">
            V
          </span>
          <h1 className="text-xl font-bold tracking-tight">vartalap</h1>
          <p className="mt-1 text-sm text-ink-muted">Sign in to message.</p>
        </div>
      </main>
    );
  }

  return <App deps={{ viewerId: state.userId, fetch: deps.fetch }} />;
}
