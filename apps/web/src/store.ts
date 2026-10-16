/**
 * The client's durable store, and the ONLY module in `apps/web` that touches
 * IndexedDB.
 *
 * `store.ts` exists because of a requirement that is structural rather than
 * stylistic: **`message-lifecycle.md` §8 says "One write path, no exceptions."** A
 * frame carrying your own message is the normal case, not the edge case, so code
 * that treats one as an insert duplicates the message in the transcript — and it
 * is invisible until somebody sends from two tabs.
 *
 * ── how "one write path" is made structural rather than a review comment ─────
 *
 * A code review is a convention. This is not:
 *
 * 1. The `Dexie` database is a **module-private `const`** in this file. It is not
 *    exported, not a class property, and not reachable from a returned object. No
 *    module outside this file can construct one or get a handle on it, so no
 *    module outside this file can write a row.
 * 2. Every write is a **named method**, and exactly one of them —
 *    {@link MessageStore.applyReceived} — writes a row the SERVER authored. The
 *    local optimistic write, the queue's state transitions, the cursor, the
 *    receipts and the discrepancies are all different facts with different names.
 * 3. `store-structure.test.ts` **fails the build** if a second file in `apps/web`
 *    imports the Dexie schema, or if anything outside a test imports the fake
 *    transport. A second write path is a red test, not a review question.
 *
 * What this is NOT: a type error. TypeScript cannot stop a subclass from adding a
 * method, and a nominal handle on a private field would cost ceremony on every
 * call site to buy a guarantee that two greppable tests already enforce. The
 * honest claim is the one above — *structural by module boundary, enforced by a
 * test* — and the boundary is one file deep.
 *
 * ── the tables, and what each one is allowed to know ────────────────────────
 *
 * | table | holds | may it know about delivery or reading? |
 * |---|---|---|
 * | `messages` | one row per Message this browser holds, queued or committed | **no** — ADR 0060 |
 * | `drafts` | one row per conversation, device-local, text only (ADR 0049) | no |
 * | `receipts` | per (conversation, member), the two positions a frame carried | this IS the receipt |
 * | `cursor` | **one row for the whole account** | no |
 * | `discrepancies` | one row per conversation whose counts disagree | no |
 *
 * ── `seq` is a decimal STRING on this side too, and why ─────────────────────
 *
 * The protocol carries a `bigint` as a decimal string because `JSON.parse` of a
 * bare number above 2^53 loses precision with no error. IndexedDB has exactly
 * the same hazard with a JavaScript number as a key, and the column that
 * silently stops ordering is the one this entire subsystem exists for. So `seq`
 * is stored as `Seq` — the branded string — and **every comparison goes through
 * `seqToBigInt`**.
 *
 * ⚠️ **There is an index on `seq` and it must never be used for ORDERING.** An
 * IndexedDB string index sorts lexicographically, so `'9' > '10'`. It is here for
 * `equals()` lookups only, which are exact. `render.ts` sorts in JavaScript with
 * bigints; an ORDER BY that leaned on this index would put the last message in a
 * conversation at the top.
 *
 * ── the send queue is a QUERY, not a table ─────────────────────────────────
 *
 * `message-lifecycle.md` §3: *"the queued row IS the send queue. There is no
 * second table and no promotion step: the send queue is `messages where state =
 * 'queued'`."*
 *
 * The mechanism that makes this true without a second predicate is that
 * **`null` is not a valid IndexedDB key**. A row whose `state` is `null` is not
 * in the `state` index at all, so `where('state').equals('queued')` cannot return
 * a committed message. See {@link MessageRow.state} for why `null` is a value.
 */
import Dexie, { type Table } from 'dexie';
import {
  seq as seqScalar,
  seqToBigInt,
  type Attachment,
  type ConversationId,
  type Message,
  type MessageState,
  type Seq,
  type UserId,
} from '@vartalap/protocol';

// ═══════════════════════════════════════════════════════════════════════════
// ROWS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * One Message this browser holds.
 *
 * `state` is `MessageState | null`, and **`null` means "the server assigned a
 * position"**. That is not a fourth state and it is not a hole in ADR 0060's
 * enum — the enum is the set of things a browser can know *before the server has
 * answered*, and once the server has answered there is nothing left to know
 * locally. `sent` is `seq !== null`; `delivered` and `read` are comparisons made
 * at render time and are **not columns here at all** (ADR 0060, ADR 0003).
 *
 * Making `null` the positioned value is also what lets the send queue be a
 * single-term query: IndexedDB does not index `null`, so a committed message
 * leaves the `state` index the moment its position lands.
 */
export interface MessageRow {
  /** The client's UUIDv7 — identity AND idempotency key (ADR 0004). */
  readonly id: string;
  readonly conversationId: string;
  readonly authorId: string;
  readonly body: string;
  readonly attachments: readonly Attachment[];
  /** The server's position, as a decimal string. `null` exactly once (ADR 0004). */
  readonly seq: Seq | null;
  /** `null` once positioned. See above. */
  readonly state: MessageState | null;
  /** The client's clock, in milliseconds. Display only, and the queue's tiebreak. */
  readonly createdAt: number;
  /** Consecutive failed attempts. Not a message state — a timer. See below. */
  readonly attempts: number;
  /** Epoch millis before which this row must not be sent. `0` means "now". */
  readonly nextAttemptAt: number;
  /** The envelope's `code` when the server definitively refused this row. */
  readonly failureCode: string | null;
  /** The envelope's `message`, or the first field complaint. Display only. */
  readonly failureDetail: string | null;
}

/**
 * A Draft: text a member has composed and not yet sent, belonging to the one
 * browser that received it (ADR 0049). **Text only** — a staged file is not a
 * draft, because a `File` is not text and an object URL dies with the document.
 */
export interface DraftRow {
  readonly conversationId: string;
  readonly text: string;
  readonly savedAt: number;
}

/**
 * A Receipt, as told to this browser: a member's record of how far they have read
 * a conversation. It is a statement about the **member**, never about a message.
 *
 * Both positions are stored because the frame carries both and dropping one on
 * the floor is not this file's decision — but only `sharedThrough` may gate a
 * predicate another member observes, and {@link MessageStore.isReadByOthers} is
 * the only reader of it. `readThrough` has exactly one reader,
 * {@link MessageStore.ownReadThrough}, and it is always the member's own.
 * ADR 0010 and decision-index trap 14.
 */
export interface ReceiptRow {
  readonly conversationId: string;
  readonly userId: string;
  /** The member's OWN private position. Never broadcasts a gap. */
  readonly readThrough: Seq;
  /** Advances only while sharing. What `Seen` is computed over. */
  readonly sharedThrough: Seq;
}

/**
 * One member's delivery watermark, as a `delivery.acked` frame carried it.
 *
 * One position, not two: delivery is the fact that a frame arrived, not a
 * disclosure about the member, so there is nothing to hide and no second clock
 * (ADR 0010). Any single device acknowledging is enough and the frame carries no
 * device identity in v1 (ADR 0004) — "she has it somewhere" is the fact.
 */
export interface DeliveryRow {
  readonly conversationId: string;
  readonly userId: string;
  /** The highest position this member's client has persisted. Monotone. */
  readonly deliveredThrough: Seq;
}

/**
 * The account cursor — **one row for the whole account**.
 *
 * Not one per conversation, and that is the entire payoff of `seq` being a single
 * global column: positions compare across conversations, so reconnect is one
 * query rather than one per conversation (ADR 0005). A per-conversation cursor is
 * the design ADR 0005 replaced and must not come back.
 */
export interface CursorRow {
  readonly id: typeof CURSOR_KEY;
  /** The global position this browser has durably persisted PAST. */
  readonly seq: Seq;
}

/**
 * A conversation whose held count and the server's `COUNT(*)` disagree, and did
 * not agree after one recovery round.
 *
 * It is a row rather than a log line because **the member is the one who has to be
 * able to see it** — a discrepancy nobody can look at is a discrepancy nobody will
 * look at. Stage 6 renders it; until then `console.error` is what a human actually
 * sees, and the row is what a future render reads.
 *
 * `rowsRecovered` is what makes a crying-wolf mismatch distinguishable from the
 * bug: a recovery that added nothing could not reach the gap, so the client is
 * behind by more than its floor, rather than one row short of correct.
 */
export interface DiscrepancyRow {
  readonly conversationId: string;
  /** Positioned rows this browser holds. Queued sends are NOT counted. */
  readonly held: number;
  /** The server's `COUNT(*)` for the conversation. */
  readonly expected: number;
  /** How many rows the recovery round actually added. */
  readonly rowsRecovered: number;
  readonly notedAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE SCHEMA
// ═══════════════════════════════════════════════════════════════════════════

/** The one key a {@link CursorRow} can have. A table of one, on purpose. */
export const CURSOR_KEY = 'account' as const;

/**
 * What a `receipt.advanced` frame carries, in the store's own vocabulary.
 *
 * Deliberately NOT `Pick<Receipt, …>`: the store works in local strings for ids
 * because IndexedDB hands those back, and borrowing the wire type would make every
 * caller re-brand a value that is going into a local key anyway.
 */
export interface ReceiptUpdate {
  readonly conversationId: string;
  readonly userId: string;
  readonly readThrough: Seq;
  readonly sharedThrough: Seq;
}

/**
 * What a `delivery.acked` frame carries, in the store's own vocabulary.
 *
 * Same reason as `ReceiptUpdate` for not borrowing the wire type: local strings
 * for a local key.
 */
export interface DeliveryUpdate {
  readonly conversationId: string;
  readonly userId: string;
  readonly seq: Seq;
}

/** `@vartalap/database` exports inferred row types as `*Row`; so does this file. */
class VartalapDatabase extends Dexie {
  declare messages: Table<MessageRow, string>;
  declare drafts: Table<DraftRow, string>;
  declare receipts: Table<ReceiptRow, [string, string]>;
  declare deliveries: Table<DeliveryRow, [string, string]>;
  declare cursor: Table<CursorRow, string>;
  declare discrepancies: Table<DiscrepancyRow, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      // `&id` — the primary key is the client's UUIDv7, so dedupe is free and an
      // own-echo can only ever collide with the row it is an echo of.
      //
      // `seq` is for `equals()` lookups ONLY; see the header. `state` for the
      // send-queue query. `conversationId` for "this conversation's rows".
      messages: '&id, seq, conversationId, state',
      drafts: '&conversationId',
      receipts: '&[conversationId+userId]',
      deliveries: '&[conversationId+userId]',
      cursor: '&id',
      discrepancies: '&conversationId',
    });
  }
}

/** What {@link MessageStore.applyReceived} did with one row. */
export type ReceiveOutcome =
  /** The row is in the table with the position the server gave it. */
  | { readonly persisted: true }
  | {
      readonly persisted: false;
      /**
       * Why the row was refused. Both are the client's refusal to record
       * something it cannot vouch for — neither is "try again later", and the
       * catch-up loop treats both as a stop.
       */
      readonly reason: 'notServerPositioned' | 'seqClaimedByAnotherMessage';
    };

/** What a local optimistic write needs. Everything else is the store's business. */
export interface LocalSendInput {
  readonly id: string;
  readonly conversationId: string;
  readonly authorId: string;
  readonly body: string;
  readonly attachments: readonly Attachment[];
  /** The client's clock, in millis. The queue's tiebreak among unpositioned rows. */
  readonly createdAt: number;
}

/** The parameters of the read predicate. See ADR 0003 and ADR 0010. */
export interface ReadByOthersInput {
  readonly conversationId: string;
  /** The member asking. Their own sends never satisfy this (message-lifecycle §9). */
  readonly viewerId: string;
  /**
   * The conversation's CURRENT members, already reduced by the caller — former
   * members excluded. Stage 6 has the authoritative membership; the store does
   * not cache a second copy of it.
   */
  readonly currentMemberIds: readonly string[];
  /** The position being asked about. */
  readonly at: Seq;
}

// ═══════════════════════════════════════════════════════════════════════════
// THE STORE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The client data layer's only handle on durable state.
 *
 * Construct one per browser profile. **Two instances over the same database name
 * are two tabs**, which is exactly the situation `message-lifecycle.md` §8's
 * "Tabs" paragraph is about — and the one where a second write path would
 * duplicate a member's own message. Tests use that deliberately.
 */
export class MessageStore {
  /** Private, module-scoped, and the reason there is no second write path. */
  readonly #db: VartalapDatabase;

  constructor(databaseName: string) {
    this.#db = new VartalapDatabase(databaseName);
  }

  /** Opening is explicit so a test can await it and a caller cannot forget. */
  open(): Promise<MessageStore> {
    return this.#db.open().then(() => this);
  }

  close(): void {
    this.#db.close();
  }

  /** Drop everything. For a test fixture and for "sign out and clear local data". */
  async delete(): Promise<void> {
    this.#db.close();
    await Dexie.delete(this.#db.name);
  }

  // ── the ONE receive write path ───────────────────────────────────────────

  /**
   * Write a Message the server authored. **Gate G3.**
   *
   * The same function serves all three sources — a live socket frame, a catch-up
   * page row, and the sender's own message echoing home with the position it was
   * missing — and it does four things, all of them easy to get subtly wrong:
   *
   * 1. **A position is assigned if and only if it is currently `null`.** A
   *    received frame never overwrites a position that is already set. Not
   *    "never overwrites with an older one" — never. `seq` is the server's
   *    primary key; two values for one row is not a state the model has.
   * 2. **It upserts on the client id**, so a frame for a message this browser
   *    already holds **optimistically updates that row** rather than inserting a
   *    second one. This is the bug that rots: a frame carrying your own message
   *    is the normal case.
   * 3. **An update is never an insert.** The branch is explicit below; there is
   *    no `put` anywhere on this path.
   * 4. **Only `seq` and `state` are ever written onto an existing row.** An
   *    update does not rewrite content: editing is out of v1 and nothing that
   *    arrives over the wire may change what somebody wrote.
   *
   * **Nothing here replaces a conversation wholesale.** There is no path that
   * overwrites a transcript, and adding one would mean adding a method to this
   * class — which `store-structure.test.ts` makes a failing test.
   *
   * A refusal is deliberately NOT an exception. The catch-up loop needs to know
   * *which* row it refused so it can stop the cursor before it, and a throw
   * cannot say that.
   */
  async applyReceived(message: Message): Promise<ReceiveOutcome> {
    // A server row is never unpositioned. `message.created`, every catch-up page
    // row and every send response all carry the position, and a frame that does
    // not is not something this client can vouch for — storing it would put an
    // unpositioned row into a loop that thinks it has passed one.
    //
    // Hoisted to a `const` because the narrowing below has to survive a closure and
    // an `await`: TypeScript resets a property's narrowing inside a callback, and a
    // `Seq | null` where a `Seq` belongs is a `strictNullChecks` error that is
    // honest about what it thinks the code can do.
    const position = message.seq;
    if (position === null) return { persisted: false, reason: 'notServerPositioned' };

    return this.#db.transaction('rw', this.#db.messages, async () => {
      const existing = await this.#db.messages.get(String(message.id));

      if (existing !== undefined) {
        // A position that is already set is never overwritten. The row is
        // durable; a second frame carrying the same row says nothing new.
        if (existing.seq !== null) return { persisted: true };
        if (await this.#seqHeldByAnother(message, position)) {
          return { persisted: false, reason: 'seqClaimedByAnotherMessage' };
        }
        // An UPDATE. Two fields, both of which say the same thing: the server
        // answered. `state` becomes `null`, which removes the row from the send
        // queue's index and is the whole of "this row is no longer queued".
        await this.#db.messages.update(String(message.id), { seq: position, state: null });
        return { persisted: true };
      }

      // The INSERT branch, and it is only ever reached for a message this
      // browser has never held. Everything on the row comes from the frame.
      if (await this.#seqHeldByAnother(message, position)) {
        return { persisted: false, reason: 'seqClaimedByAnotherMessage' };
      }
      await this.#db.messages.add(rowFromWire(message));
      return { persisted: true };
    });
  }

  /**
   * Does some OTHER message already hold this position?
   *
   * `seq` is the server's PRIMARY KEY, so two client ids claiming one position
   * means the transport or the server is wrong. The client's correct answer is to
   * refuse the row and leave the gap **visible** — which is what lets the
   * `COUNT(*)` net find it — rather than write a second row and let two messages
   * share an ordering. A belt, and it is the one that makes "the cursor advances
   * only past rows that persisted" mean something.
   *
   * `equals()` on a string index is an exact lookup. This is the ONLY reason the
   * `seq` index exists; see the header.
   */
  async #seqHeldByAnother(message: Message, position: Seq): Promise<boolean> {
    const holders = await this.#db.messages.where('seq').equals(position).toArray();
    return holders.some((row) => row.id !== String(message.id));
  }

  // ── the local, optimistic write ──────────────────────────────────────────

  /**
   * Steps 3 and 4 of `composer-and-sending.md`'s table, in ONE transaction: the
   * row is written with `seq: null` and `state: 'queued'`, and the draft is
   * cleared — before any network call exists.
   *
   * **`add`, not `put`.** The id was just minted, so a collision means the
   * generator is broken; `put` would silently overwrite a message this browser
   * has been showing for minutes. `add` throws instead, which is the right answer
   * to a duplicate identity.
   *
   * The draft clears HERE rather than when the send succeeds: a send can fail, and
   * a member who watched their text vanish into a bubble marked `Not sent` is a
   * loss they will not forgive (ADR 0049). The text is now owned by the queue row,
   * which carries an idempotency key and survives a reload.
   *
   * Nothing between these two writes may await anything that is not IndexedDB —
   * anything else is a thing the member waits for, and their perception of the
   * composer is that pressing send does nothing to the interface.
   */
  async applyLocalSend(input: LocalSendInput): Promise<void> {
    await this.#db.transaction('rw', this.#db.messages, this.#db.drafts, async () => {
      await this.#db.messages.add({
        id: input.id,
        conversationId: input.conversationId,
        authorId: input.authorId,
        body: input.body,
        attachments: [...input.attachments],
        // The two fields that make this a queued send, and the two that are not
        // stored: `sent` is `seq !== null` and `delivered`/`read` are watermarks
        // nobody may put on a row (ADR 0060).
        seq: null,
        state: 'queued',
        createdAt: input.createdAt,
        attempts: 0,
        nextAttemptAt: 0,
        failureCode: null,
        failureDetail: null,
      });
      await this.#db.drafts.delete(input.conversationId);
    });
  }

  // ── the queue's state transitions, which are NOT a receive path ──────────

  /** Open the `POST` for this row. The state the composer calls "in flight". */
  async markInFlight(id: string): Promise<void> {
    await this.#db.messages.update(id, { state: 'inFlight' });
  }

  /**
   * Back to `queued`, with the next attempt scheduled.
   *
   * `attempts` and `nextAttemptAt` are on the row for the same reason
   * `outbox.attempts` and `outbox.last_error` exist on the server (stage 3.B):
   * without them "failed twice" and "never attempted" are the same value and the
   * backoff ladder has nowhere to live. They are **timer bookkeeping, not a
   * message state** — ADR 0060's enum has three members and this adds none.
   */
  async releaseToQueued(id: string, nextAttemptAt: number): Promise<void> {
    await this.#db.messages.update(id, {
      state: 'queued',
      attempts: (await this.attemptsOf(id)) + 1,
      nextAttemptAt,
    });
  }

  /**
   * Reset the ladder. The server answered with a `Retry-After`, which is a signal
   * about a policy rather than about a network that is struggling — so the next
   * backoff starts from one second again. `nextAttemptAt` is deliberately NOT
   * touched: the row still has to wait for the server's answer, not for a fresh
   * schedule.
   */
  async resetAttempts(id: string): Promise<void> {
    await this.#db.messages.update(id, { attempts: 0 });
  }

  /**
   * A definitive refusal. Terminal, and the row stays visible — a message someone
   * pressed send on is never discarded by the system (message-lifecycle.md).
   */
  async markFailed(id: string, code: string, detail: string | null): Promise<void> {
    await this.#db.messages.update(id, { state: 'failed', failureCode: code, failureDetail: detail });
  }

  /**
   * Discard a queued send. The system never calls this — {@link markFailed} is
   * what a refusal does, and a row is never taken off the screen by anyone but
   * the member who typed it (ADR 0053).
   *
   * **Refuses to discard a positioned message.** A `seq` is the server's
   * primary key and the conversation's ordering; deleting a row that holds one
   * would leave the cursor and the watermarks pointing at a position nobody
   * occupies. Only `seq === null` — a send this browser has not had answered —
   * can be discarded, and the answer says which happened.
   */
  async discardSend(id: string): Promise<'discarded' | 'notDiscarded'> {
    return this.#db.transaction('rw', this.#db.messages, async () => {
      const row = await this.#db.messages.get(id);
      if (row === undefined || row.seq !== null) return 'notDiscarded';
      await this.#db.messages.delete(id);
      return 'discarded';
    });
  }
  /**
   * Put every open row back into the queue.
   *
   * A reload kills every `POST` this browser had open, and a row left in
   * `inFlight` would sit in the queue forever looking like a request that is
   * still running. The retry reuses the same idempotency key, so a send that DID
   * land comes back as `deduplicated` with its position — which is what
   * `message-lifecycle.md` §6's middle row is for.
   *
   * A second tab doing this while the first tab's `POST` is genuinely open is the
   * same situation, and the idempotency key is the answer to that too.
   */
  async reclaimInFlight(): Promise<number> {
    return this.#db.transaction('rw', this.#db.messages, async () => {
      const open = await this.#db.messages.where('state').equals('inFlight').toArray();
      for (const row of open) {
        await this.#db.messages.update(row.id, { state: 'queued', nextAttemptAt: 0 });
      }
      return open.length;
    });
  }

  async attemptsOf(id: string): Promise<number> {
    const row = await this.#db.messages.get(id);
    return row?.attempts ?? 0;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * **The send queue.** One query over one table, and it returns rows whose state
   * is `queued` and nothing else — a committed message carries `state: null`, and
   * IndexedDB does not index `null`, so it is not in this index at all.
   *
   * `send.ts` filters by `nextAttemptAt` before it opens a request; that is a
   * schedule, not a membership question, so it stays out of the query.
   */
  async queuedSends(): Promise<MessageRow[]> {
    return this.#db.messages.where('state').equals('queued').toArray();
  }

  async rowsFor(conversationId: string): Promise<MessageRow[]> {
    return this.#db.messages.where('conversationId').equals(conversationId).toArray();
  }

  async messageById(id: string): Promise<MessageRow | undefined> {
    return this.#db.messages.get(id);
  }

  async positionedCount(conversationId: string): Promise<number> {
    const rows = await this.rowsFor(conversationId);
    // **Unpositioned rows do not count.** A queued send is not on the server yet,
    // and counting it would make every send that is currently in flight look like
    // a discrepancy. `COUNT(*)` counts committed messages and nothing else.
    return rows.reduce((held, row) => (row.seq === null ? held : held + 1), 0);
  }

  /** The lowest position this browser holds for a conversation, or null. */
  async lowestPosition(conversationId: string): Promise<Seq | null> {
    const positions = (await this.rowsFor(conversationId))
      .map((row) => row.seq)
      .filter((position): position is Seq => position !== null)
      .sort(compareSeq);
    return positions[0] ?? null;
  }

  /**
   * Every conversation this browser holds a positioned message in — which is the
   * set `COUNT(*)` reconciliation can say anything about.
   *
   * **The boundary is real and it is named here:** a conversation this browser
   * has never received a message from cannot be reconciled, because there is
   * nothing to count. What makes that safe rather than merely narrow is that a
   * brand-new browser's cursor is `0`, so its catch-up delivers every message the
   * member can see, and the set is complete by the time anything is reconciled.
   */
  async conversationsWithPositionedRows(): Promise<string[]> {
    const rows = await this.#db.messages.filter((row) => row.seq !== null).toArray();
    return [...new Set(rows.map((row) => row.conversationId))];
  }

  /**
   * The highest position this browser has persisted for a conversation, or null.
   *
   * That is exactly what a delivery acknowledgement reports — "a frame arrived at
   * this member's client and was persisted" — so this is the local delivery
   * watermark, and it is derived rather than stored, which is a second thing this
   * database refuses to hold. **Any ONE device acknowledging is enough**; per-
   * device delivery is unfixable by construction (ADR 0004).
   *
   * It is this browser's own. The server does not broadcast delivery advances, so
   * a SENDER's view of whether a recipient has a message is a server-authoritative
   * read and not this unit's business; `render.ts` takes that watermark as a
   * reduced parameter, per ADR 0060.
   */
  async heldThrough(conversationId: string): Promise<Seq | null> {
    const positions = (await this.rowsFor(conversationId))
      .map((row) => row.seq)
      .filter((position): position is Seq => position !== null)
      .sort(compareSeq);
    return positions[positions.length - 1] ?? null;
  }

  // ── drafts ───────────────────────────────────────────────────────────────

  async draftFor(conversationId: string): Promise<DraftRow | undefined> {
    return this.#db.drafts.get(conversationId);
  }

  async setDraft(conversationId: string, text: string, savedAt: number): Promise<void> {
    await this.#db.drafts.put({ conversationId, text, savedAt });
  }

  // ── the account cursor ───────────────────────────────────────────────────

  /**
   * Where this browser has durably persisted to.
   *
   * **A missing cursor is `'0'`**, and `0` means "everything from the beginning".
   * `seq` comes from a sequence at its default `START WITH 1`, so no real message
   * sits at `0` (ADR 0045) and a brand-new browser asking for everything is a
   * request, not a bug. What makes it *safe* rather than merely expensive is the
   * per-conversation `COUNT(*)` reconciliation that follows — see `catch-up.ts`.
   */
  async cursor(): Promise<Seq> {
    const row = await this.#db.cursor.get(CURSOR_KEY);
    return row?.seq ?? seqScalar.parse('0');
  }

  /**
   * Move the cursor forward. **Never backward.**
   *
   * The caller decides *which* rows may be passed; this decides that a cursor is
   * monotone, which is a property of the value and not of any caller. Two tabs in
   * one browser profile share one Dexie, and a slower tab must not be able to
   * pull the cursor back under the faster one.
   */
  async moveCursorTo(position: Seq): Promise<Seq> {
    return this.#db.transaction('rw', this.#db.cursor, async () => {
      const row = await this.#db.cursor.get(CURSOR_KEY);
      if (row !== undefined && compareSeq(row.seq, position) >= 0) return row.seq;
      await this.#db.cursor.put({ id: CURSOR_KEY, seq: position });
      return position;
    });
  }

  // ── receipts ─────────────────────────────────────────────────────────────

  /**
   * Record a `receipt.advanced` frame. **Monotone, on both positions**, and the
   * same `GREATEST` the server applies — because out-of-order arrival, two tabs
   * racing, and a send queue flushing after a reload are all real, and a local
   * copy that regressed would render a `Seen` that goes backwards.
   *
   * ⚠️ The frame carries two positions and this function does not care which one
   * is bigger than the other. `read_through >= shared_through` is an invariant of
   * how a row is written, on the server (ADR 0004), and the client's copy is not
   * a place to enforce it — a client that "corrected" one position using the
   * other would be guessing, and guessing here is how the hidden gap gets
   * broadcast.
   */
  async applyReceipt(frame: ReceiptUpdate): Promise<void> {
    const key: [string, string] = [String(frame.conversationId), String(frame.userId)];
    await this.#db.transaction('rw', this.#db.receipts, async () => {
      const existing = await this.#db.receipts.get(key);
      await this.#db.receipts.put({
        conversationId: key[0],
        userId: key[1],
        readThrough:
          existing === undefined || compareSeq(frame.readThrough, existing.readThrough) > 0
            ? frame.readThrough
            : existing.readThrough,
        sharedThrough:
          existing === undefined || compareSeq(frame.sharedThrough, existing.sharedThrough) > 0
            ? frame.sharedThrough
            : existing.sharedThrough,
      });
    });
  }

  async receiptFor(conversationId: string, userId: string): Promise<ReceiptRow | undefined> {
    return this.#db.receipts.get([conversationId, userId]);
  }

  /**
   * The member's OWN reading position, for their own unread count.
   *
   * **This is the only reader of `readThrough` in the whole codebase, and its only
   * argument is the member who owns it.** `read_through` keeps advancing while
   * sharing is off — it has to, or the unread badge breaks — so it is always ahead
   * of where the member left off, and anything another member can see must never
   * read it. `isReadByOthers` below is the proof that it does not.
   */
  async ownReadThrough(conversationId: string, viewerId: string): Promise<Seq | null> {
    return (await this.receiptFor(conversationId, viewerId))?.readThrough ?? null;
  }

  /**
   * Has every other CURRENT member read to at least `at`?
   *
   * **Computed over `sharedThrough`, and never over `readThrough`.** That is
   * decision-index trap 14 and ADR 0010, and it is not a style rule:
   * `read_through` runs ahead while sharing is off, so a predicate built on it
   * broadcasts the entire gap the member spent hiding — the exact failure the
   * second stored position exists to prevent. The interface prints `Seen`; nothing
   * in here says the word.
   *
   * **`sharing` is not consulted and could not be.** The `receipt.advanced` frame
   * does not carry it — `receiptSharingResponse` is a separate write on its own
   * transport (ADR 0022) — and it does not need to: `shared_through` only advances
   * while sharing is on, so a member who is not sharing is a frozen watermark, and
   * the frozen value IS the answer. `shared_through` is the mechanism; `sharing` is
   * a signal about a permission (ADR 0058).
   *
   * **`>=`, and a member's own sends never satisfy it**: `viewerId` is excluded
   * below, which is why a member never sees `Seen` on their own message even
   * though their receipt sits at the end of the transcript.
   *
   * **An empty membership answers `false`.** A conversation whose members this
   * caller has not reduced cannot have "every member read it" established, and the
   * safe direction is to show nothing rather than to read vacuously true.
   */
  async isReadByOthers(input: ReadByOthersInput): Promise<boolean> {
    const at = seqToBigInt(input.at);
    let others = 0;
    for (const memberId of input.currentMemberIds) {
      if (memberId === input.viewerId) continue;
      others += 1;
      const receipt = await this.receiptFor(input.conversationId, memberId);
      if (receipt === undefined || seqToBigInt(receipt.sharedThrough) < at) return false;
    }
    // **No other member, no answer.** "Every member has read it" is vacuously true
    // over an empty set, and an empty set here means the caller has not reduced the
    // membership yet — not that nobody read anything. Failing open would print
    // `Seen` under a message nobody has seen, and failing closed costs one missing
    // indicator for a conversation the client does not yet understand.
    return others > 0;
  }

  // ── deliveries ───────────────────────────────────────────────────────────

  /**
   * Record a `delivery.acked` frame. **Monotone**, and the same reason as the
   * receipt path: out-of-order arrival and two tabs racing are real, and a local
   * copy that regressed would render a `Sent` that goes backwards.
   *
   * One position and no branch — the server's `GREATEST` on the single column,
   * repeated here, because the client's copy answers the same question the
   * server's does ("has she got it somewhere?") and must give the same answer.
   */
  async applyDelivery(frame: DeliveryUpdate): Promise<void> {
    const key: [string, string] = [String(frame.conversationId), String(frame.userId)];
    await this.#db.transaction('rw', this.#db.deliveries, async () => {
      const existing = await this.#db.deliveries.get(key);
      await this.#db.deliveries.put({
        conversationId: key[0],
        userId: key[1],
        deliveredThrough:
          existing === undefined || compareSeq(frame.seq, existing.deliveredThrough) > 0
            ? frame.seq
            : existing.deliveredThrough,
      });
    });
  }

  async deliveryFor(conversationId: string, userId: string): Promise<DeliveryRow | undefined> {
    return this.#db.deliveries.get([conversationId, userId]);
  }

  // ── discrepancies ────────────────────────────────────────────────────────

  async noteDiscrepancy(row: DiscrepancyRow): Promise<void> {
    await this.#db.discrepancies.put(row);
  }

  async discrepancies(): Promise<DiscrepancyRow[]> {
    return this.#db.discrepancies.toArray();
  }

  /** Cleared the moment a reconcile agrees — so a fixed gap stops shouting. */
  async clearDiscrepancy(conversationId: string): Promise<void> {
    await this.#db.discrepancies.delete(conversationId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPARISONS AND CONVERSIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Positions compare as bigints, never as strings and never as numbers.
 *
 * `'9' < '10'` is false as a string comparison and `2^53 < 2^53 + 1` is false as a
 * number comparison. Both of those are real positions in this system, and both of
 * those bugs are silent.
 */
export function compareSeq(left: Seq, right: Seq): number {
  const a = seqToBigInt(left);
  const b = seqToBigInt(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

/** At or past. The comparison every watermark predicate uses (`>=`, ADR 0010). */
export function seqAtOrPast(watermark: Seq, at: Seq): boolean {
  return compareSeq(watermark, at) >= 0;
}

/**
 * A server row → a stored row.
 *
 * `state: null` is the whole of "this is positioned", and `createdAt` is the
 * wire's `createdAt` — which is the AUTHORING device's clock, echoed back, so the
 * optimistic row and the frame agree on it. Display only either way (ADR 0005).
 */
function rowFromWire(message: Message): MessageRow {
  return {
    id: String(message.id),
    conversationId: String(message.conversationId),
    authorId: String(message.authorId),
    body: message.body,
    attachments: [...message.attachments],
    seq: message.seq,
    state: null,
    createdAt: Date.parse(message.createdAt),
    attempts: 0,
    nextAttemptAt: 0,
    failureCode: null,
    failureDetail: null,
  };
}

/** Open a store. The name is a parameter so a test never shares a database. */
export function createStore(databaseName: string): MessageStore {
  return new MessageStore(databaseName);
}

export type { ConversationId, Message, MessageState, Seq, UserId };