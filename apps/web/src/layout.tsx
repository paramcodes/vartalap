/**
 * The four-column shell per 0055 — with two columns still to come.
 *
 * Rail (flex, 64px) and list (`<aside>`, 320px, collapsible to zero) exist;
 * the transcript is an outlet placeholder until 6.3, and the details pane is
 * refused rather than closed (below 1150px it has no room; it arrives with
 * settings in 6.5 if anything). Under 760px the route decides the pane: `/`
 * shows the list, `/c/:id` shows the transcript, with a back affordance.
 *
 * `Cmd/Ctrl+B` belongs to the list alone — it is the only collapsible
 * region, so it is the only handler. The preference is device-local
 * (`localStorage`), never the account.
 */
import { createContext, useContext, useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router';
import type { MessageRow } from './store.ts';
import type { AppDeps } from './conversations.ts';
import { ConversationList } from './conversation-list.tsx';

export type { AppDeps };

const LIST_OPEN_KEY = 'vartalap.list-open';

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
  return (
    <nav aria-label="Sections" className="flex w-16 shrink-0 flex-col items-center gap-2 bg-card py-3">
      <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-accent text-[17px] font-semibold text-ink-on-accent">
        V
      </span>
    </nav>
  );
}

export function Layout() {
  const location = useLocation();
  const deps = useAppDeps();
  const isConversation = location.pathname.startsWith('/c/');
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(LIST_OPEN_KEY) !== 'closed';
    } catch {
      return true;
    }
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setOpen((was) => {
          const next = !was;
          try {
            localStorage.setItem(LIST_OPEN_KEY, next ? 'open' : 'closed');
          } catch {
            // A pane preference that cannot persist is a pane that still toggles.
          }
          return next;
        });
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="flex h-dvh bg-wash text-ink">
      <Rail />
      <aside
        aria-label="Conversations"
        className={`${isConversation ? 'hidden md:flex' : 'flex'} ${open ? '' : 'md:hidden'} w-full flex-col border-e border-hairline bg-card md:w-[320px] md:shrink-0`}
      >
        <div className="flex items-center justify-between px-3 pt-3">
          <h1 className="text-[17px] font-semibold">Chats</h1>
        </div>
        <ConversationList viewerId={deps.viewerId} fetch={deps.fetch} />
      </aside>
      <div className={`${isConversation ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
        <Outlet />
      </div>
    </div>
  );
}
