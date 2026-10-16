/**
 * The conversation list (unit 6.2, gate T1).
 *
 * One `<aside>` and nothing else is one: the rail and the (future) details
 * pane are flex columns per 0055, and exactly one collapsible region exists
 * anywhere — which is how trap 11's three-`Cmd+B`-handlers failure is
 * structurally impossible rather than carefully avoided.
 *
 * Rows render server order and never re-sort. Mute renders a glyph beside the
 * badge, never instead of it and never as a filter (0046). A locked pair
 * still opens — blocks gate sending, never reading — with the lock as the
 * affordance the permission reason earns.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ConversationListItem } from '@vartalap/protocol';
import { queryClient, useConversations, type ListDeps } from './conversations.ts';
import { loadRows } from './db.ts';
import { useAppTestDeps } from './layout.tsx';
import {
  badgeLabel,
  badgeText,
  deriveTitle,
  formatTime,
  hueOf,
  initialsOf,
  rowPreview,
} from './list.ts';
import type { MessageRow } from './store.ts';

export interface ConversationListDeps extends ListDeps {
  /** The signed-in member, from `/api/me` — titles derive against it. */
  readonly viewerId: string;
  /** Injected in tests; production reads the shared store. */
  readonly loadRows?: (conversationId: string) => Promise<MessageRow[]>;
  /** Injected clock so timestamps are asserted, not flaked on. */
  readonly now?: () => number;
}

function MuteGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-label="Muted" role="img" className="text-ink-faint">
      <path
        d="M8 1.5a4.5 4.5 0 0 0-4.5 4.5v2.7L1.7 10.5l1.1 1.1 10.6-10.6-1.1-1.1-2.1 2.1A4.5 4.5 0 0 0 8 1.5ZM6 13.5a1.5 1.5 0 0 0 2.8.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LockGlyph({ label }: { label: string }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-label={label} role="img" className="text-ink-faint">
      <rect x="3" y="7" width="10" height="7" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Avatar({ name, id, online }: { name: string; id: string; online: boolean }) {
  const hue = hueOf(id);
  return (
    <span className="relative shrink-0">
      <span
        aria-hidden="true"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-[hsl(var(--avatar-hue)_70%_85%)] text-[17px] font-semibold text-ink dark:bg-[hsl(var(--avatar-hue)_40%_30%)] dark:text-ink"
        style={{ '--avatar-hue': hue } as React.CSSProperties}
      >
        {initialsOf(name)}
      </span>
      {online && (
        <span
          aria-label="Active now"
          className="absolute bottom-0 end-0 h-3.5 w-3.5 rounded-full bg-presence ring-[3px] ring-card"
        />
      )}
    </span>
  );
}

function ConversationRow({
  item,
  viewerId,
  position,
  total,
  rows,
  now,
}: {
  item: ConversationListItem;
  viewerId: string;
  position: number;
  total: number;
  rows: readonly MessageRow[];
  now: number;
}) {
  const title = deriveTitle(item, viewerId);
  const preview = rowPreview(item, rows);
  const badge = badgeText(item.unreadCount);
  const peer = item.kind === 'direct' ? item.peers?.[0] : undefined;
  const online = peer !== undefined && (item.presence ?? []).some((p) => String(p.userId) === String(peer.userId) && p.online);
  const latestPositioned = rows
    .filter((row) => row.seq !== null)
    .sort((a, b) => Number(BigInt(b.seq!) - BigInt(a.seq!)))[0];
  const time = latestPositioned !== undefined ? formatTime(latestPositioned.createdAt, now) : null;
  const locked = item.permission.allowed === false;
  const lockLabel =
    item.permission.allowed === false && item.permission.reason === 'blocked_by_me'
      ? 'You blocked this conversation'
      : item.permission.allowed === false && item.permission.reason === 'blocked_by_them'
        ? 'You are blocked from sending here'
        : 'Sending is unavailable here';

  return (
    <div role="article" aria-posinset={position} aria-setsize={total} aria-labelledby={`row-${item.conversationId}-name row-${item.conversationId}-preview`}>
      <Link
        to={`/c/${item.conversationId}`}
        className="flex h-[72px] items-center gap-3 px-3 hover:bg-press"
      >
        <Avatar name={title} id={String(item.conversationId)} online={online} />
        <span className="flex min-w-0 flex-1 flex-col justify-center">
          <span id={`row-${item.conversationId}-name`} className="truncate text-[17px] font-semibold text-ink">
            {title}
          </span>
          <span id={`row-${item.conversationId}-preview`} className="truncate text-[15px] text-ink-muted">
            {preview.text}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          {time !== null && (
            <time dateTime={new Date(latestPositioned!.createdAt).toISOString()} className="text-[13px] text-ink-faint">
              {time}
            </time>
          )}
          <span className="flex items-center gap-1.5">
            {item.muted && <MuteGlyph />}
            {locked && <LockGlyph label={lockLabel} />}
            {badge !== null && (
              <span aria-label={badgeLabel(item.unreadCount)} className="flex h-5 min-w-5 items-center justify-center rounded-full bg-accent px-1 text-xs font-medium text-ink-on-accent">
                {badge}
              </span>
            )}
          </span>
        </span>
      </Link>
    </div>
  );
}

function StartConversation({ fetchFn }: { fetchFn: typeof globalThis.fetch | undefined }) {
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
    <form onSubmit={start} className="flex flex-col gap-2 p-3">
      <label htmlFor="new-handle" className="text-[15px] text-ink">
        Search for a handle to start one.
      </label>
      <span className="flex gap-2">
        <input
          id="new-handle"
          value={handle}
          onChange={(event) => setHandle(event.target.value)}
          placeholder="handle"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-lg border border-hairline bg-card px-2 py-1 text-ink"
        />
        <button type="submit" className="rounded-xl bg-accent px-3 py-1 text-ink-on-accent">
          Start
        </button>
      </span>
      {error !== null && (
        <p role="alert" className="text-[13px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

export function ConversationList(deps: ConversationListDeps) {
  const list = useConversations(deps);
  const testDeps = useAppTestDeps();
  const [rowsByConversation, setRowsByConversation] = useState<ReadonlyMap<string, MessageRow[]>>(new Map());
  const now = (deps.now ?? testDeps.now ?? Date.now)();
  const viewerId = deps.viewerId;

  const items = list.data;
  useEffect(() => {
    if (items === undefined) return;
    let cancelled = false;
    const load = deps.loadRows ?? testDeps.loadRows ?? loadRows;
    void Promise.all(items.map((item) => load(String(item.conversationId)))).then((all) => {
      if (cancelled) return;
      setRowsByConversation(
        new Map(items.map((item, index) => [String(item.conversationId), all[index] ?? []])),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [items, deps.loadRows, testDeps.loadRows]);

  if (list.isPending || items === undefined) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-ink-faint">Loading…</p>
      </div>
    );
  }

  if (list.isError) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2">
        <p className="text-ink">Can&apos;t load conversations.</p>
        <button type="button" onClick={() => list.refetch()} className="rounded-xl bg-accent px-3 py-1 text-ink-on-accent">
          Try again
        </button>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col justify-center">
        <p className="px-3 text-[15px] text-ink">No conversations yet.</p>
        <StartConversation fetchFn={deps.fetch} />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {list.isFetching && (
        <div aria-hidden="true" className="absolute inset-x-0 top-0 h-[2px] bg-accent" />
      )}
      <div role="feed" aria-busy={list.isFetching} aria-label="Conversations" className="min-h-0 flex-1 overflow-y-auto">
        {items.map((item, index) => (
          <ConversationRow
            key={String(item.conversationId)}
            item={item}
            viewerId={viewerId}
            position={index + 1}
            total={items.length}
            rows={rowsByConversation.get(String(item.conversationId)) ?? []}
            now={now}
          />
        ))}
      </div>
    </div>
  );
}
