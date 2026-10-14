# Presence and typing

Two signals that look like one thing and are not. Presence says **this person is connected**. Typing
says **this person is composing**. Neither is durable, neither belongs on the write path, and
conflating them produces a system that is expensive to run and wrong about what it knows.

The decisions are in [`docs/adr/0006`](../adr/0006-presence.md). The *why they are not persisted* is
in [the message lifecycle](./message-lifecycle.md#what-never-enters-the-durable-path).

---

## Presence

### Where it lives

A Redis key per user, `presence:<userId>`, with a **45-second TTL**.

Not Centrifugo's built-in presence, which is the obvious-looking answer and cannot express the
question. Centrifugo's presence answers *"who is subscribed to this channel"*, and a chat app's
members do not share a channel — each has their own personal one. Its own documentation says the
built-in feature cannot answer "who is online" for a chat app, and recommends a separate service
with a bulk API. That is this design.

Redis is already the broker, so this is a new key rather than a new dependency.

### Who refreshes it, and why that matters more than it looks

The refresh is driven by **the connection**, not by a timer.

Browsers throttle JavaScript timers in background tabs — aggressively, and a long-idle background tab
can be frozen outright. A client-side heartbeat therefore marks a user as offline while they are
sitting right there looking at the app, which is the single worst failure a green dot can have. WebSocket keepalives run at the protocol level and are not throttled, so liveness comes from the connection and a `visibilitychange` refresh covers the rest.

### What "connected now" actually means

**Connected within the last 45 seconds.** Not connected at this instant.

`GLOSSARY.md` now says so, because the difference is small and it is the difference between a spec
someone implements correctly and one that produces an off-by-one nobody can reproduce. The resolution
is a property of the design, not of this implementation — Centrifugo's own presence has the same
ceiling at 60 seconds.

It also means the answer is narrower than the question people usually mean:

- a member with a frozen background tab is **online**
- a member who closed the tab forty seconds ago is **still online**
- "actively looking at this conversation" is **not** something presence answers, and would need its
  own signal if it were ever needed

### How the interface reads it

Both, because either alone fails visibly:

- **`MGET` to paint.** One round trip fetches every member's state, which is the latency a person
  actually perceives. Fifty conversations, one query.
- **A subscription to correct it.** Presence changes asynchronously; the list would otherwise be a
  snapshot of who was online when you opened it.

Subscription-only leaves the list empty until events arrive. Batch-only leaves it wrong by the time
it is read. Neither failure is visible until production.

### What we deliberately do not build

**Last-seen.** Not in v1, and not because it is hard. Every presence mechanism available has a TTL
ceiling, so a *precise* last-seen would be a fiction we built ourselves — on top of the question of
whether we should. A last-seen timestamp keyed to a user id is personal data under GDPR Art. 4(1),
with lawful basis and retention still to settle. It is not on the road.

If it is ever wanted, the privacy-preserving version is a coarse bucket rather than an exact
instant, and the TTL granularity is the knob that decides it.

---

## Typing

A user gesture that expires, not a fact about the world.

### Throttle

At most one event every **two seconds**, and only when the text actually changed. Not a nicety —
typing is continuous while a message is short, and a two-second message can generate a dozen frames
for a single send.

### Expiry is a client timer

Clear the indicator after a few seconds of silence, **on the receiver**. A server-side timer is
wrong because the sender may simply have closed their tab — and a server that "clears" typing for
someone who left is inventing a fact.

### Never persisted

If typing were durable, a reconnect would faithfully replay "Priya was typing" from last Tuesday, and
it would stop being a hint. Every typing frame therefore carries a timestamp and the receiving
client discards one older than its expiry.

### Group semantics

- One person typing: **"Priya is typing…"**
- More than one: **"Several people are typing…"**

A member who leaves mid-typing drops out immediately — their last frame is stale by definition.

### One claim we removed

The ticket justified throttling by saying unthrottled typing is *"orders of magnitude more traffic
than the messages themselves."* **No primary source publishes any such ratio** — the engineering
blogs of Discord, Slack, Signal and Telegram contain zero measurements of typing traffic, and a
figure could not be sourced.

Throttling stands, because generating an event per keystroke is obviously wasteful. It just should
not be justified with a number nobody published. Centrifugo's own documentation gives the only
sourced caution in the vicinity, and it is qualitative: per-subscriber events "drastically multipl[y]
the amount of messages traveling through the system", with no ratio attached.