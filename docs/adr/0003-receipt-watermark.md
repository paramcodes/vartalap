# 0003. Receipts are a bookmark, not a diary — a per-member watermark, not a log

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Read receipts: watermark or append-only log"
**Feeds:** "Read receipt mechanics: row shape, monotonicity, throttling, and catch-up"
**Blocked by:** "Message ordering and pagination, including the commit-inversion race" — the position type is #7's to settle

## Context

Two research reports reached opposite conclusions and the map flagged the conflict as unresolved. One argued receipts must be append-only log entries. The other argued per-message receipt rows are an `O(messages × members)` trap and a per-member watermark is correct.

They were arguing about **different halves of the same thing**, and both were half right.

## Decision

**Append-only transport, replace-only storage.** Receipt updates arrive as ephemeral deltas — one event per advance, exactly as the outbox already delivers everything else. When an update lands it **overwrites a single stored number**. It does not add a row.

**One row per (conversation, member), holding the furthest point read.**

```
Seen under M  ⇔  ∀ m ∈ currentMembers(M), m ≠ me, shares(m):
                     receipt[m].read_through >= seq(M)
```

## Why the conflict dissolves

The Matrix specification does both halves at once, and it is the clearest statement of the model available:

> Sending a receipt for each event can result in sending large amounts of traffic… receipts are implemented using **"up to" markers**.

> Each `user_id`, `receipt_type`, and categorisation (unthreaded, or `thread_id`) tuple must be **associated with only a single `event_id`**.

> New receipts that come down the event streams are **deltas which update existing mappings**. Clients should **replace** older receipt acknowledgements.

A bank statement arrives as a running commentary — deposits, deposits, deposits — while the balance is one number that gets replaced each time. Both are true simultaneously. The first report was right about the wire and wrong about the table. The second was right about the table and did not need to win the wire argument.

## Consequences

- **Unread count falls out of the same number**, as `count(messages where seq > read_through)`. Derived, never stored — which `GLOSSARY.md` already commits to, and which a stored count would violate by becoming a second source of truth that disagrees the moment either is wrong.
- **The `O(messages × members)` trap is avoided by arithmetic, not taste.** A 1,000-member conversation with 1M messages is 10⁹ rows, and "has this member read this message" becomes a self-join over a table that will not fit on the disk we rent.
- **"Seen" is arithmetic, not a query.** It is a comparison against each member's stored number, so it costs the same for a 4-person conversation and a 400-person one.
- **The UI rule is a consequence of the schema, not a special case.** Matrix independently requires that clients *"SHOULD NOT send read receipts for events sent by their own user"* — so a member's own sends never advance their own receipt, and their watermark can never satisfy the predicate for their own message. "Seen" appears under the last outgoing message and never under an incoming one, without a rule anywhere saying so.

## What this gives up

**The history.** A watermark cannot answer *"when did Priya read this?"* or *"had she seen my message before I followed up an hour later?"* Matrix keeps a separate `m.fully_read` alongside `m.read` precisely because those are different needs.

This was the strongest argument for the append-only design and it is not a bad one. It is declined deliberately: keeping the history makes unread counts expensive again, and it is the cost essentially every real messenger declines to pay. Reversing this later means backfilling receipts nobody kept.

## Three edges that follow from the decision

**A member who does not share their receipt is excluded from the `Seen` predicate** — on the same edge as a former member. Under an all-members rule this is load-bearing, not politeness: without it, one privacy-conscious member silently prevents "Seen" from ever appearing for anyone in that conversation, permanently and invisibly. A receipt that cannot reach the sender must not gate a predicate the sender cannot satisfy.

**Every member always has a receipt**, whatever their sharing setting. A member reading privately still needs an accurate local receipt to clear their own unread count — the entire point of Matrix's `m.read.private`. Sharing is therefore a fact *about* a receipt, not a condition of its existence, and `GLOSSARY.md` says so without committing to storage.

**The receipt's position type is not settled here.** `>=` must be meaningful for the `Seen` predicate to be reliable, which rules out `created_at` (clock skew, same-millisecond collisions) and UUIDv7 (monotonic only *most* of the time — two concurrent sends in one millisecond tie-break randomly, so `Seen` flickers exactly when a busy conversation is being compared). An explicit `bigint` sequence is the recommendation — **a single global column, not a per-conversation one.** That is [0005](0005-message-ordering.md)'s decision, and it gates this one.

> **Amended by [0005](0005-message-ordering.md).** This record originally recommended a *per-conversation* sequence. That was wrong. Per-conversation positions do not compare across conversations, so there is no global order and therefore no global cursor — reconnect would need one query per conversation. A single global `seq` is both the transcript order and the catch-up cursor, and because it is one column serving both jobs it cannot disagree with itself.

## What would reverse this

If vartalap needs read *history* — per-message "read by" with timestamps, or "who had seen this when I followed up" — a watermark is the wrong structure and the receipt table has to be rebuilt. That is cheap now and expensive after the first million rows, which is why it is decided here rather than deferred.

The same applies to `receipt.read_through` carrying no foreign key to `messages`: it points at a *position*, not a row, so deleting a message must not delete the receipt pointing at it. Edit and delete are on the roadmap.