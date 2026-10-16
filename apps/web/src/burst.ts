/**
 * The pure rules of the transcript's drawing. No component, no rows.
 *
 * Divider and burst here, day boundary elsewhere. What is NOT here and why:
 * - **The `Seen` predicate** lives where ADR 0003 says it lives — the store's
 *   `isReadByOthers` over `shared_through`. A second implementation in a
 *   drawing helper is the shape this repo keeps paying for.
 * - **Ordering** lives in `render.ts`, over the same rows.
 */
import type { MessageRow } from './store.ts';

/** Same calendar day means same day — no time-of-day carry-over. */
function sameDay(left: number, right: number): boolean {
  const a = new Date(left);
  const b = new Date(right);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Is there a date boundary between `index` and the row below it? */
export function dividerAfter(rows: readonly MessageRow[], index: number): boolean {
  if (index < 0 || index >= rows.length - 1) return false;
  return !sameDay(rows[index]!.createdAt, rows[index + 1]!.createdAt);
}

export function dayLabel(atMs: number, nowMs: number): string {
  const at = new Date(atMs);
  const now = new Date(nowMs);
  if (sameDay(atMs, nowMs)) return 'Today';
  if (sameDay(atMs, nowMs - 86_400_000)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(at);
}

/**
 * ADR 0002's four burst states: single, first, middle, last, and
 * `middle`/`last` identical by construction. A divider terminates a run, so
 * the day boundary is checked on both sides before a neighbour counts.
 */
export function burstState(
  rows: readonly MessageRow[],
  index: number,
): 'single' | 'first' | 'middle' | 'last' {
  const row = rows[index];
  if (row === undefined) return 'single';
  const after = rows[index - 1];
  const before = rows[index + 1];
  const sameAfter =
    after !== undefined &&
    after.authorId === row.authorId &&
    !dividerAfter(rows, index - 1);
  const sameBefore =
    before !== undefined &&
    before.authorId === row.authorId &&
    !dividerAfter(rows, index);
  if (sameAfter) return sameBefore ? 'middle' : 'last';
  return sameBefore ? 'first' : 'single';
}

/**
 * Logical longhands only — `rounded-se-sm` mirrors itself under `dir="rtl"`
 * and nothing has to branch on side. ADR 0002: only the narrowed corners are
 * overridden, the base radius is the token.
 */
export function bubbleClasses(burst: 'single' | 'first' | 'middle' | 'last'): string {
  switch (burst) {
    case 'first':
      return 'rounded-xl rounded-se-sm';
    case 'middle':
      return 'rounded-xl rounded-s-sm rounded-e-sm';
    case 'last':
      return 'rounded-xl rounded-s-sm rounded-e-sm';
    case 'single':
      return 'rounded-xl';
  }
}

/** Is `row` the newest message this member sent — the only place `Seen` may hang. */
export function isLastOutgoing(
  rows: readonly MessageRow[],
  row: MessageRow,
  viewerId: string,
): boolean {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const candidate = rows[index]!;
    if (candidate.authorId === viewerId) return candidate.id === row.id;
  }
  return false;
}
