/**
 * The failed row's strip — queued sends are never discarded (ADR 0053).
 *
 * `Nothing is retracted` means a queued send can be waited for or discarded,
 * never changed, and a message somebody pressed send on is never silently
 * dropped. The strip therefore renders for exactly the `failed` state, and
 * its retry reuses the idempotency key that is already on the row — which is
 * the whole reason retrying is safe (ADR 0004).
 */
import type { MessageRow } from './store.ts';

export type RetryAction =
  | { readonly kind: 'retry'; readonly id: string }
  | { readonly kind: 'delete'; readonly id: string };

/** The strip's copy. A machine-readable `code` drives nothing visible. */
export function failureStrip(row: MessageRow): { title: string; detail: string } {
  if (row.state !== 'failed') return { title: '', detail: '' };
  return { title: 'Not sent', detail: row.failureDetail ?? 'Try again' };
}

/**
 * Which rows get a strip. Exactly the terminal ones: `queued` and `inFlight`
 * are still working, and a positioned row has already been answered.
 */
export function failedRows(rows: readonly MessageRow[]): MessageRow[] {
  return rows.filter((row) => row.state === 'failed');
}
