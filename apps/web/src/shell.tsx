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
      <main className="bg-wash text-ink">
        <h1>vartalap</h1>
        <p>Sign in to message.</p>
      </main>
    );
  }

  return (
    <main className="bg-wash text-ink">
      <h1>vartalap</h1>
      <p className="text-ink-muted">No conversations yet.</p>
      <button type="button" className="bg-accent text-ink-on-accent rounded-xl">
        New message
      </button>
    </main>
  );
}
