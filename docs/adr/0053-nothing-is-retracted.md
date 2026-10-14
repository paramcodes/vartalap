# 0053. Nothing is retracted: a queued send can be waited for or discarded, never changed

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Composer and media sending spec"
**Builds on:** [0004](0004-message-durability.md) (one UUID is both identity and idempotency key), [0052](0052-media-is-staged-before-the-message-exists.md)
**Teaches:** [`docs/concepts/composer-and-sending.md`](../concepts/composer-and-sending.md)

## Context

The ticket asked two questions and took them for granted that they were separable:

> *Editing a pending message. The client generated an id and queued the row. Can the user change
> their mind before it lands? If they can, what happens to the already-queued payload?*

They are not separable, and the reason is one decision made four tickets ago. **The client's UUIDv7 is
simultaneously the message identity and the idempotency key.** That is what makes a retry after a
timeout safe ([0004](0004-message-durability.md)), and it is the reason the server can answer "same
key, different content" with a terminal `409`.

So a member editing a queued send is proposing to bind one key to two different payloads — which is
exactly the client bug the `409` exists to catch, manufactured by the product itself.

There is a second, quieter reason. Whether a `POST` is in flight is **not observable from the
client**. The row says `pending`; the row also said `pending` four milliseconds before the request
left. An edit affordance enabled on `position === null` would race the very request it was trying to
correct, and the most likely outcome of that race is the member's own `409`.

## Decision

### The two acts on a queued send are **wait** and **discard**. That is the whole list.

No edit, no recall, no unsend, no "retype and replace", at any point in its life.

### Discard is the member's decision, made on a row they can still see

Inherited from ADR 0004 and unchanged: *"A message someone pressed send on is never discarded
automatically."* What this ADR adds is that **discarding is the only destructive act on the
composer, and it is opt-in.** The system never takes it.

### Nothing is retracted after the server commits either

The two questions were separable after all — just not in the direction the ticket assumed. **Editing
is declined because the payload is immutable; recall is declined because the conversation is not
yours.** Once the transaction commits, the message belongs to the conversation, and the only member
with any claim on it is the one who wrote it.

## What was rejected, and why

**Edit while `position === null` and no request in flight.** The race above, plus a second problem:
"no request in flight" is a fact the client cannot know, only guess. An affordance that is correct
95% of the time and destroys the message the other 5% is worse than no affordance.

**A `PATCH` that carries the edit and keeps the same key.** This is the version that works
technically — the server would compare the edit against the stored original and, on a match, apply
it, and the `409` would be reserved for genuine bugs again. **Rejected on cost, not correctness.** It
makes a message's body mutable after the durable spine has committed it, which means search indexes
(`tsvector`, [0009](0009-message-search.md)), receipts (they point at a position, so they survive),
and the fact every member has already read it all have to be re-argued rather than inherited. Edit
belongs to Tier 2 with the schema work it implies, and ADR 0005 already recorded the two constraints
it must never break: **an edit changes neither a message's `seq` nor its identity.**

**Telegram's recall and Messenger's "you can unsend for a while".** Both are real products with real
receivers, and both have consequences vartalap has no answer for. What does a receipt mean when the
message it points at has gone? Does it count toward an unread count? Does the search index forget it?
A recall window is not one feature; it is a policy question about every watermark and every index in
the system, and it is the kind of question that gets answered badly if it arrives as a UI button
rather than as a design.

## Consequences

- **The composer's affordances are fixed and small.** Attach, remove a staged file, send. Nothing
  else. This is the most-used surface in the product and it has three controls, which is the point.
- **A member who wants to change their mind does it in the draft**, which is private to one browser
  and has never touched the network. The draft is where changing your mind is free.
- **`Delete` on a failed row is the only destructive control on this screen**, it is destructive in
  the styling sense, and it is preceded by text the member can read: the row says `Not sent`, and the
  body is selectable through the platform's own selection menu — v1 has no message actions at all,
  which is [the chat view's](../concepts/conversation-list-and-chat-view.md#message-actions) finding
  rather than an omission.
- **A future edit feature must not reuse the queued-send row.** Edit applies to a committed message;
  discard applies to a queued send. They share a screen and nothing else.

## What would reverse this

**A member asking for it, from real use.** The trigger is the same one ADR 0049 named for drafts:
measure, do not guess. If people routinely mistype and send, the evidence exists and the argument
above about search, receipts and watermarks has to be answered properly rather than by omitting the
button.

**Erasure.** ADR 0041 already gives a member the ability to remove their own content under a legal
obligation, and it is a different mechanism on purpose: a tombstone that everyone renders
consistently, rather than a message that silently ceases to exist for the sender and not for anyone
else. Anything that looks like "retract this message" must be argued against that, not against this
ADR, or the two will grow incompatible.
