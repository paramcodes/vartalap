# 0043. Rate limits are a Redis token bucket keyed on identity, with the numbers written down

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "The hardening plan: what production-ready means for a learning project"
**Feeds:** [`docs/concepts/hardening-backlog.md`](../concepts/hardening-backlog.md)

## Context

The ticket asked for four surfaces (send, fan-out, upload, auth, search) with a number, a layer,
and an honest answer on whether Redis is needed. It is needed, and the reason it is needed is worth
stating because both alternatives are wrong in ways that are not obvious.

There is also a second question hiding in this ticket that nobody asked directly: **what is the rate
limiter actually protecting, at one user?** The answer is not "abuse." It is three specific things —
a runaway client loop, an accidentally infinite retry, and a script that found a public signup form.
The third is the only one an adversary needs.

## Decision

### One module, one Redis script, keyed by identity **and** action

| surface | key | rate | burst |
|---|---|---|---|
| send a message | user | 30 / min | 10 |
| auth attempts | IP | 10 / min | 3 |
| search | user | 60 / min | 20 |
| upload presign | user | 20 / hour | 5 |

### Media is capped at 10 MB per upload, enforced in the worker after the bytes land

### **Auth fails closed. Send, search and upload fail open.**

### A `429` on send is retried by the send queue with backoff. It is never surfaced as a failure.

## Why Redis and not the other two layers

**Postgres cannot do it.** There is no built-in rate limiter, and building one means writing to the
connection pool — which is the resource you are trying to protect. Worse, a per-user row counter in
the database is a write on every request, in a database where every send is already committing a
message and an outbox row. It turns a read-path guard into a write amplifier on the hot path.

**Cloudflare's rate limiting cannot do it either, and Cloudflare says so.** Its own framing is that
the product is *"permissive, eventually consistent, and intentionally designed to not be used as an
accurate accounting system."* Two concrete limits follow: the `period` must be 10 or 60 seconds —
there is no "per minute, precisely" — and counters are **not shared across data centres**, so the
same user connecting to two PoPs holds two budgets. Cloudflare's own guidance is to key on user ID
rather than IP, which means you must already identify the user at the edge, and once you have
identified the user and have a Redis, you have everything a token bucket needs.

**R2 has none**, and it is the bucket holding the bytes a runaway upload loop will write to.

Redis is already the broker and already holds presence TTLs from [0006](0006-presence.md). This is a
new key type, not a new dependency — the same argument that carried presence, and it holds.

## The keying is not uniform, and that is the trap

Four of the five surfaces key on **user id**. Auth keys on **IP**. One module, two keying strategies.

The reason is that the auth limiter runs before a user exists. Keying signup attempts on user id
means the first request of a credential-stuffing run has no id to key on, so the limiter measures
nothing at all. Keying everything on IP instead would break NAT, corporate proxies, and every
mobile carrier in the world, punishing exactly the ordinary users we want.

This asymmetry is easy to write down as "use IP" or "use user id" and get the other four surfaces
wrong. It is stated in the table for that reason.

## Fail open, except on auth

If Redis is unavailable:

- **Send, search, upload presign: fail open.** A Redis outage is the kind of thing that takes the
  whole realtime tier down, and the worst outcome of that is a member who cannot message anyone
  because a rate limiter could not reach its counter. Availability of the product beats enforcement
  of a guard against a scenario that needs an adversary we do not have.
- **Auth: fail closed.** A Redis outage must not turn sign-in into an unmetered credential-stuffing
  target. Rejecting sign-ins during a Redis outage is an outage of a different kind, and it is the
  correct one — it is visible, attributable, and it does not silently remove the only control
  between a leaked password list and every account.

## The numbers, and what they are honest about

These are engineering judgment, not measurements. No primary source publishes a per-user send rate
for any messenger, and this map has already retracted one such claim in
[0010](0010-receipt-mechanics.md) for exactly this reason. They are recorded as chosen values with
stated reasoning, not as derived ones:

- **30/min with a burst of 10.** A token bucket's capacity is the burst and its refill is the rate,
  so these are two different controls and both are needed. Without a burst, a member pastes ten
  messages in a row and the ninth fails; with a burst of 10 the bucket absorbs a burst and settles
  to a steady 30/min. Ten is roughly what a fast typist produces in a burst.
- **10/min on auth, per IP.** Tight, because the legitimate case is a person typing a password once
  and clicking hard when it is wrong. A tight limit on the *auth* surface is also what bounds the
  email bill — see below.
- **20/hour on upload presign.** Images are large and rare. Twenty an hour is generous for a person
  and hopeless for a loop, which is exactly the shape a limit on this surface should have.
- **60/min on search** is the loosest, because search is cheap per call, interactive, and the failure
  of a too-tight search limit is a broken product rather than a bill.

**Per-conversation fan-out is a cap, not a rate limit** — 500 members, settled in
[0007](0007-conversation-model.md), with the clean-rejection failure mode. It belongs to this
document only so that the two limits are not confused for each other.

## The rate limiter is also the email-bill control

[0001](0001-self-hosted-better-auth.md) recorded that self-hosting Better Auth means
`sendVerificationEmail` and `sendResetPassword` are **our** functions. That makes password reset a
metered, attacker-triggered cost — a script that requests ten thousand resets in a minute sends ten
thousand emails and costs real money, and it is not a hypothetical because the endpoint is public.

**The 10/min-per-IP auth limit is the only thing bounding that bill.** No provider hard-caps
transactional email at our scale, and the fix is not a provider setting, it is the limiter. This is
the connection that makes the auth limit not-optional even before there is a second user.

## Consequences

- **A send `429` must be handled by the send queue, not by the composer.** The queue retries forever
  by [0004](0004-message-durability.md), so a rate-limited send is an ordinary retry with backoff and
  nothing on screen changes. Surfacing "you are sending too fast" as an error state would contradict
  the durability decision; the client protocol needs a distinct `rate_limited` reason carrying
  `Retry-After`, distinct from any failure a member is meant to see.
- **The bucket is one Lua script**, read-and-write atomic, holding tokens and last-refill in one hash
  key with a TTL slightly longer than the refill window. Two round trips per check would be a race.
  A cheaper implementation — `INCR` plus `EXPIRE` — is a fixed window, which allows double the
  nominal rate across the boundary, and a limit that permits 2× the number it claims is not the
  number in the table.
- **The 10 MB media cap is enforced after storage, and that stays expensive.**
  [0008](0008-media-pipeline.md) established that R2 cannot constrain size at signing. The worker's
  rejection is followed by a delete, and a client that simply stops reading its upload can still put
  a large object in the bucket. The R2 lifecycle rule that aborts incomplete multipart uploads is
  the backstop, and both halves of that story are in
  [`docs/concepts/hardening-backlog.md`](../concepts/hardening-backlog.md).
- **Better Auth's own rate-limit config is not used.** One module owns one set of numbers, or the two
  will disagree about what is allowed and nobody will know which one is binding. It is also **enabled
  by default in production** at 100 requests per 10 seconds, so this is an explicit `false` rather
  than an inherited default. [`0018`](0018-socket-is-a-lease.md) owns the hand-off.
- **⚠️ A per-IP limiter that reads the wrong IP is not a limiter at all.** The client address is
  resolved from the standard `X-Forwarded-For` header, which behind a proxy chain is the *leftmost*
  value — the one a client controls. Unless the proxy is explicitly declared as trusted, an attacker
  rotates that header and the bucket never fills, while every legitimate user behind the same proxy
  shares one bucket. **`trustedProxies` is not optional, and it is the single highest-value line in
  this document.** For the three surfaces keyed on user id the problem does not arise, which is the
  argument for keying on identity wherever identity exists.
- **IP-only keying is weak against a distributed attack, and that is the residual risk.** A
  credential-stuffing run rotates IPs against one account and never fills a per-IP bucket. The fix is
  a second limit keyed on the *account* — per-account failed-attempt lockout — and it is deferred to
  the second gate, because it needs an attacker to be worth designing against. Recorded rather than
  claimed solved.
- **The numbers need replacing with measurements, not with more judgment.** At the point where
  observed traffic exists, the correct action is to read real rates and re-derive these, and to
  delete this table's authority rather than add a second one.

## What breaks without this

Three things, in increasing order of how long they take to notice.

1. **A credential-stuffing run against public signup emails real money** and gets no signal, because
   the only instrument that could see it is the limiter.
2. **A client bug becomes an outage.** A render loop that re-sends on every state change, a retry
   that does not back off, an offline queue that flushes a thousand queued sends at once on
   reconnect — each of these is a small mistake that becomes unanswerable load. The limiter is the
   only thing that makes such a bug a degraded experience instead of a dead database.
3. **A public R2 bucket with a presign endpoint accepts unbounded bytes**, and the media worker's
   post-hoc size rejection is the only thing between that and a storage bill.

None of these require an adversary. The first two happen by accident, and a single-user learning
project is *more* likely to hit them than a real one, because it is being driven by hand.

## What would reverse this

**Cloudflare Workers rate limiting**, once its guarantees match what the app needs — accurate,
globally shared counters — becomes free and one-directional, because it runs before the origin is
touched. Cloudflare describes its current implementation as deliberately not that, so this is a
"when they change their minds" entry, not a plan.

**Postgres advisory locks plus a row per user** is the no-new-dependency option for a system with no
Redis. vartalap has a Redis. If the realtime tier is ever replaced, revisit this before anything
else in this ADR, because a rate limiter living in the same store as the realtime broker is a
coupling worth noticing even if it is convenient.