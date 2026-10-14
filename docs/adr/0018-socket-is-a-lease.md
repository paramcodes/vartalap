# 0018. A socket is a sixty-second lease, and revocation is a row delete plus a disconnect

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Auth, onboarding and identity spec"
**Builds on:** [0001](0001-self-hosted-better-auth.md), [0006](0006-presence.md),
[0012](0022-settings-boundary-and-transports.md), [0014](0043-rate-limits.md)
**Teaches:** [`docs/concepts/auth-and-identity.md`](../concepts/auth-and-identity.md)

## Context

The ticket's sharpest question, and the only one in it that is not about schema:

> A socket connection lives for hours. A credential verified once at upgrade stays valid after the user
> signs out elsewhere. **How is a long-lived connection killed when a session is revoked?**

It also floated two supporting premises. One is a map-level position to be made concrete — *"revocation
starts as rotating a secret or bumping a version column"* — and one is about Neon, which is false.

[0012](0022-settings-boundary-and-transports.md) has already settled that the devices list is the core
`session` table and that `session.cookieCache` is off, from the settings screen's side. This ADR is the
same decision from the transport's side, plus the numbers, plus the socket — which is where the live
connections are.

## Decision

### Session lifetimes

```ts
session: {
  expiresIn: 60 * 60 * 24 * 30,   // 30 days, against the 7-day default
  updateAge:  60 * 60 * 24,       // 1 day, the default
  freshAge:   60 * 5,            // 5 minutes, against the 1-day default
  cookieCache: { enabled: false } // settled by 0012; restated so it is never "optimised" on
}
```

**Thirty days** because a messenger session is expected to survive a laptop being shut for a week, and
signing someone out of their own account is worse than the session it protects.

**`freshAge: 5 minutes`** so that *revoke all other sessions* — a security action, and the one
[0012](0022-settings-boundary-and-transports.md) puts on the settings screen — asks for the password on
anything older than five minutes. Better Auth already gates session revocation on freshness, so this is a
number rather than a mechanism.

`cookieCache` is off for the transport reason as much as the settings one: a `session_data` cookie is a
**signed, not encrypted, copy of the user record** that survives a revocation for `maxAge`, and
[0016](0016-identity-is-one-table.md) records the second failure it causes — a stale `user.username` read
out of one is enough to defeat the handle guard.

### Every connection token is a sixty-second lease

```ts
{ sub: userId, exp: Math.floor(Date.now() / 1000) + 60, aud: 'centrifugo', iss: 'vartalap' }
```

minted by our API from the live session, fetched by the SDK's `getToken`.

- **`exp` is the entire mechanism.** Centrifugo's documentation is unambiguous: *"If the `exp` claim is not
  included, Centrifugo will not expire the connection."* A token without `exp` is a connection that no
  revocation can ever reach, and **nothing about it looks broken** — it looks like a chat app that works.
- The renewal is the read that makes revocation reachable: sixty seconds later the SDK asks, and the
  session row says no.
- **`aud` and `iss` are unchecked by default** on both sides. *"By default, Centrifugo does not check
  JWT audience"* and the same for issuer. Setting `client.token.audience` and `client.token.issuer` costs
  two lines and stops a token minted for another service sharing the signing key from connecting.

Centrifugo allows a **25-second grace period** past `exp` for the refresh. So the ceiling between
"revoked in the database" and "socket actually closed" is **85 seconds**, with no other mechanism
involved.

### Revocation kills the socket in the same breath

OWASP's Session Management cheat sheet, on logout:

> Enforce session expiration on the server and invalidate the session when the user logs out; **deleting a
> cookie alone does not invalidate a stolen copy of the session ID.**

An open socket is exactly that stolen copy, held open for hours.

| | database | realtime |
|---|---|---|
| sign out here | `DELETE` this `session` row | `POST /api/disconnect { user }` |
| sign out on another device | `DELETE` this `session` row | `POST /api/disconnect { user, whitelist: [currentClientId] }` |
| sign out everywhere | `DELETE FROM session WHERE user_id = $1` | `POST /api/disconnect { user }` |

`disconnect` is the Centrifugo server API, authenticated with `X-API-Key`, propagated across the cluster
over the Redis broker the map already chose.

**Every revocation disconnects all of that user's connections.** Devices whose sessions survive
reconnect within about a second and carry on. Centrifugo *can* target one `client` or `session`, but
matching one to a session row means carrying two vocabularies for one word, and the cost lands on the
*other* devices as a one-second blip.

**The client never calls Better Auth's `/sign-out` directly.** It calls our route, which calls the
library's server API and then Centrifugo, so the pairing cannot come apart.
`databaseHooks.session.delete.after` is the obvious alternative and is not used, because it fires on
*every* session delete including the expiry sweep — and a sweep that disconnects everyone's sockets is a
bug waiting for a cron expression.

### The connection token lives in memory, and the fetch that mints it is same-origin

OWASP, on web storage: *"Do not store authentication tokens, session IDs, JWTs, refresh tokens, or any
credential in `localStorage` or `sessionStorage`."*

`Request.credentials` defaults to `"same-origin"`, so the `getToken` fetch **must use a relative URL**. An
absolute cross-origin one silently drops the session cookie; the connection then connects, authenticates
as nobody, and fails at the first publish — a bug that presents as an authorisation problem.

### Three devices is not a device model

No `device` table, per [0012](0022-settings-boundary-and-transports.md). What the transport adds is the
other half of the answer: the sessions list is not only *display*, it is the set of leases, and revoking
one is the same `DELETE` plus `disconnect` as revoking all of them. The devices screen and the socket are
the same data.

### Auth rate limiting is [0014](0043-rate-limits.md)'s Redis bucket, not Better Auth's

[0014](0043-rate-limits.md) decided: one module, one Redis Lua script, auth keyed on **IP** at
**10/min with a burst of 3**, and — explicitly — *"Better Auth's own rate-limit config is not used. One
module owns one set of numbers, or the two will disagree about what is allowed and nobody will know which
one is binding."*

So `rateLimit.enabled` is **false** in our config rather than left at its default. That default is
worth naming because it is silent: Better Auth *"enables it by default in production"*, at 100 requests
per 10 seconds.

**One hand-off this ADR owns:** [0014](0043-rate-limits.md) keys the auth limiter on the client IP, and
Better Auth resolves that IP from `X-Forwarded-For` by default, documenting that behind a proxy chain you
must list your proxies in `advanced.ipAddress.trustedProxies` so it resolves *"the real client instead of
the spoofable leftmost `X-Forwarded-For` token"*.

**Whichever process runs the limiter must resolve the IP the same way, or must be configured the same
way.** `trustedProxies` is not optional and is a one-line omission that defeats a per-IP limiter
entirely — an attacker rotates a header and the bucket never fills.

### Neon scale-to-zero loses nothing, and the ticket's premise was wrong

The ticket asked about *"its loss of session state on suspend"* — hedged with *"if anything is held in
Postgres session state"*. Neon documents the opposite:

> Scale to Zero suspends the Neon compute that runs your Postgres database after a period of inactivity […]
> **once you query the database again, it reactivates automatically within a few hundred milliseconds.**

Durable storage is never at risk; a suspended compute is a paused one. **And nothing auth-related lives
in Postgres session state** — no `LISTEN`/`NOTIFY`, no session variables, no session advisory locks
anywhere in this design. The hedge was the right hedge and the answer is no.

What scale-to-zero *does* cost is latency: the buffer cache and the statistics come back cold, so the
first sign-in after five quiet minutes is slower than the fiftieth. Nothing about the schema changes; the
reason `getSession` and the token mint must stay indexed point lookups rather than becoming cleverer is
this.

## Corrections to the original ticket

- **"Rotating a secret or bumping a version column."** Not needed, and it would have been worse. Both
  make a *valid token* invalid; this makes a **row** invalid — one `DELETE` against a primary key, and
  revoking one device is the same operation as revoking all of them. A version column is what you build
  when you cannot enumerate sessions. We can.
- **"What happens when a user has 3 devices."** Three rows in `session` and three Centrifugo connections.
  There is no separate device concept, which is the answer rather than a dodge.
- **The cookie cache's cost is stated by Better Auth itself**: *"revoked sessions may remain active on
  other devices until the cookie cache expires (`maxAge`)."*

## Consequences

- **Revocation is one delete and one HTTP call** at any device count vartalap will see.
- **The 85-second ceiling is a fact about Centrifugo, not our code.** Recorded so nobody later reads
  "sign out everywhere" as "everywhere, instantly".
- **A session read on every authenticated request**, plus one per connection per minute. That is the
  price of the cookie cache [0012](0022-settings-boundary-and-transports.md) declined, and at this scale
  it is free.
- **Three devices reconnecting look like three outages to whatever watches connection counts.** Worth a
  line in whatever the observability story becomes.

## What would reverse this

**The cookie cache, when the request rate justifies it.** The moment `getSession` is a measurable share of
database load, enabling it with `maxAge: 60` is one config line — and the trade is a sixty-second
revocation floor on every device, including one that never receives the `disconnect` call. Above some
traffic number the saving is real and the floor is the price. The number is not yet measured, and naming
it requires traffic that does not exist.

**Second-factor or step-up auth.** `freshAge` is the hook and it already exists. Adding TOTP does not
change revocation; it changes how often a *legitimate* revocation asks for a password, and that
interaction has to be designed rather than discovered.
