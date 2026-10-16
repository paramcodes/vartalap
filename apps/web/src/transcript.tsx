/**
 * The transcript — rendered from the Dexie table and nothing else (gate T2).
 *
 * Every row comes through `liveQuery` onto `rowsFor()`; a component holding a
 * transcript in memory shows a ghost whose position has already moved, because
 * two tabs share one store (0061). The rules it applies are proven elsewhere:
 * ordering in `render.ts`, burst corners in `burst.ts`, watermarks in
 * `store.ts`.
 *
 * Follow the bottom only for a member already at it (0047), and always for a
 * message this member caused. The predicate is one number in one module.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Seq } from '@vartalap/protocol';
import { renderedStateOf, transcript as orderRows } from './render.ts';
import {
  bubbleClasses,
  burstState,
  dayLabel,
  dividerAfter,
  isLastOutgoing,
} from './burst.ts';
import { getStore, startSession } from './db.ts';
import { useRows } from './rows.ts';
import type { MessageRow, MessageStore } from './store.ts';

/** Within this many pixels of the bottom, a member reads as "at the bottom" (0047). */
const AT_BOTTOM_PX = 64;

export interface TranscriptPanelDeps {
  readonly now?: () => number;
  readonly loadRows?: (conversationId: string) => Promise<MessageRow[]>;
  readonly startSession?: () => Promise<void>;
  /** Membership is a server read; injected in tests. */
  readonly loadMembers?: (conversationId: string) => Promise<readonly string[]>;
  /**
   * Which store the watermarks come from. Injected in tests so the rows and
   * the receipts come from the SAME database the test seeded — the production
   * singleton is not a test's to write.
   */
  readonly store?: () => Promise<MessageStore>;
  /** How this device reports a read. Injected in tests; production posts it. */
  readonly advanceReceipt?: (conversationId: string, through: string) => Promise<void>;
}

/**
 * Report a read: opening a conversation advances the receipt to the end
 * immediately, regardless of scroll (0047 says the predicate governs the view,
 * never the receipt). `shared_through` mirrors the share flag — which comes
 * from the membership read until 6.5 owns that toggle — because reporting a
 * `shared_through` above `read_through` is exactly the lie ADR 0010 refuses.
 */
export async function advanceReceiptThrough(conversationId: string, through: string): Promise<void> {
  const response = await fetch(`/api/conversations/${conversationId}/receipt/advance`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      conversationId,
      readThrough: through,
      sharedThrough: through,
    }),
  });
  if (!response.ok) throw new Error(`the receipt answered ${response.status}`);
}

/** Current members, reduced the way `store.isReadByOthers` wants them. */
async function loadMembers(conversationId: string): Promise<readonly string[]> {
  const response = await fetch(`/api/conversations/${conversationId}`, { credentials: 'include' });
  if (!response.ok) return [];
  const body = (await response.json()) as {
    members?: { userId?: string; leftAt?: string | null }[];
  };
  const current = (body.members ?? [])
    .filter((entry) => entry.leftAt == null && typeof entry.userId === 'string')
    .map((entry) => entry.userId as string);
  return current.sort();
}

export function Transcript({
  conversationId,
  viewerId,
  deps = {},
}: {
  conversationId: string;
  viewerId: string;
  deps?: TranscriptPanelDeps;
}) {
  const rows = useRows(conversationId, deps.loadRows);
  const ordered = useMemo(() => orderRows(rows), [rows]);
  const scroller = useRef<HTMLDivElement>(null);

  const [deliveredThrough, setDeliveredThrough] = useState<Seq | null>(null);
  const [seen, setSeen] = useState(false);
  const [memberIds, setMemberIds] = useState<readonly string[]>([]);
  const [overlay, setOverlay] = useState(0);
  const [now, setNow] = useState(() => (deps.now ?? Date.now)());
  const lastKnown = useRef<number | null>(null);
  /** The last position this device reported as read — one post per new value. */
  const lastPosted = useRef<string | null>(null);

  /**
   * Effects depend on the FUNCTIONS they call, so the injected ones are held in
   * refs: a test that writes `store: async () => store` inline builds a new
   * identity on every render, and an effect keyed on it re-runs forever — two
   * read advances per render, measured. The ref is the identity that does not
   * move, and the effect keys are the values that do.
   */
  const latest = useRef(deps);
  latest.current = deps;
  const storeOf = useCallback(() => (latest.current.store ?? getStore)(), []);
  const advanceRead = useCallback(
    (conversationId: string, through: string) => {
      const advance = latest.current.advanceReceipt ?? advanceReceiptThrough;
      return advance(conversationId, through);
    },
    [],
  );

  // Sessions mean catch-up and flush; every mount runs it once.
  useEffect(() => {
    const boot = latest.current.startSession ?? startSession;
    void boot();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (latest.current.loadMembers ?? loadMembers)(conversationId).then((members) => {
      if (!cancelled) setMemberIds(members);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  // `Seen` is computed over `shared_through` and nowhere else (trap 14).
  useEffect(() => {
    const last = ordered.at(-1);
    const at = last?.seq;
    if (conversationId === null || at === undefined || at === null || memberIds.length === 0) {
      setSeen(false);
      return;
    }
    let cancelled = false;
    void storeOf().then((store) =>
      store
        .isReadByOthers({ conversationId, viewerId, currentMemberIds: memberIds, at })
        .then((answer) => {
          if (!cancelled) setSeen(answer);
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [ordered, conversationId, viewerId, memberIds, storeOf]);

  // The local delivery watermark is ALSO the read position this device reports:
  // "a frame arrived at my client and was persisted" is one fact doing two
  // jobs, so both come off one query and one effect.
  useEffect(() => {
    let cancelled = false;
    void storeOf().then((store) =>
      store.heldThrough(conversationId).then((through) => {
        if (cancelled) return;
        setDeliveredThrough(through);
        // The read advance is posted off the VALUE, not the row list. Gating on
        // the position — rather than on the effect re-running — is what makes
        // "advance once per new position" true under any number of re-renders.
        if (through === null) return;
        const position = String(through);
        if (lastPosted.current === position) return;
        lastPosted.current = position;
        // A failed read advance retries on the next arrival; the row is not the
        // source of truth and nothing here has to fall back.
        void advanceRead(conversationId, position).catch(() => {});
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [ordered, conversationId, storeOf, advanceRead]);

  // 0047: follow the bottom only for a member already at it — and always for
  // a message this member sent, because the composer has to come back home.
  useEffect(() => {
    const node = scroller.current;
    if (node === null) return;
    const latest = ordered.at(-1);
    if (latest === undefined) return;

    const position = latest.seq === null ? -Number(latest.createdAt) : Number(BigInt(latest.seq));
    if (lastKnown.current === position) return;
    const first = lastKnown.current === null;
    lastKnown.current = position;

    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight <= AT_BOTTOM_PX;
    if (first || atBottom || latest.authorId === viewerId) {
      node.scrollTop = node.scrollHeight;
      setOverlay(0);
    } else {
      setOverlay((count) => count + 1);
    }
  }, [ordered, viewerId]);

  // The clock is read once per conversation: a divider label that changes under
  // a reader is the distraction the concept document warns about.
  useEffect(() => {
    setNow((deps.now ?? Date.now)());
  }, [conversationId, deps.now]);

  return (
    <main className="relative flex min-h-0 flex-1 flex-col">
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 py-3">
        <div className="mx-auto flex w-full max-w-[760px] flex-col">
          {ordered.map((row, index) => {
            const outgoing = row.authorId === viewerId;
            const state = renderedStateOf(row, {
              ownReadThrough: null,
              deliveredThrough,
            });
            const last = isLastOutgoing(ordered, row, viewerId);
            return (
              <div key={row.id}>
                {dividerAfter(ordered, index) && (
                  <div className="my-3 flex justify-center">
                    <span className="rounded-full bg-card px-2.5 py-1 text-[11px] font-medium text-ink-muted shadow-2xs">
                      {dayLabel(ordered[index]!.createdAt, now)}
                    </span>
                  </div>
                )}
                <div className={`mb-1 flex ${outgoing ? 'justify-end' : 'justify-start'}`}>
                  <p
                    className={`${bubbleClasses(burstState(ordered, index))} max-w-[74%] px-3 py-2 text-[15px] leading-snug whitespace-pre-wrap ${
                      outgoing ? 'bg-bubble-out text-ink-on-accent' : 'bg-bubble-in text-ink'
                    }`}
                  >
                    {row.body}
                  </p>
                </div>
                {outgoing && last && (
                  <div className="flex justify-end">
                    <span className="mb-1 text-[11px] text-ink-faint">
                      {seen ? 'Seen' : state === 'sent' ? 'Sent' : state === 'delivered' ? 'Delivered' : state === 'read' ? 'Read' : state}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {overlay > 0 && (
        <button
          type="button"
          onClick={() => {
            const node = scroller.current;
            if (node !== null) node.scrollTop = node.scrollHeight;
            setOverlay(0);
          }}
          className="absolute bottom-4 start-1/2 -translate-x-1/2 rounded-full bg-card px-3 py-1 text-[13px] text-ink"
        >
          {overlay} new message{overlay === 1 ? '' : 's'}
        </button>
      )}
    </main>
  );
}
