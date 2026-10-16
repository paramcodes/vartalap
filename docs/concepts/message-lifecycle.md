# The message lifecycle

One message, from the keystroke that sends it to the receipt that says it was read. Every other
subsystem in vartalap is either on this path or hangs off it, so this document is the spine: the
ordering and pagination decisions, the presence and typing semantics, the push trigger, and the
chat view all inherit their constraints from what follows.

Three paths run through it — **sending**, **receiving**, and **reconnecting** — plus one thing that
is deliberately kept out of all three.

Vocabulary is load-bearing here and is defined in [`GLOSSARY.md`](../../GLOSSARY.md). The words
that matter most: a **Message** is authored content and nothing else; a **Receipt** is a member's
record of how far they have read, and is never a property of a message; a **Queued send** is a
message the server has not yet acknowledged; and the **send queue** is the member's browser's
durable store of those, which survives a reload. The interface prints the word "Seen" because
Messenger's does, but no part of the model may.

---

## The states a message passes through — and which of them are on the row

A reader who remembers nothing else should remember this table.

**Three states are stored**, because they are exactly the ones a browser can know with no network at
all:

| stored state | what it asserts | who knows it |
|---|---|---|
| **queued** | composed and stored locally; no server has seen it | only this browser |
| **inFlight** | a `POST` for it is open right now | only this browser |
| **failed** | the server definitively refused it | only this browser |

**The other three are derived when the row is drawn, and none of them is ever written to anything:**

| derived | what it asserts | who knows it |
|---|---|---|
| **sent** | committed to Postgres with its outbox row | the server |
| **delivered** | a member's client received the frame and persisted it | the server, via that member's device |
| **read** | a member's receipt advanced past it | every member |

`sent` is not a promise that a person received anything. It is the guarantee that the message is
**durable** — that it exists, and that delivery to its members will happen eventually whether or not
any device is currently online. That distinction is the entire difference between a messaging system that
generates support tickets and one that doesn't. **It has a test that costs nothing: `seq !== null`.**
Storing it beside the position would store a fact the same row already carries more reliably.

`delivered` and `read` are **comparisons against per-member watermarks**, made at render time. Neither
is a column on a message row and neither may become one: a Receipt is a member's record and never a
property of a message, so writing either onto a row would be the second source of truth
[`GLOSSARY.md`](../../GLOSSARY.md) bans.

`delivered` is per **member**, not per device. If Priya has a laptop and a phone and only the phone
is awake, the message counts as delivered to Priya. "She has it somewhere" is the fact a sender
actually wants, and per-device delivery would need device identity and per-device acknowledgements
to answer a question nobody asks.

> **Decided by [0060](../adr/0060-stored-state-is-narrow-and-derived-state-is-wide.md), which is newer
> than the rest of this document.** This used to present all four as states a message passes through.
> That is the vocabulary 0060 removed: two of them were never stored, one is a derivation from the
> position, and `pending` is on the glossary's avoid list. **The protocol word is `queued`.**

---

## 1. Compose

The member presses send. One client-generated **UUIDv7** is minted, and it is the single value that
identifies the message everywhere: the `message.id` column, the idempotency key on the request, the
outbox row in the browser's send queue, and every frame that later mentions it.

That is deliberate — **Message** and **Idempotency key** are separate nouns because a *retry* is a
different act from a *message*, but there is no reason to mint two UUIDs to say the same thing. The
server trusts this value for identity and for nothing else. It is unguessable, unenumerable, and
carries no authority; a client can choose it freely and the server cannot be lied to by it.

The UUIDv7 sorts, which gives a friendly index layout and a stable tiebreak for rendering a queue
that has not been assigned positions yet. **It is never used for order.** A UUIDv7's timestamp is
the *client's* clock, and clients skew. RFC 9562 offers same-millisecond monotonicity only as an
optional counter, and even implementing it is scoped to a single node — distributed generators get no
ordering guarantee at all. Ordering comes from step 5.

## 2. The optimistic local write

The message is written to Dexie immediately with `position: null` and `state: 'queued'`, before any
network call. This is why the interface never waits on the network: the row exists synchronously,
and the member sees their own message instantly.

**`position` is `null` and stays `null` until the server assigns one.** The client may not
interpolate a provisional position from client time. A message that renders in one place and then
visibly moves when its real position arrives reads as a bug even when it is behaving correctly, so
unsent messages simply sort after everything that has been positioned, ordered among themselves by
client creation time.

The moment the server speaks, the position is set and the message snaps into place.

## 3. Enqueue — the send queue is a query, not a table

The queued row *is* the send queue. There is no second table and no promotion step: **the send
queue is `messages where state = 'queued'`**, scoped to one browser profile.

(`inFlight` is the same machinery holding a row while its `POST` is open. **0060** is what renamed
`pending` to `queued` — `pending` is on the glossary's avoid list, and the domain word is a **queued
send**.)

This matters more than it looks. A separate `sendQueue` table would need rows to be moved across
when a send succeeds, and a moving part is a part that can be interrupted. More importantly it could
drift out of step with the transcript, because two stores holding the same fact is two sources of
truth. Dexie transactions make such a move atomic anyway, so the argument for one table is clarity
rather than safety — and clarity is the whole point of naming it once.

It is in Dexie rather than memory because a browser tab can be closed at any moment. Socket.IO's own
documentation is explicit that buffered events are lost on a tab refresh, and that **the server has
no buffer at all** — anything missed by a disconnected client is simply never sent to it.

## 4. Send — `POST`, not a socket write

Sending is an HTTP `POST`, not a frame on the socket.

A socket write has no defined failure. If the connection drops mid-emit, the client cannot tell
whether the message landed, and every subsequent retry is a coin flip. An HTTP request gives one
request, one response, one status code, and a retry story — and the idempotency key in step 6 is
only usable because of it.

The frames still ride the socket: message creation, delivery acknowledgement, receipt advancement,
presence, and typing. Sending is the odd one out, and that asymmetry is the point.

Every frame also carries its conversation identifier, even though Centrifugo channels are already
per-conversation. That redundancy looks wasteful and is the cheapest insurance in the system:
`packages/protocol` is shared with a native client that may not have the same channel model, and a
frame that doesn't say which conversation it belongs to is a bug that can only ever appear on a
platform nobody has built yet.

## 5. Persist before acknowledge

The message row and its **outbox** row are committed to Postgres **in one transaction, before the
server responds**. Live fan-out happens after that commit and is a latency optimisation on top of a
durable record — it is never the system of record.

This is the single most important line in the design, and it is recorded as a decision in
[`docs/adr/0004`](../adr/0004-message-durability.md).

The cost is real and worth naming: **a committed message is a message that exists**, even if every
relay and every device is offline for the next hour. It is durable before it is anywhere.

Within that same transaction the message is assigned its **position** — a server-assigned `bigint`
sequence number, `message.seq`, that every ordering decision depends on. Positions are opaque to
clients: a client can never set, influence, or predict one.

> The position is a **single global column**, not a per-conversation sequence. This document originally
> said otherwise; [Message ordering and pagination](./message-ordering.md) corrected it, because
> per-conversation positions leave no global cursor and turn reconnect into a query per conversation.

## 6. Dedupe

The primary key is the client's UUID, so a retry cannot create a second message. But "cannot create
a duplicate" is only half the requirement, because the interesting failure is a buggy client reusing
one key for two different messages.

The server compares the incoming content against the stored original and answers one of three ways:

| situation | response |
|---|---|
| new message | `200` with the canonical row, including its assigned position |
| same key, same content | `200` with the **original** row, including its position |
| same key, different content | `409`, naming the conflict |

The middle row is the ordinary case: a retry after a timeout, where the first request probably
succeeded. Returning the original *with its position* means the client reconciles from its own retry
response instead of waiting for an echo of itself to come back over the socket.

The third row is borrowed from Stripe, which compares incoming parameters against the original and
errors when they differ. The comparison is the point: **409 is our choice, not Stripe's documented
precedent.** Stripe's documentation specifies the error *type* (`idempotency_error`) but says
nothing about the status code, and the sources for it conflict.

One behaviour is worth copying verbatim: Stripe does **not** consume an idempotency key for failures
that happen before execution begins. A `429`, or a `400` that fails validation, leaves the key unused,
so a retry is a fresh attempt rather than a duplicate check. A rate-limited send must not burn the
message's identity — and note that this is a statement about the **key**, not about whether the retry
is worth making. Those are independent facts; see [When a send fails](#when-a-send-fails).

## 7. Fan out

The outbox row written in step 5 is what a relay reads. Nothing is broadcast directly from request
handling.

Any other arrangement — commit, then make a network call to the broker — has a failure mode with no
recovery: the message exists, the transaction succeeded, and the broadcast failed, and now nobody
ever hears about it. The outbox removes that class of bug by making "committed" and "will be
delivered" the same atomic fact.

## 8. Receive

One write path, no exceptions. The same function writes a message whether it arrived live over the
socket, came back from catch-up pagination, or is the sender's own message echoing home with the
position it was missing.

That function does three things, and they are all things that are easy to get subtly wrong:

- assigns `position` **if and only if it is currently `null`** — a received frame never overwrites a
  position that is already set;
- upserts on the client id, so an incoming frame for a message this browser already holds
  **optimistically** updates that row rather than inserting a second one;
- never treats an update as an insert.

The second is the bug that rots. A frame carrying your own message is the normal case, not the edge
case — so code that treats it as an insert duplicates the message in the transcript. And it is
invisible until someone sends from two tabs.

**Nothing ever replaces a conversation wholesale.** There is no path that overwrites a transcript.

### Tabs

Two tabs in one browser profile share one Dexie, so the send queue is one queue, not two. A
successful send in tab A updates tab B's row through Dexie's `liveQuery`, with no coordination code
at all — because there is exactly one source of truth.

The consequence is a rendering rule rather than a networking one: **the interface must render from
the table, not from local component state.** A tab holding a copy in memory will show a ghost
message whose position has already moved.

## 9. Deliver and read

**Delivered.** A member's client acknowledges the frame after persisting it. The server advances
that member's `delivered_through` — a watermark, monotonic, one row per (conversation, member),
exactly the shape of a receipt and maintained in exactly the same way.

It lives in its own `delivery` table rather than as another column on `receipt`, because
[`GLOSSARY.md`](../../GLOSSARY.md) defines a **Receipt** as a record of how far someone has *read*.
Adding delivery to that table would quietly overload a definition, and the two facts are genuinely
different: delivery is receiving a frame, reading is opening a conversation.

Any single device acknowledging is enough. The acknowledgement carries no device identity in v1.

**Read.** A member's receipt advances to the end of the transcript the moment the conversation is
opened — not per-message viewport tracking, and not per message scrolled past. That matches
Messenger and WhatsApp, and it is stricter about nothing: showing a conversation reads all of it.

The interface renders a single **Seen** marker under the last outgoing message, and never under an
incoming one. Nothing in the schema says "under the last outgoing"; it falls out. A member's own
sends never advance their own receipt, so their watermark can never satisfy the condition for their
own message.

**Neither of those is a column on a message row.** `delivered` and `read` are what the interface
*draws*, derived at render time by comparing this message's `seq` against a member's watermark. The
watermarks advance as described above and are stored as themselves; the state is not stored, because a
Receipt is a member's record and never a property of a message
([0060](../adr/0060-stored-state-is-narrow-and-derived-state-is-wide.md),
[`GLOSSARY.md`](../../GLOSSARY.md)).

See [`docs/adr/0003`](../adr/0003-receipt-watermark.md) for why receipts are a bookmark rather than
a diary, and [Read receipt mechanics](https://github.com/paramcodes/vartalap/issues/19) for the
storage details — row shape, monotonicity enforcement, throttling, and what happens when sharing is
switched back on.

## 10. Reconnect

The client stores a cursor in Dexie, so it survives a reload. Because `seq` is a single global
column, there **is** a total order across conversations and therefore one cursor for the whole
account: reconnecting is a single catch-up query for everything positioned after it.

The loop runs until the server returns a short page — fewer rows than the page size — which is how
the client knows it has caught up.

The cursor advances **only past messages that were actually persisted.** A frame that fails to write
must not move it, or the gap becomes silent and permanent.

After catch-up, the client compares its message count for each conversation against the server's.
A permanently skipped row is invisible otherwise.

> This document originally described reconnect as one query *per conversation*, on the grounds that
> per-conversation positions leave no global cursor. [Message ordering and pagination](./message-ordering.md)
> settled on a single global `seq` instead, which removes the limitation entirely.

## When a send fails

The queued row has to do something sensible for each failure, and the failures mean different
things.

| outcome | meaning | what happens to the row |
|---|---|---|
| `2xx` | accepted, position assigned | becomes `sent` |
| network error, timeout, `5xx` | indistinguishable from "accepted, response lost" | back off and retry; the idempotency key collapses it |
| `408`, `425`, `429` | the server answered and refused on policy | back off and retry, honouring `Retry-After`; the key is unconsumed, so the retry is a fresh attempt |
| `401` | not authenticated; the message is fine | back off and retry — re-authentication re-flushes the queue |
| `409` | key reused with different content — a **client bug** | terminal. `Not sent`; retrying cannot help |
| `400`, `413`, `422` | rejected, and the same bytes will be rejected identically | terminal. `Not sent`, and the strip names the reason |

> **Amended by [the composer](./composer-and-sending.md#failure-and-the-one-number-that-is-never-shown).**
> This table previously read `429` and pre-execution `4xx` together as *"never executed; key not
> consumed → stays pending, retries with backoff"*, on Stripe's rule in step 6. **"The key was not
> consumed" and "the request can never succeed" are independent facts**, and Stripe's rule is only
> about the first. A validation rejection is rejected identically on every retry, forever; retrying it
> burns a queue slot to arrive at the same answer. The test is: *could retrying these identical bytes
> plausibly produce a different status?* If not, it is terminal.

**A message someone pressed send on is never discarded by the system.** Retryable failures back off
and leave the row in the send queue. A `409` moves it to a visible failed state with an affordance
to retry or discard it — but discarding is the member's decision, made by them, on a message they
can still see. A client that quietly deletes what somebody typed and believed they sent is the worst
outcome available, and the cost of avoiding it is a small policy for cleaning up dead rows.

---

## What never enters the durable path

**Presence** and **typing** are never persisted. Not as an optimisation, not as a fallback, not
"just the last one".

Three reasons, and the reasons are what stop someone adding a table in six months:

1. **High frequency.** Presence is continuous. Persisting it means a write per member per heartbeat,
   forever, for a fact that expires in seconds.
2. **Low value — and the expiry is the point.** The stored value is wrong the instant it is written.
   A durable presence is not a slower live signal, it is a *wrong* one with extra steps.
3. **They belong on the socket precisely because they can be dropped.** [`GLOSSARY.md`](../../GLOSSARY.md)
   already says a member who never saw a typing indicator missed nothing.

The trap is the moment someone adds a `last_seen_at` column for a settings screen. At that point the
hard part — presence that means *connected now*, with no history behind it — becomes unfixable
without a migration, because history is exactly what the schema refused to keep.

Presence and typing semantics are specified in
[Presence and typing semantics](https://github.com/paramcodes/vartalap/issues/8). This document owns
only the constraint.

---

## Where this path stops

**Media is a different path.** An image message is upload-then-send: the bytes are stored first, and
the message that references them is sent second, with its own failure modes when the upload is still
in flight or has half-failed. The trust boundary on accepting those bytes belongs to
[Media pipeline and the upload trust boundary](https://github.com/paramcodes/vartalap/issues/12).
This document says where the seam is and does not cross it.

**Editing, deleting, replies, reactions, forwarding, and pinning are out of v1.** They are all
mutations of this flow rather than new flows, and none of them may change the durable spine: an edit
rewrites a message's body in place and never its position or its identity.

**Ordering and pagination are decided elsewhere.** This document establishes that a server-assigned,
position exists and that the client cannot influence it. What that position is, how it paginates, and
how the commit-inversion race is handled — is
[Message ordering and pagination](https://github.com/paramcodes/vartalap/issues/7).

---

## The durability spine

Four decisions carry the weight, and are recorded together in
[`docs/adr/0004`](../adr/0004-message-durability.md):

- persist before acknowledge, in the same transaction as the outbox row
- the client's UUID is simultaneously the message identity and the idempotency key
- `POST` for sending, the socket for everything else
- receipts and delivery are watermarks — monotonic, one row per (conversation, member), never rows
  per message

The rest of this document is downstream of those four.