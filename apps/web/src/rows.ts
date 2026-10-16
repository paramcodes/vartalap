/**
 * The transcript's rows, live from the Dexie table — gate T2's rendering
 * rule, and the reason this is a subscription rather than a fetch.
 *
 * A component holding a transcript in memory shows a ghost whose position has
 * already moved, because two tabs share one store (0061). The rows come from
 * the one write path through the one database handle, and the only other
 * reader of a position in here is `store.isReadByOthers`.
 *
 * Production runs under the browser's evaluator, where `document` carries the
 * real IndexedDB. Tests run under happy-dom, which has none — so a test
 * injects a loader and the subscription is never constructed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { getStore } from './db.ts';
import type { MessageRow } from './store.ts';

/** The rows a transcript draws, in arrive order — `transcript()` sorts them. */
export function useRows(
  conversationId: string | null,
  loadRows?: (conversationId: string) => Promise<MessageRow[]>,
): readonly MessageRow[] {
  const key = conversationId === null ? null : String(conversationId);
  const [rows, setRows] = useState<readonly MessageRow[]>([]);

  // The loader is read through a ref on purpose. A test that passes
  // `loadRows: () => store.rowsFor(id)` inline builds a new function every
  // render, and an effect keyed on it re-runs forever — measured: four read
  // advances for one mount. The ref is the identity that does not move; the
  // effect keys are the values that do.
  const loader = useRef(loadRows);
  loader.current = loadRows;

  useEffect(() => {
    if (key === null) {
      setRows([]);
      return;
    }
    const injected = loader.current;
    if (injected !== undefined) {
      let cancelled = false;
      void injected(key).then((next) => {
        if (!cancelled) setRows(next);
      });
      return () => {
        cancelled = true;
      };
    }
    let store: ReturnType<typeof getStore>;
    try {
      store = getStore();
    } catch {
      return;
    }
    const subscription = liveQuery(async () => (await store).rowsFor(key)).subscribe({
      next: setRows,
    });
    return () => subscription.unsubscribe();
  }, [key]);

  // The identity that does not move between renders: an effect keyed on `rows`
  // re-runs on every state update if this returned a fresh object each time.
  return useMemo(() => rows, [rows]);
}
