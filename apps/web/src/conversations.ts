/**
 * The list's server read. Server-authoritative metadata (order, mute, unread,
 * presence, permission) comes from `GET /api/conversations` through TanStack
 * Query — the decisions index names it for exactly this job — while preview
 * text comes from Dexie rows this browser holds (`list.ts` decides newest).
 *
 * The query cache IS the list's cache: pending/settled/fetching/error map
 * onto the concept's four loading rows with no second store.
 */
import { QueryClient, useQuery } from '@tanstack/react-query';
import { conversationListItem, type ConversationListItem } from '@vartalap/protocol';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

/** Overridable in tests. Production passes nothing and gets `globalThis.fetch`. */
export interface ListDeps {
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export async function fetchConversations(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<ConversationListItem[]> {
  const response = await fetchFn('/api/conversations', { credentials: 'include' });
  if (!response.ok) throw new Error(`the list answered ${response.status}`);
  const body = (await response.json()) as unknown[];
  return body.map((item) => conversationListItem.parse(item));
}

export function useConversations(deps: ListDeps = {}) {
  return useQuery({
    queryKey: ['conversations'],
    queryFn: () => fetchConversations(deps.fetch ?? globalThis.fetch),
  });
}

/** What the shell learned at the auth gate, available to every route. */
export interface AppDeps {
  readonly viewerId: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
}
