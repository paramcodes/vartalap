/**
 * What the transcript is DRAWN from, and the two rules that are easy to undo by
 * accident.
 *
 * There is no interface in this unit — stage 6 writes it — so everything here is a
 * pure function over rows the store returned. That is deliberate: the two facts
 * this file owns are the ones that rot when somebody reaches for a component
 * shortcut, and they should be testable without one.
 *
 * ── 1. a message never moves ───────────────────────────────────────────────
 *
 * `composer-and-sending.md`: *"A message that renders in one place and then
 * visibly moves when its real position arrives reads as a bug even when it is
 * behaving correctly."* So there is no provisional position anywhere in this
 * package: `queueSend` writes `seq: null` and **nothing** in `apps/web` ever
 * assigns one. Unpositioned rows sort after everything positioned, ordered among
 * themselves by client creation time, and they sit there until the server says
 * where they go.
 *
 * The one client-clock ordering in the whole system is that tiebreak, and it is
 * the smallest one available: it orders rows the server has not placed yet, and
 * every one of them moves onto a server position the moment it arrives. ADR 0005
 * forbids client timestamps as a sort key — this is the documented exception to
 * that, not a violation of it, and the comment here is where the next reader
 * finds out.
 *
 * ── 2. what is read is decided over `shared_through` ───────────────────────
 *
 * `isReadByOthers` in `store.ts` is where that lives, and this file is its only
 * caller in the direction that matters. `GLOSSARY.md` says `Seen` is interface
 * copy and appears in no schema, no protocol and no model; so it appears in no
 * function name here either.
 */
import { deriveRenderedMessageState, type RenderedMessageState, type Seq } from '@vartalap/protocol';
import { compareSeq, type MessageRow } from './store.ts';

/**
 * The transcript, oldest first — `GLOSSARY.md`'s definition of the word.
 *
 * **Positioned rows first, by `seq`.** Server-assigned, globally ordered, and the
 * only thing that ever orders a committed message.
 *
 * **Then unpositioned rows, by client creation time**, with the UUIDv7 as the
 * tiebreak. `message-lifecycle.md` §2 says exactly this: *"unsent messages simply
 * sort after everything that has been positioned, ordered among themselves by
 * client creation time."*
 *
 * The sort is in JavaScript over bigints and NOT a Dexie `orderBy`, for the reason
 * in `store.ts`'s header: `seq` is a decimal string and an IndexedDB string index
 * compares `'9' > '10'`.
 */
export function transcript(rows: readonly MessageRow[]): MessageRow[] {
  return [...rows].sort((left, right) => {
    if (left.seq === null && right.seq === null) {
      return left.createdAt - right.createdAt || compareIds(left.id, right.id);
    }
    // Unpositioned sorts AFTER everything positioned. Never interleaved.
    if (left.seq === null) return 1;
    if (right.seq === null) return -1;
    return compareSeq(left.seq, right.seq);
  });
}

/**
 * Lexicographic, which for a UUIDv7 is chronological **within one generator** —
 * i.e. within one tab. Two tabs' ids in the same millisecond order arbitrarily
 * here, and `seq` replaces that answer as soon as the server has one.
 */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * What the interface renders for one row.
 *
 * `ownReadThrough` is **the viewer's own private position, about themselves.** It
 * is named that way rather than `readThrough` so that nobody can pass a reduced
 * watermark here and start broadcasting a hidden gap by accident. Nothing another
 * member observes is computed from it — `message-lifecycle.md` §9's marker under
 * the last outgoing message comes from
 * {@link MessageStore.isReadByOthers}, which reads `shared_through` and nothing
 * else (ADR 0010, decision-index trap 14).
 *
 * `deliveredThrough` arrives already reduced by the caller, per ADR 0060: the
 * protocol compares a position against a watermark and does not decide which
 * members qualify. For THIS browser the reduction is
 * {@link MessageStore.heldThrough}, because the fact "a frame arrived at my client
 * and was persisted" is the highest position this browser holds.
 */
export function renderedStateOf(
  row: MessageRow,
  watermarks: {
    readonly ownReadThrough: Seq | null;
    readonly deliveredThrough: Seq | null;
  },
): RenderedMessageState {
  // A row with no position is still local. `deriveRenderedMessageState` reads
  // `position`, which is `Seq | null`, and returns the stored state for it —
  // nothing here has to know what `queued` looks like.
  return deriveRenderedMessageState({
    state: row.state,
    position: row.seq,
    deliveredThrough: watermarks.deliveredThrough,
    readThrough: watermarks.ownReadThrough,
  });
}