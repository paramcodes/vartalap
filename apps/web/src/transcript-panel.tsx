/**
 * The transcript route panel: the route's id, the transcript, the retry strip
 * above the composer, and the composer itself — gate T3's surfaces in the one
 * place the send flow lives.
 *
 * The send path is `send.ts`'s, and this is a caller of it the way any other
 * caller would be: `queueSend` for the durable write, `flushQueue` for the
 * `POST`, and the ONE receive path for the answer. The retry reuses the row's
 * own id, which is the idempotency key (ADR 0004) — that is what makes
 * retrying safe rather than a second message.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { SendPermission } from '@vartalap/protocol';
import { Composer } from './composer.tsx';
import { queryClient, useConversations } from './conversations.ts';
import { getStore } from './db.ts';
import { DetailsPane } from './details.tsx';
import { InfoIcon, ListIcon, PhoneIcon, VideoIcon } from './icons.tsx';
import { useAppDeps, usePaneContext } from './layout.tsx';
import { deriveTitle, hueOf, initialsOf } from './list.ts';
import { failedRows } from './retry.ts';
import { flushQueue, queueSend } from './send.ts';
import { Transcript } from './transcript.tsx';
import { fetchTransport } from './transport.ts';
import type { MessageRow, MessageStore } from './store.ts';

const OPEN: SendPermission = { allowed: true };

function StartConversationInline({ fetchFn }: { fetchFn: typeof globalThis.fetch | undefined }) {
  const navigate = useNavigate();
  const [handle, setHandle] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function start(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const send = fetchFn ?? globalThis.fetch;
    let response: Response;
    try {
      response = await send('/api/conversations/direct', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: handle.trim().toLowerCase() }),
      });
    } catch {
      setError("Can't start that conversation.");
      return;
    }
    if (response.status === 404) {
      setError('No such handle.');
      return;
    }
    if (!response.ok) {
      setError("Can't start that conversation.");
      return;
    }
    const body = (await response.json()) as { id: string };
    void queryClient.invalidateQueries({ queryKey: ['conversations'] });
    navigate(`/c/${body.id}`);
  }

  return (
    <form onSubmit={start} className="mt-2 flex flex-col gap-2 text-left">
      <label htmlFor="empty-new-handle" className="text-xs font-medium text-ink-muted">
        Start Direct Message
      </label>
      <div className="flex gap-2">
        <input
          id="empty-new-handle"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          placeholder="Enter username/handle"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-xl border border-hairline bg-wash px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
        <button
          type="submit"
          className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-ink-on-accent transition hover:brightness-95"
        >
          Start
        </button>
      </div>
      {error !== null && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

/** `/` — the transcript pane with nothing selected. */
export function EmptyTranscript() {
  const { fetch: fetchFn } = useAppDeps();
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-4 bg-wash p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-3 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-card text-2xl text-accent shadow-xs">
          💬
        </span>
        <h2 className="text-lg font-bold text-ink">Welcome to vartalap</h2>
        <p className="text-[14px] text-ink-muted">Select an existing conversation, or start a new direct message.</p>
        <div className="w-full rounded-2xl border border-hairline bg-card p-4 shadow-xs">
          <StartConversationInline fetchFn={fetchFn} />
        </div>
      </div>
    </main>
  );
}

/** `/c/:id` — the transcript, its retry strips, and the composer. */
export function TranscriptPanel() {
  const { id } = useParams<{ id: string }>();
  const { viewerId, fetch: fetchFn } = useAppDeps();
  const { listOpen, toggleList, detailsOpen, toggleDetails } = usePaneContext();

  const [store, setStore] = useState<MessageStore | undefined>(undefined);
  const [permission, setPermission] = useState<SendPermission>(OPEN);
  const [failed, setFailed] = useState<readonly MessageRow[]>([]);

  const conversationsQuery = useConversations({ fetch: fetchFn });
  const conversation = conversationsQuery.data?.find((c) => c.conversationId === id);
  const title = conversation ? deriveTitle(conversation, viewerId) : 'Conversation';
  const isOnline = conversation?.presence.some((p) => p.userId !== viewerId && p.online) ?? true;
  const hue = id ? hueOf(id) : 210;
  const initials = initialsOf(title);

  // The store, once. The composer needs it for drafts, which are device-local
  // (0049) — a store that is `undefined` means no draft anywhere.
  useEffect(() => {
    let cancelled = false;
    void getStore().then((opened) => {
      if (!cancelled) setStore(opened);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The permission comes from the same read that gives the transcript its
  // members: the one predicate the send path uses (ADR 0007), so a lock the
  // composer shows is a refusal the server would make.
  useEffect(() => {
    if (id === undefined) return;
    let cancelled = false;
    void fetch(`/api/conversations/${id}`, { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (cancelled || body === null) return;
        const found = (body as { permission?: SendPermission }).permission;
        if (found !== undefined) setPermission(found);
      })
      .catch(() => {
        // A membership that cannot be read leaves the composer locked rather
        // than optimistic: the safe direction is not to send.
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Failed rows are a query over the table, not component state — the strip
  // appears when the table says so, and disappears when the retry lands.
  useEffect(() => {
    if (id === undefined || store === undefined) return;
    let cancelled = false;
    void store.rowsFor(id).then((rows) => {
      if (!cancelled) setFailed(failedRows(rows));
    });
    return () => {
      cancelled = true;
    };
  }, [id, store, failed.length]);

  const send = useCallback(
    (text: string) => {
      if (id === undefined) return;
      void (async () => {
        const opened = await getStore();
        await queueSend({
          store: opened,
          conversationId: id as never,
          authorId: viewerId,
          permission,
          text,
          now: Date.now(),
        });
        await flushQueue(opened, fetchTransport({ baseUrl: '' }));
      })();
    },
    [id, viewerId, permission],
  );

  const retry = useCallback(
    (rowId: string) => {
      void (async () => {
        const opened = await getStore();
        // The discard is the member's, never the system's (ADR 0053), and it
        // can only take a row the server has not positioned.
        await opened.discardSend(rowId);
        await flushQueue(opened, fetchTransport({ baseUrl: '' }));
      })();
    },
    [],
  );

  if (id === undefined || store === undefined) return <EmptyTranscript />;

  return (
    <div className="flex h-full min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col bg-wash">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline bg-card px-4">
          <Link
            to="/"
            aria-label="Back to conversations"
            className="grid h-9 w-9 place-items-center rounded-full text-ink-muted hover:bg-press hover:text-ink md:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M11 4L5 9l6 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </Link>
          <button
            type="button"
            onClick={toggleList}
            aria-label="Toggle conversation list"
            aria-pressed={listOpen}
            className={`hidden md:grid h-9 w-9 place-items-center rounded-full text-ink-muted hover:bg-press hover:text-ink transition-opacity ${
              listOpen ? 'opacity-100' : 'opacity-45'
            }`}
          >
            <ListIcon />
          </button>
          <span
            aria-hidden="true"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-semibold text-white shadow-2xs"
            style={{ background: `hsl(${hue} 46% 46%)` }}
          >
            {initials}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold leading-tight text-ink">{title}</h2>
            <p className="truncate text-[12px] text-ink-muted">
              {isOnline ? 'Active now' : 'Active recently'}
            </p>
          </div>
          <span className="flex-1" />
          <button
            type="button"
            disabled
            aria-label="Voice call"
            title="Calls are tier 3"
            className="grid h-9 w-9 place-items-center rounded-full text-ink-muted hover:bg-press hover:text-ink disabled:opacity-40"
          >
            <PhoneIcon />
          </button>
          <button
            type="button"
            disabled
            aria-label="Video call"
            title="Calls are tier 3"
            className="grid h-9 w-9 place-items-center rounded-full text-ink-muted hover:bg-press hover:text-ink disabled:opacity-40"
          >
            <VideoIcon />
          </button>
          <button
            type="button"
            onClick={toggleDetails}
            aria-label="Toggle conversation details"
            aria-pressed={detailsOpen}
            className={`grid h-9 w-9 place-items-center rounded-full text-ink-muted hover:bg-press hover:text-ink transition-opacity ${
              detailsOpen ? 'opacity-100' : 'opacity-45'
            }`}
          >
            <InfoIcon />
          </button>
        </header>

        <Transcript conversationId={id} viewerId={viewerId} />
        {failed.length > 0 && (
          <div className="border-t border-danger bg-card px-4 py-2">
            <div className="mx-auto flex max-w-[760px] flex-col gap-1">
              {failed.map((row) => (
                <div key={row.id} className="flex items-center justify-between gap-2">
                  <span className="text-[13px] text-danger">
                    Not sent{row.failureDetail === null ? '' : `: ${row.failureDetail}`}
                  </span>
                  <span className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => retry(row.id)}
                      className="rounded-lg border border-hairline px-2.5 py-1 text-[13px] text-ink hover:bg-press"
                    >
                      Try again
                    </button>
                    <button
                      type="button"
                      onClick={() => retry(row.id)}
                      className="rounded-lg px-2.5 py-1 text-[13px] text-ink-muted hover:bg-press hover:text-ink"
                    >
                      Delete
                    </button>
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        <Composer
          permission={permission}
          conversationId={id}
          send={send}
          store={store}
        />
      </div>
      {detailsOpen && <DetailsPane conversationId={id} title={title} isOnline={isOnline} />}
    </div>
  );
}
