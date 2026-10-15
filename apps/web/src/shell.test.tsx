/**
 * 6.0 proves the harness, not behaviour: the shell renders through happy-dom
 * under `bun test`, asks `/api/me` relatively with the session cookie, and
 * shows the signed-in empty state the onboarding document promises (one
 * button — New message — and nothing else).
 *
 * Scope rule from the stage plan: this asserts what a state renders as, never
 * what the state means. Meaning stays pinned in the data layer.
 */
import { describe, expect, test } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { Shell } from './shell.tsx';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('shell', () => {
  test('renders the signed-in empty state after /api/me answers', async () => {
    const seen: RequestInfo[] = [];
    const fetchDouble = (async (input: RequestInfo) => {
      seen.push(input);
      return jsonResponse({ userId: 'member-1' });
    }) as unknown as typeof globalThis.fetch;

    render(<Shell fetch={fetchDouble} />);

    expect(await screen.findByText('No conversations yet.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'New message' })).toBeDefined();
    // Same-origin: a relative URL, so the session cookie travels with it.
    expect(seen).toEqual(['/api/me']);
  });

  test('a 401 renders the signed-out state, and nothing of the list', async () => {
    const fetchDouble = (async () =>
      jsonResponse({ error: 'unauthenticated' }, 401)) as unknown as typeof globalThis.fetch;

    render(<Shell fetch={fetchDouble} />);

    expect(await screen.findByText('Sign in to message.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'New message' })).toBeNull();
  });
});
