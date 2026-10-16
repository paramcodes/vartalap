/**
 * 6.0 proves the harness, not behaviour: the shell renders through happy-dom
 * under `bun test`, asks `/api/me` relatively with the session cookie, and —
 * since 6.2 — hands a signed-in member to the conversation list rather than
 * to a placeholder. The signed-out pixels are unchanged.
 *
 * Scope rule from the stage plan: this asserts what a state renders as, never
 * what the state means. Meaning stays pinned in the data layer.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Shell } from './shell.tsx';

// `screen` is one document for the whole run; without this, a render left by an
// earlier file answers the next file's queries.
afterEach(() => cleanup());
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
/** `/api/me` answers the member; every other same-origin read answers empty. */
function shellFetch() {
  const seen: string[] = [];
  const fetchDouble = (async (input: string, init?: RequestInit) => {
    seen.push(typeof input === 'string' ? input : String(input));
    if (typeof input === 'string' && input === '/api/me') return jsonResponse({ userId: 'member-1' });
    if (typeof input === 'string' && input === '/api/conversations') return jsonResponse([]);
    return jsonResponse({ error: 'notFound' }, 404);
  }) as unknown as typeof globalThis.fetch;
  return { fetchDouble, seen };
}
describe('shell', () => {
  test('renders the signed-in list after /api/me answers', async () => {
    const { fetchDouble, seen } = shellFetch();
    render(
      <MemoryRouter>
        <Shell fetch={fetchDouble} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('No conversations yet.')).toBeDefined();
    // Same-origin: relative URLs, so the session cookie travels with both.
    expect(seen).toContain('/api/me');
    expect(seen).toContain('/api/conversations');
  });
  test('a 401 renders the signed-out state, and nothing of the list', async () => {
    const fetchDouble = (async () =>
      jsonResponse({ error: 'unauthenticated' }, 401)) as unknown as typeof globalThis.fetch;
    render(
      <MemoryRouter>
        <Shell fetch={fetchDouble} />
      </MemoryRouter>,
    );
    expect(await screen.findByText('Sign in to message.')).toBeDefined();
    expect(screen.queryByText('No conversations yet.')).toBeNull();
  });
});