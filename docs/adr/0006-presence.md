# 0006. Presence lives in a Redis TTL, not in Centrifugo's built-in presence

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Presence and typing semantics"
**Teaches:** [`docs/concepts/presence-and-typing.md`](../concepts/presence-and-typing.md)

## Context

The map committed vartalap to self-hosted Centrifugo over a Redis broker, and settled that presence
is *connected now* while typing is *composing right now* — two signals routinely conflated, neither
durable, neither on the write path.

What was undecided is where presence physically lives, and what "now" means precisely. The ticket
offered three homes, and the obvious one turns out to be the wrong one.

## Decision

### Presence is a Redis TTL key per user, refreshed from connection liveness

`presence:<userId>` with a **45-second TTL**, kept alive by the server observing live connections
rather than by a client-side timer. The interface reads it with an `MGET` to paint a list and a
subscription to keep it true.

### "Connected now" means connected within the last 45 seconds

The glossary says so explicitly. Presence is not a boolean at an instant; it is a boolean over a
window, and every implementation has a window.

### The refresh is driven by the connection, never by a JavaScript timer

Browsers throttle timers in background tabs — hard, and a long-idle background tab can be frozen
outright. A client heartbeat therefore reports a user as offline while they are sitting right there,
which is the worst possible failure for a green dot. WebSocket keepalives run at the protocol level
and are not throttled, so **presence is a property of the connection**.

### Last-seen is out of v1

Ruled out deliberately, for two reasons that are not the same reason.

### Typing is throttled, expires on a client timer, and is never persisted

At most one event every two seconds, and only when the text actually changed.

## Why not Centrifugo's built-in presence

This is the decision that looks wrong until you read the FAQ.

Centrifugo's traditional presence is **per-channel**: the server API takes `channel` as a required
field and answers "who is subscribed to this channel". A chat app's members do not share a channel —
each user has their own personal channel — so the question the interface actually asks cannot be
phrased in it. Centrifugo's documentation says so directly:

> if you make a chat app - you may probably use a single personal channel for each user. In this
> case, **you cannot find who is online at moment using the built-in Centrifugo presence feature** as
> users do not share a common channel. You can solve this using a separate service that tracks the
> online status of your users (for example in Redis) and has a bulk API.

The other candidate, `map_users`, **does** provide per-user presence — but only from v6.8.0
(2026-05-22), and its own documentation labels it **Experimental**: "all its parts — configuration
options, client SDK API, server API — may change in future releases". Designing around a feature
carrying that warning is a bet, not an architecture.

The dependency objection dissolves on contact with the map: **Redis is already the broker.** Adding a
TTL key to a Redis we already run is not a new dependency, it is a new key.

## Consequences

- **Presence has a 45-second resolution and cannot be finer without abandoning the design.** Every
  Centrifugo path has the same ceiling — `presence_ttl` defaults to 60s — so this is the shape of the
  fact, not an artefact of our choice.
- **A member with a frozen background tab is online. A member who closed the tab 40 seconds ago is
  still online.** Presence means "has a live connection to us", not "is looking at the app". That is
  a defensible and honest definition, but it is *not* the same question as "can I reach them right
  now", and the glossary says which one we answered.
- **The interface must both `MGET` and subscribe.** `MGET` paints fifty conversations in one round
  trip, which is the latency a person actually perceives. The subscription keeps it true afterwards.
  Subscription-only leaves an empty list until events arrive; batch-only leaves a list that is wrong
  by the time it is read. Neither is acceptable alone, and neither failure is visible until
  production.
- **Join/leave delivery guarantees do not bind us.** Centrifugo delivers traditional presence
  join/leave events **at most once**. We do not depend on them, which matters because the docs also
  warn that enabling them for a large channel "drastically multipl[ies] the amount of messages
  traveling through the system".
- **Typing can be replayed by a reconnect, and must not be.** Frames carry a timestamp and a client
  identifier, and a receiver discards a typing frame older than its expiry. If typing were durable, a
  reconnect would faithfully replay "X was typing" from last Tuesday and it would stop being a hint.

## Last-seen, and why the reasoning in the map's fog was slightly wrong

The map listed precise last-seen as fog because it "has a legal dimension and in some jurisdictions
has legal weight". Checking the law found the legal part real and the citations wrong:

- A last-seen timestamp keyed to a user id **is personal data under GDPR Art. 4(1)** — verified
  against the official text. Lawful basis and retention are the live questions; classification is not.
- Under CCPA it is personal information but **not** sensitive personal information, so no consent gate.
- The **WhatsApp/Garante** matter was about **transparency and data sharing with Facebook group
  companies**, not a chat-metadata holding. It should not be cited for this.
- The **German Facebook case** often cited here is about a **2021 data breach**, decided by the BGH in
  **2024** (VI ZR 10/24), resting on Art. 82(1) damages. Nothing in that line of cases concerns
  last-seen or active-status timestamps.

But the decisive argument is not legal. **No Centrifugo primitive gives precision better than 60
seconds** — every documented path is TTL-bounded. So a "precise last seen" would be a fiction we
would have to build ourselves, on top of a lawful-basis and retention question, for a feature that is
not in the core messenger.

Declined, with the reasoning recorded so that if it is ever requested it is requested as a new
decision rather than assumed to have been an oversight.

## What would reverse this

**The TTL is the tuning surface.** Shorter makes the dot honest and the writes more frequent; longer
does the opposite. 45 seconds with a 15-second refresh gives three beats of margin, which absorbs two
missed refreshes before anyone sees a lie.

**If presence ever needs to mean "actively viewing this conversation"**, the TTL cannot answer it and
neither can any Centrifugo primitive. That is a different fact, needing its own signal — and it is
the question people usually mean when they say presence, so it is worth naming that we answered a
narrower one on purpose.

**A privacy-preserving middle ground exists and is deliberately not built**: last-seen rounded to a
coarse bucket, or shown only to people you already talk to. If vartalap is ever run by more than one
user, that is the version to build, and the TTL granularity becomes the knob that decides it.