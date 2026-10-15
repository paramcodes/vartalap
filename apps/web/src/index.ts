/**
 * `apps/web` — the client data layer, and nothing else.
 *
 * **No interface until stage 6** (ADR 0054). Everything exported here is either a
 * pure function over rows or a durable store; there is no component, no route and
 * no transport *client* beyond `fetch`.
 *
 * The exports are grouped by the three jobs the package has:
 *
 * - **Store** — `createStore`, `MessageStore`, and the row types. The only module
 *   in this package that touches IndexedDB.
 * - **Paths** — `queueSend`/`flushQueue` (sending), `receiveFrame` (live),
 *   `catchUp`/`reconcileConversation` (reconnecting), `transcript` (drawing).
 * - **Wire** — `fetchTransport` and the `Transport` interface everything is written
 *   against, so every test in this package can substitute a double.
 */

// The store, its rows, and the one write path.
export {
  CURSOR_KEY,
  MessageStore,
  compareSeq,
  createStore,
  seqAtOrPast,
  type CursorRow,
  type DiscrepancyRow,
  type DraftRow,
  type LocalSendInput,
  type MessageRow,
  type ReadByOthersInput,
  type ReceiptRow,
  type ReceiveOutcome,
} from './store.ts';

// Sending. Steps 1–4 and 6–7 of `composer-and-sending.md`.
export {
  BACKOFF_LADDER,
  backoffDelay,
  canSend,
  flushQueue,
  queueSend,
  type CanSend,
  type FlushOptions,
  type FlushReport,
  type QueueSendInput,
  type QueueSendOutcome,
} from './send.ts';

// Live frames — call site one of three.
export { receiveFrame, type FrameOutcome } from './live.ts';

// Reconnecting — call site two of three, and gate G4.
export {
  catchUp,
  reconcileAll,
  reconcileConversation,
  type CatchUpResult,
  type ReconciliationReport,
} from './catch-up.ts';

// Drawing. No component: stage 6 owns the surface, and this owns the two rules it
// would otherwise re-decide.
export { renderedStateOf, transcript } from './render.ts';

// The wire.
export { fetchTransport, type FetchTransportOptions, type SendAnswer, type Transport } from './transport.ts';

// Identity and the idempotency key, one value, two jobs (ADR 0004).
export { mintMessageId } from './message-id.ts';