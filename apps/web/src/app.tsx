/**
 * The signed-in app: providers plus the two routes 6.2 needs.
 *
 * `/` is the list with an empty transcript beside it; `/c/:id` is the same
 * list with the transcript placeholder 6.3 replaces. Under 760px the route
 * decides which pane shows — they are one pane that moved, not two panes
 * with one hidden (0055).
 */
import { QueryClientProvider, QueryClient } from '@tanstack/react-query';
import { Route, Routes } from 'react-router';
import { queryClient } from './conversations.ts';
import { AppProviders, Layout, type AppDeps, type AppTestDeps } from './layout.tsx';
import { EmptyTranscript, TranscriptPanel } from './transcript-panel.tsx';
import { ConversationSettings, GlobalSettings } from './settings-route.tsx';

export interface AppProps {
  readonly deps: AppDeps;
  /** Injected in tests so queries never share a cache. */
  readonly client?: QueryClient;
  /** Injected in tests so rows and clocks never touch Dexie or the wall. */
  readonly testDeps?: AppTestDeps;
}

export function App({ deps, client, testDeps = {} }: AppProps) {
  return (
    <QueryClientProvider client={client ?? queryClient}>
      <AppProviders deps={deps} testDeps={testDeps}>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<EmptyTranscript />} />
            <Route path="settings" element={<GlobalSettings />} />
            <Route path="c/:id" element={<TranscriptPanel />} />
            <Route path="c/:id/settings" element={<ConversationSettings />} />
          </Route>
        </Routes>
      </AppProviders>
    </QueryClientProvider>
  );
}
