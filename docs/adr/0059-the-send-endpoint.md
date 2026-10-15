# 0059. The send endpoint: its path, its three answers, and its error envelope

**Status:** Accepted
**Date:** 2026-10-15
**Resolves:** stage 3.B — "the send endpoint's shape", one of the four decisions `docs/plans/stage-3.md` leaves to this stage
**Depends on:** [0004](0004-message-durability.md) (POST, one value two jobs, the three dedupe answers), [0005](0005-message-ordering.md) (the global `seq` a response carries), [0007](0007-conversation-model.md) (why a send can be refused)
**Teaches:** [`docs/concepts/message-lifecycle.md`](../concepts/message-lifecycle.md) §4 and §6, [`docs/concepts/composer-and-sending.md`](../concepts/composer-and-sending.md)
**Implemented in:** `packages/protocol/src/frames.ts`, `packages/protocol/src/errors.ts`

## Context

Four documents agree that sending is an HTTP `POST` and that everything else rides the
socket. **None of them names the path.** ADR 0004 fixes the method, the client's UUID as both
identity and idempotency key, and the three answers the server gives when that key arrives
twice. `message-lifecycle.md` §6 gives them as a table.

Three things were genuinely open, and each of them is a decision rather than a detail:

1. **The path, and whether the conversation goes in the body.** `sendMessageRequest` carried
   only `id`, `body` and `attachments` — every other payload in `frames.ts` says which
   conversation it belongs to, and this one did not.
2. **What "the same content" means.** §6's middle and third rows are separated by a
   comparison, and **no document says which fields are compared.** That single omission is
   exactly what decides when the `409` fires. Everything else about idempotency was decided
   and this was not.
3. **What a failure looks like on the wire.** There was no error envelope at all.
   `apps/realtime` answered `401` with a hand-written body and nothing else existed. So `409`
   had no shape, a Postgres `23505` had nowhere to go, and — worse — the distinction the
   composer is built on had nowhere to live.

That third gap is the one with teeth. `composer-and-sending.md` makes retryable-versus-terminal
load-bearing: retryable failures back off and stay queued, terminal ones become a visible
`Not sent` row with `Try again` and `Delete`. A client that cannot tell them apart either
retries a client bug forever or abandons a message that needed one more attempt.

## Decision

### The path, and the conversation twice

```
POST /api/conversations/{conversationId}/messages
```

`conversationId` is in the path **and in the body**. The body field is required, not optional
and not filled in by the router.

That looks like waste and it is the same argument `message-lifecycle.md` §4 already makes about
frames: a payload that does not say which conversation it belongs to is a bug that can only
ever appear on a platform nobody has built yet, because the router would have filled the gap
in. Two copies of an identifier are cheaper than one conversation's messages landing in the
wrong transcript, and the second copy costs one field.

### The three answers, verbatim from `message-lifecycle.md` §6

| situation | response |
|---|---|
| new message | `200` with the canonical row, including its assigned position |
| same key, same content | `200` with the **original** row, including its position |
| same key, different content | `409`, naming the conflict |

The middle row is the ordinary case — a retry after a timeout, where the first request probably
succeeded. Returning the original **with its position** is what lets the client reconcile from
its own retry response instead of waiting for an echo of itself over the socket.

The response is `{ message, deduplicated }`. `deduplicated` is required and a real boolean:
`false` for a new message, `true` for the second row. It is the only place the two `200`s
differ, and a client that cannot tell a fresh commit from a recovered one cannot tell whether
its optimistic row needs fixing.

### What "the same content" means

**Four fields, and only four: `body`, canonicalised `attachments`, `conversationId`, and
`authorId`.**

Anything else — `createdAt`, `seq`, anything a client might plausibly send that the server
ignores — is **not** compared. A comparison over a field the client controls and the server
discards is a source of `409`s that no member can act on.

Two of the four are cases worth naming:

- **`attachments` are compared canonicalised:** ordered by `mediaId`, `variant` included, no
  duplicates. Two clients that picked the same photo in a different order sent the same
  message. A `409` for a reordering is a false accusation, and false accusations are how a
  retryable path loses its credibility.
- **`authorId` is compared, and a mismatch is a `409` rather than a silent success.** One
  idempotency key bound to two different authors is a client bug. Answering `200` would hide
  it — the second author would see their own text attached to somebody else's send and nothing
  anywhere would say why.

This is the whole definition of "same content", and it now lives in exactly two places: this
ADR and the wire form, `sendConflictField` in `packages/protocol/src/errors.ts`. There is a
test asserting the enum is exactly those four options, so a fifth field cannot be added to one
without failing the other.

### The error envelope

Every failure leaves as `{ error: { code, message, retryable, … } }`.

**`retryable` is a field, not something a client infers from a status code.** It is a
`z.literal` per branch of a discriminated union rather than one boolean on the envelope, which
makes `{ code: 'idempotencyConflict', retryable: true }` *unparseable* instead of merely wrong.
Written as a plain boolean, that contradiction parses, and a send queue that trusts it either
retries a client bug forever or abandons a message that needed one more try — silently, in the
first case, and to a member in the second.

| code | retryable | when |
|---|---|---|
| `unauthenticated` | yes | `401` — re-authentication re-flushes the send queue |
| `requestTimeout` | yes | `408` |
| `tooEarly` | yes | `425` |
| `rateLimited` | yes | `429`; carries `retryAfterSeconds`, and honouring it **resets** the backoff |
| `internal` | yes | `5xx`; ambiguous — the send may have committed, which is what the key is for |
| `invalidRequest` | **no** | `400`; carries per-field detail for the `Not sent` strip |
| `payloadTooLarge` | **no** | `413` |
| `unprocessable` | **no** | `422` |
| `idempotencyConflict` | **no** | `409`; carries `conflictingFields`, naming what disagreed |
| `sendBlocked` | yes | the conversation is locked — and the *other member* can lift it without the sender doing anything; carries the `sendPermission` reason |
| `notFound`, `methodNotAllowed` | **no** | routing |

The first six rows are `composer-and-sending.md`'s, transcribed. A test asserts every row lands on the
branch the composer document gives it, so a change to that table fails here. `sendBlocked`,
`notFound` and `methodNotAllowed` are **not** in that table; they exist only in this envelope.

> **Corrected: `sendBlocked` is retryable, and the member-facing affordance is a different fact.** It
> was written `no` here, which was the one wrong answer in this file. A block is **server-side state**
> and the *other member* can lift it; the blocked member does not have to do anything for it to change.
> So retrying the identical bytes plausibly produces a different status — which is
> `composer-and-sending.md`'s own test, and the same test that makes `429` retryable. The row stays
> `queued` and flushes on the next backoff tick after the block lifts.
>
> **What the composer shows and what the queue does are separate concerns, and both are true at once.**
> The composer replaces the input with **`You can't send messages to this conversation`** and one
> destructive action, `Leave conversation` ([0007](0007-conversation-model.md)) — that is what the
> interface does with a locked conversation. It is *not* a statement about whether the queued send is
> dead. `retryable: true` is the send queue's classification. Collapsing the two produced exactly one
> wrong answer, and it is the one the queue would have paid for on every retry.
>
> [0060](0060-stored-state-is-narrow-and-derived-state-is-wide.md) depends on this row: a refusal that
> could plausibly answer differently leaves the row `queued`, and only a terminal one moves it to
> `failed`. Had this stayed `no`, a lifted block would have produced a permanent `Not sent` row with no
> way back.

**`idempotencyConflict` names the fields.** `message-lifecycle.md` says the `409` names the
conflict; "names the conflict" means names the **fields**, because a member staring at
`Not sent` learns that the text differed, not merely that something did. An empty list is
rejected — it would say "something differs" and identify nothing.

**`postgresCode` is a five-character SQLSTATE or nothing.** `23505` on `message_id_key` is the
dedupe path, and a slot for it means a database failure is recognisable rather than prose.

### A failure before execution must not consume the idempotency key

`message-lifecycle.md` §6 copies this from Stripe and ADR 0004 requires it: **a `429`, or a
`400` that fails validation, leaves the key unused and the request retryable.** A rate-limited
send must not burn the message's identity.

The implementation consequence, which is the part that is easy to get wrong: **nothing is
written to `message` before the row is about to be committed in the same transaction.** There
is no separate "reserve the key" write, because a reservation that outlives a rolled-back
transaction is a key consumed by a failure that never executed.

### What was deliberately not added

- **A code-to-status table.** A status is the server's to choose, and a second table beside
  the envelope is a second source of truth that could disagree about whether a `409` is
  retryable — the exact failure this ADR exists to remove.
- **An `ambiguous` marker.** Every retryable outcome renders identically in v1 (back off, stay
  queued), so a field distinguishing the ambiguous ones would have no reader.
- **`sharing` on the receipt-advance body.** It is a settings change with its own transport
  (ADR 0022), not an advance.

## Consequences

- **The `409` is now a bug report with a location.** Before this, "same key, different
  content" was a rule with no implementation; now it is four named fields, and a mismatch in
  the fourth — the author — is caught rather than silently succeeding.
- **A client can build its retry policy from the wire.** It reads `retryable` and stops. It
  does not carry a mirrored table of status codes that the server can contradict without
  anybody noticing.
- **The envelope is enforced where failures are produced, not only described.** `apps/realtime`
  now builds its `401`, `404` and `405` through `errorEnvelope.parse`, so a shape that drifts
  from the schema is a failed request rather than a quietly different body. Adding a field to
  the server without adding it to the schema fails there and in the tests.
- **The stored client state narrowed, and that is a vocabulary change.** `messageState` was
  `pending | sent | delivered | read`. It is now `queued | inFlight | failed`: three states a
  browser can know with no network at all. `sent` is `seq !== null` and is not stored;
  `delivered` and `read` are member watermarks and were never a message's to hold. The
  composer needs all five renderings and gets them from a separate derived enum plus one
  function. `pending` is gone from the protocol because it is on the glossary's avoid list —
  the word is **queued send**.
- **A `clientMessage` row schema was considered and not written.** It would need the error
  envelope, and the envelope needs `sendBlockReason`, so the row schema would have introduced a
  cycle between `conversation.ts` and `errors.ts` for something 3.G will shape anyway. Noted
  here so nobody re-derives the argument and then wonders why the import looks circular.

## What would reverse this

**Deltas instead of absolute positions on the two write-frame bodies.** `deliveryAckRequest`
and `receiptAdvanceRequest` state absolute positions, and ADR 0010 is explicit that this is
load-bearing: `GREATEST` in the upsert absorbs out-of-order arrival, two tabs racing, a send
queue flushing after a reload, and a device clock jumping backwards — **only** because the
client states where it has got to. On deltas the same code runs and quietly stops working.
There is no runtime guard against that and there cannot be one; the comment on the schemas is
the guard, which is why it says so.

**A fourth dedupe outcome.** If a client ever needs to change what it sent, that is not this
endpoint — ADR 0053 rules it out, because the message's UUIDv7 *is* its idempotency key, and
editing a queued send proposes binding one key to two payloads: the client bug the `409`
exists to catch, manufactured by the product itself.

**One error shape per endpoint.** Everything here is one envelope for one service. Splitting it
per endpoint would reintroduce the client-side status-code table this ADR removes.
