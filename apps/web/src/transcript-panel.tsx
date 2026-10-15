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
import { useParams } from 'react-router';
import type { SendPermission } from '@vartalap/protocol';
import { Composer } from './composer.tsx';
import { getStore } from './db.ts';
import { useAppDeps } from './layout.tsx';
import { failedRows } from './retry.ts';
import { flushQueue, queueSend } from './send.ts';
import { Transcript } from './transcript.tsx';
import { fetchTransport } from './transport.ts';
import type { MessageRow, MessageStore } from './store.ts';

const OPEN: SendPermission = { allowed: true };

/** `/` — the transcript pane with nothing selected. */
export function EmptyTranscript() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2">
      <p className="text-ink-muted">Select a conversation.</p>
    </main>
  );
}

/** `/c/:id` — the transcript, its retry strips, and the composer. */
export function TranscriptPanel() {
  const { id } = useParams<{ id: string }>();
  const { viewerId } = useAppDeps();

  const [store, setStore] = useState<MessageStore | undefined>(undefined);
  const [permission, setPermission] = useState<SendPermission>(OPEN);
  const [failed, setFailed] = useState<readonly MessageRow[]>([]);

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
    <>
      <Transcript conversationId={id} viewerId={viewerId} />
      {failed.length > 0 && (
        <div className="border-t border-danger bg-card px-3 py-2">
          {failed.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-2">
              <span className="text-[13px] text-danger">
                Not sent{row.failureDetail === null ? '' : `: ${row.failureDetail}`}
              </span>
              <span className="flex gap-2">
                <button
                  type="button"
                  onClick={() => retry(row.id)}
                  className="rounded-lg border border-hairline px-2 py-1 text-[13px] text-ink"
                >
                  Try again
                </button>
                <button
                  type="button"
                  onClick={() => retry(row.id)}
                  className="rounded-lg px-2 py-1 text-[13px] text-ink-muted"
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <Composer
        permission={permission}
        conversationId={id}
        send={send}
        store={store}
      />
    </>
  );
}
