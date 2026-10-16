/**
 * The four-column shell per ADR 0055.
 *
 * Rail (flex, 64px or 184px with labels) and list (<aside>, 320px, collapsible
 * to zero via Cmd/Ctrl+B); transcript (fluid, content capped at 760px); and
 * details pane (<aside>, 300px, refused below 1150px per ADR 0055).
 * Under 760px the route decides the pane: `/` shows the list, `/c/:id` shows
 * the transcript, with a back affordance.
 *
 * Pane state is device-local (`localStorage`), never the account.
 */
import { createContext, useContext, useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import type { MessageRow } from './store.ts';
import type { AppDeps } from './conversations.ts';
import { ConversationList } from './conversation-list.tsx';
import { ChatIcon, ListIcon, PanelIcon, PlusIcon, SearchIcon, SettingsIcon } from './icons.tsx';

export type { AppDeps };

const PANES_KEY = 'vartalap.panes';

export interface PaneContextValue {
  readonly listOpen: boolean;
  readonly toggleList: () => void;
  readonly detailsOpen: boolean;
  readonly toggleDetails: () => void;
  readonly railLabels: boolean;
  readonly toggleRailLabels: () => void;
}

const PaneContext = createContext<PaneContextValue>({
  listOpen: true,
  toggleList: () => {},
  detailsOpen: true,
  toggleDetails: () => {},
  railLabels: false,
  toggleRailLabels: () => {},
});

export function usePaneContext(): PaneContextValue {
  return useContext(PaneContext);
}

/** Test doublers ride the same context; production leaves them undefined. */
export interface AppTestDeps {
  readonly loadRows?: (conversationId: string) => Promise<MessageRow[]>;
  readonly now?: () => number;
}

const AppContext = createContext<AppDeps>({ viewerId: '' });
const AppTestContext = createContext<AppTestDeps>({});

export function useAppDeps(): AppDeps {
  return useContext(AppContext);
}

export function useAppTestDeps(): AppTestDeps {
  return useContext(AppTestContext);
}

export function AppProviders({
  deps,
  testDeps,
  children,
}: {
  deps: AppDeps;
  testDeps?: AppTestDeps;
  children: React.ReactNode;
}) {
  return (
    <AppContext.Provider value={deps}>
      <AppTestContext.Provider value={testDeps ?? {}}>{children}</AppTestContext.Provider>
    </AppContext.Provider>
  );
}

export function Rail() {
  const location = useLocation();
  const { railLabels, toggleRailLabels } = usePaneContext();
  const isChats = location.pathname === '/' || location.pathname.startsWith('/c/');
  const isSettings = location.pathname.startsWith('/settings');

  return (
    <nav
      aria-label="Sections"
      className={`flex ${
        railLabels ? 'w-[184px]' : 'w-16'
      } shrink-0 flex-col border-e border-hairline bg-card py-3 transition-[width] duration-200 select-none`}
    >
      <div className="mb-2 flex justify-center">
        <Link
          to="/"
          aria-label="vartalap home"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-[17px] font-semibold text-ink-on-accent hover:brightness-95"
        >
          <ChatIcon className="h-5 w-5" />
        </Link>
      </div>

      <div className="flex flex-1 flex-col gap-1 px-2">
        <Link
          to="/"
          title="Chats"
          aria-label="Chats"
          className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-ink-muted transition-colors hover:bg-press ${
            isChats ? 'bg-selected text-ink font-semibold' : ''
          } ${railLabels ? '' : 'justify-center'}`}
        >
          <span className="shrink-0">
            <ChatIcon />
          </span>
          {railLabels && <span className="truncate text-[13px]">Chats</span>}
        </Link>

        <Link
          to="/settings"
          title="Settings"
          aria-label="Settings"
          className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-ink-muted transition-colors hover:bg-press ${
            isSettings ? 'bg-selected text-ink font-semibold' : ''
          } ${railLabels ? '' : 'justify-center'}`}
        >
          <span className="shrink-0">
            <SettingsIcon />
          </span>
          {railLabels && <span className="truncate text-[13px]">Settings</span>}
        </Link>
      </div>

      <div className="px-2">
        <button
          type="button"
          onClick={toggleRailLabels}
          aria-label="Toggle section labels"
          aria-pressed={railLabels}
          title="Toggle section labels"
          className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-ink-muted transition-colors hover:bg-press ${
            railLabels ? '' : 'justify-center'
          }`}
        >
          <span className="shrink-0">
            <PanelIcon />
          </span>
          {railLabels && <span className="text-[13px] font-medium">Collapse</span>}
        </button>
      </div>
    </nav>
  );
}

export function Layout() {
  const location = useLocation();
  const deps = useAppDeps();
  const isConversation = location.pathname.startsWith('/c/');

  const [storedPanes, setStoredPanes] = useState(() => {
    try {
      const raw = localStorage.getItem(PANES_KEY);
      if (raw !== null) {
        return JSON.parse(raw) as { listOpen?: boolean; detailsOpen?: boolean; railLabels?: boolean };
      }
      // Backward compatibility with previous LIST_OPEN_KEY
      const oldList = localStorage.getItem('vartalap.list-open');
      return { listOpen: oldList !== 'closed', detailsOpen: true, railLabels: false };
    } catch {
      return { listOpen: true, detailsOpen: true, railLabels: false };
    }
  });

  const listOpen = storedPanes.listOpen ?? true;
  const detailsOpen = storedPanes.detailsOpen ?? true;
  const railLabels = storedPanes.railLabels ?? false;

  const updatePanes = (next: { listOpen?: boolean; detailsOpen?: boolean; railLabels?: boolean }) => {
    setStoredPanes(next);
    try {
      localStorage.setItem(PANES_KEY, JSON.stringify(next));
    } catch {
      // pane preference storage error swallowed
    }
  };

  const toggleList = () => updatePanes({ ...storedPanes, listOpen: !listOpen });
  const toggleDetails = () => updatePanes({ ...storedPanes, detailsOpen: !detailsOpen });
  const toggleRailLabels = () => updatePanes({ ...storedPanes, railLabels: !railLabels });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        toggleList();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const paneContext: PaneContextValue = {
    listOpen,
    toggleList,
    detailsOpen,
    toggleDetails,
    railLabels,
    toggleRailLabels,
  };

  return (
    <PaneContext.Provider value={paneContext}>
      <div className="flex h-dvh bg-wash text-ink">
        <Rail />
        <aside
          aria-label="Conversations"
          className={`${isConversation ? 'hidden md:flex' : 'flex'} ${
            listOpen ? '' : 'md:hidden'
          } w-full flex-col border-e border-hairline bg-card md:w-[320px] md:shrink-0`}
        >
          <div className="shrink-0 px-3 pb-2 pt-3">
            <div className="mb-2 flex items-center justify-between">
              <h1 className="text-[19px] font-bold tracking-tight">Chats</h1>
              <button
                type="button"
                aria-label="New conversation"
                className="grid h-8 w-8 place-items-center rounded-full text-ink-muted hover:bg-press hover:text-ink"
              >
                <PlusIcon />
              </button>
            </div>
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint">
                <SearchIcon />
              </span>
              <input
                placeholder="Search Messenger"
                aria-label="Search Messenger"
                className="w-full rounded-full bg-wash py-1.5 pl-8 pr-3 text-[13px] text-ink outline-none placeholder:text-ink-faint"
              />
            </div>
          </div>
          <ConversationList viewerId={deps.viewerId} fetch={deps.fetch} />
        </aside>
        <div className={`${isConversation ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
          <Outlet />
        </div>
      </div>
    </PaneContext.Provider>
  );
}
