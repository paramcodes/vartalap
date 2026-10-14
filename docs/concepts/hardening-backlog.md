# The hardening backlog

What production-ready means for a learning project with one user, itemised.

Decisions are in [0040](../adr/0040-security-headers.md) through
[0044](../adr/0044-cost-ceilings.md). Vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md).

---

## What this document is for

The map's destination is a spec, not an app. So this is not a list of things to build — it is a list
of things a builder will find **missing**, with the reason each one is missing written down next to
it. Every ADR in this repo ends with *what would reverse this*; this is the same discipline applied
to the gaps between the ADRs and a running system.

The gap is deliberate in places. A rate limiter is noise at one user, and a missing one teaches
nothing until it is missing. The point is not to build the hardening. **The point is that no omission
is silent.** Every row below says what breaks without it.

### Provenance, stated plainly

The first round of this ticket — threat model, backups, account deletion, rate limits — was a live
exchange with the operator, and those four decisions carry their authority. **Everything decided in
the second round was taken under delegated batch authority, without the operator in the room**, and
is marked *proposed* where it goes beyond settling a question the operator asked. One item in
particular — invite-only signup, **H-19** — is the author's judgement, not a decision anybody made in
conversation, and it needs one word from the operator.

**This ticket ran in parallel with the auth and profile tickets**, and four of their decisions landed
in the same space. Those were reconciled rather than duplicated, and the reconciliation is recorded
here so a reader does not find two ADRs quietly disagreeing:

- **Export, and what "your data" means**, are owned by
  [`0022`](../adr/0022-settings-boundary-and-transports.md). This document carries the backlog row and
  flags one boundary worth a second opinion.
- **The deletion mechanism** is owned by [`0041`](../adr/0041-erasure-is-a-tombstone.md), scoped
  deliberately to the transaction and the two obligations that are not code. `0022` defers to it.
- **The handle reservation** is owned by the auth and profile tickets. `0041` decides only that
  erasure must not bypass it.
- **The auth rate limiter** is owned by [`0043`](../adr/0043-rate-limits.md) and adopted by
  [`0018`](../adr/0018-socket-is-a-lease.md), which owns the `trustedProxies` hand-off — the one-line
  configuration that decides whether a per-IP limit is a limit at all.

---

## The two gates

The gates are **events, not dates**, because a calendar cannot tell you whether you have arrived.

### Gate 1 — before a second user exists

**Trigger: anyone who is not the operator attempts to sign in.** Not when you feel ready. The moment
public signup is reachable by a stranger, everything in Gate 1 is either in place or is a problem.

Rationale for the gate being this early: almost nothing here is about defending against an adversary.
It is about **the second user being a real person who did not agree to be a test subject** — someone
who will send you a photo you do not want, and whose photo will be re-encoded, stored, and served to
other browsers.

### Gate 2 — before a thousand

**Trigger: a thousand registered users, or a public listing, whichever comes first.**

Rationale for the gate being this late: the work here is either *operational* (somebody has to read
a queue, decide, and act) or *unmeasurable until it exists* (the real send rate, the real read
volume). Building either before it is needed produces a guess that has to be thrown away, and this
repo has already retracted one guess for exactly this reason in
[0010](../adr/0010-receipt-mechanics.md).

**Owners.** *Builder* is whoever implements the handoff. *Operator* is the human — and the distinction
matters, because about a third of Gate 1 is configuration and runbook work against an account that
only they have access to, and none of it is code.

**Sizes.** XS ≤ 2 h · S = half a day · M = 1 day · L = 2–3 days. Exclude review and deployment.

---

## Gate 1 — before a second user exists

| | item | owner | size | why this gate |
|---|---|---|---|---|
| H-01 | CSP on the app origin: nonce + `strict-dynamic`, **report-only for one week, then enforced** ([0040](../adr/0040-security-headers.md)) | Builder | M + S | A CSP can only be introduced on a codebase with no un-nonced inline script. Adding one later means auditing every inline script at once, under time pressure. |
| H-02 | The rest of the header set: HSTS **without `preload`**, `Referrer-Policy: no-referrer`, `Permissions-Policy` deny-all, COOP, XFO + `nosniff` | Builder | XS | Three of these are one line each; `preload` is the one that is a one-way door. |
| H-03 | Media origin: `Cross-Origin-Resource-Policy: same-site` + `nosniff`. **No CSP** — it does nothing on an image | Builder | XS | Shares the worker with the pipeline that already exists. |
| H-04 | Redis token-bucket limiter: send 30/min, auth 10/min per IP, search 60/min, presign 20/hour. Auth fails closed, everything else fails open ([0043](../adr/0043-rate-limits.md)) | Builder | M | Bounds the **email bill** before anyone exists, and turns a client retry bug into a degraded experience rather than a dead database. |
| H-05 | `DELETE /account` → tombstone. Handle reserved forever, nothing cascades, sessions and credentials deleted ([0041](../adr/0041-erasure-is-a-tombstone.md)) | Builder | M | A user who asks to leave and cannot is the sharpest possible first impression. |
| H-06 | Runbook: notify every current member of an erased user's conversations, and instruct other controllers. Delete pre-erasure dumps on the next backup run | **Operator** | S | The ICO obligation is **a person, not a function**. Acceptable at one user; not at two. |
| H-07 | Nightly `pg_dump` → R2, direct unpooled endpoint, 30-day lifecycle, external cron ([0042](../adr/0042-backups.md)) | Builder | S | — |
| H-08 | **Perform a restore into a scratch project. Time it. Record what was missing.** | Builder | S | **Hard gate. The backup does not exist until this is done.** The thing it discovers — that a database restore contains rows and no bytes — is cheaper to discover now than after losing a bucket. |
| H-09 | R2 object versioning on the media bucket | **Operator** | XS | Makes a deleted object recoverable, and makes the "beyond use" claim in [0041](../adr/0041-erasure-is-a-tombstone.md) honest rather than notional. |
| H-10 | R2 lifecycle rule: abort incomplete multipart uploads after 1 day | **Operator** | XS | Every abandoned part is a billable Class A operation that sits forever. Aborting is free; doing it late is not. |
| H-11 | **Rotate the auth secret after every restore** — written into the restore runbook | Builder | XS | A restore resurrects every revoked session. Without this, a restore is a session-revocation bypass with a timestamp on it. |
| H-12 | Five Neon consumption quotas + `autoscaling_limit_max_cu = 1`, in a version-controlled file ([0044](../adr/0044-cost-ceilings.md)) | **Operator** | S | The ceilings only exist once someone chose the integers. A cap living in a console is a cap the next person cannot see. |
| H-13 | Daily consumed-vs-quota poll, alert at 50% | **Operator** | XS | A quota suspension is **persistent until the next billing period** and does not restart on reconnect. Without the alert, a cap is a coin flip. |
| H-14 | Storage HUD: Postgres bytes per branch, R2 object count and bytes | Builder | S | Not a convenience. Neon Free's 1 GB **blocks writes with no application error**, and `logical_size_bytes` suspends the branch. Neither is visible without looking. |
| H-15 | Structured JSON logs with a `request_id` propagated app → realtime, and a redaction list (`body`, `password`, `token`, `authorization`) | Builder | S | The thing every other signal depends on. Logs are the only place a *sequence* of events is visible; a metric cannot tell you what happened. |
| H-16 | `/health` that actually checks Neon, Redis and R2, and reveals nothing (no version, no hostnames, unauthenticated) | Builder | S | A liveness ping returns 200 while the database is suspended. A dependency check returns 503, which is the difference between a red light and a mystery. |
| H-17 | Five numbers on one screen (below) | Builder | S | Each maps to a specific failure this system can actually have. |
| H-18 | Outbox purge: delete on successful fan-out; failed rows retained 24 h then purged | Builder | S | The outbox is the only table whose growth is unbounded and whose rows stop being useful the moment they work. |
| H-19 | **Invite-only signup** — *proposed, not decided* | **Operator** | XS | The origin has to be public (PWA + Web Push force HTTPS and a public hostname), but **nothing forces signup to be open**. This is the cheapest abuse control that exists and it closes the ticket's own question — *does the design assume a public deployment?* — with "the origin yes, the door no." |
| H-20 | **Report-a-message and a moderation queue** — deferred *by decision* in round 1, unblocked at this gate | **Operator** + named owner | L | Round 1 set the trigger for reopening moderation at the first second user. So it sits here, deliberately unbuilt, with an owner. **A report button nobody reads is worse than no button** — it manufactures a false sense of moderation. |
| H-21 | Move to Neon Launch (~$1/month) for scheduled snapshots and a 7-day history window | **Operator** | XS | The only item on this list that costs money before it must. It buys the "bad migration forty minutes ago" recovery that no nightly dump can provide. |
| H-22 | On-demand export: one authenticated endpoint returning JSON of profile, memberships, **the messages you authored**, receipts, session metadata and settings | Builder | M | **Scope already settled** by [`0022`](../adr/0022-settings-boundary-and-transports.md) — export ships in v1. Listed here so it is not lost between tickets. |

**Gate 1 total: ≈ 10–11 days of work.** Four of those days are H-08 (the restore rehearsal), and that
ratio is the honest finding: **the backlog is mostly verification, not construction.**

---

## Gate 2 — before a thousand

| | item | owner | size | why this gate |
|---|---|---|---|---|
| H-23 | Replace the rate-limit table with measured rates | Builder | S | Our numbers are judgment with stated reasoning. The only honest successor is real data. |
| H-24 | Abuse and cost dashboards: rejection rate per surface, Class B read volume against the 10 M free tier, branch count against 10 | Builder | S | Every one of these crosses a threshold where the cost curve jumps ([0044](../adr/0044-cost-ceilings.md)). |
| H-25 | Per-conversation moderation actions that are not "block": the operator can remove a message without deleting the row | Builder + Operator | M | Block already exists ([0007](../adr/0007-conversation-model.md)); **removal of content is what moderation actually needs**, and it needs a second operator to be anything but theatre. |
| H-26 | A real restore RPO, from a continuous backup rather than nightly | Builder | L | Nightly is correct at this scale and wrong at a thousand. Requires migration discipline — every DDL applied twice — which is ongoing cost for a benefit nobody needs yet. |
| H-27 | **Decide what E2EE costs, before proposing it** — see below | Operator | S | This is the one fog item with a concrete price attached, and the price lands on two settled decisions. |

---

## Observability: the minimum

The question was *what would you look at to know the system is healthy*. The minimum that answers it
is **five numbers, one endpoint, one request id, one error sink** — and one deliberate absence.

### The five numbers

| number | catches | why it is on this list |
|---|---|---|
| **Outbox lag** — age of the oldest undelivered outbox row | The [0004](../adr/0004-message-durability.md) failure: a message that is durable but was never delivered | **Nobody sees this. It is the defining failure of this architecture and it is invisible from the outside** — a member would simply report "she didn't get my message," which is unreproducible and arrives days later. |
| **Rate-limiter rejections per action** | A limit tuned too tight, and a client loop | A limiter that works perfectly and eats real sends produces no error anywhere. It just looks like a flaky network. |
| **Media rows past their TTL in a non-terminal state** | The worker dying without writing `failed` | [0008](../adr/0008-media-pipeline.md) already requires a terminal state. This is the metric that proves the requirement is being met. |
| **Quota consumed ÷ quota, per metric** | Approaching a ceiling that will suspend the project until the month ends | [0044](../adr/0044-cost-ceilings.md). This is the cost control and the reliability control being the same control. |
| **Send-queue depth, reported by the client** | An offline queue that never flushes | **The only signal that works when the failure is entirely client-side.** A browser with a stuck queue sends nothing, so every server-side number is silent and correct. One extra field on a request the client already makes. |

### The endpoint

`/health` checks Neon (`SELECT 1`), Redis (`PING`) and R2 (a `HEAD` on the bucket) and returns 200
or 503 with per-dependency detail. **It is a dependency check, not a liveness ping** — a liveness
ping returns 200 from a process whose database is suspended, which is precisely the failure mode that
has no other signal.

It is unauthenticated, so it reveals nothing: no version, no hostnames, no identifiers.

### The error sink

Unhandled exceptions and `unhandledRejection` in **both** server processes — the Node app and the Bun
realtime server — go to a free-tier tracker. The caveat that matters more than the choice of vendor:
a tracker will fire on every *expected* error (idempotency replays, rate-limited sends, blocked
sends) unless those are marked handled. **The value is in the unhandled ones**, and configuring that
is the whole task. If it is never configured, it is a wall of noise and worse than nothing.

### What is deliberately absent

**Distributed tracing.** Two processes, a handful of service boundaries, and a `request_id` in the
logs gets most of the value at a fraction of the cost. If the service count ever grows past about
five, revisit.

---

## Abuse and moderation

Round 1 settled the posture: single operator, reachable on the internet, **abuse and moderation
deferred with a named owner**, trigger for reopening is the first second user. That stands. What
follows is the elaboration, not a reopening.

**In v1, already decided elsewhere:**

- **Blocking**, with teeth — A can no longer send to B, and silent drops are declined
  ([0007](../adr/0007-conversation-model.md)).
- **Rate limits** on all four surfaces, keyed on user identity ([0043](../adr/0043-rate-limits.md)).
- **Verified email at signup.** Email is already mandatory ([0001](../adr/0001-self-hosted-better-auth.md));
  *verified* is a stronger gate and costs one email. It is the single cheapest anti-impersonation and
  anti-spam control available, and it is the reason a public signup form is survivable at all.
- **Invite-only signup** (H-19), proposed above.
- **The upload trust boundary** — the raw upload is never served ([0008](../adr/0008-media-pipeline.md)).

**Deferred, with an owner, at Gate 1:** report-a-message, the moderation queue, and any content
removal that is not a block (H-20, H-25).

**No automatic message retention.** A policy that deletes messages after N days is in direct conflict
with [0003](../adr/0003-receipt-watermark.md) — receipts are positions in a transcript, and a
truncated transcript makes a position meaningless — and with the glossary's promise that a former
member's messages survive. **Media is the only thing with a deletion policy**, because it is the only
thing whose bytes are separable from its references.

---

## Data retention and export

### Retention, per table

| data | where | retained | decided in |
|---|---|---|---|
| Messages | `messages` | Life of the conversation. **Never auto-deleted** | [0003](../adr/0003-receipt-watermark.md) |
| Attachments | R2 | Life of the referencing message. Avatar and orphans purged on schedule | [0008](../adr/0008-media-pipeline.md) |
| Receipts | `receipt` | Life of the membership. **Survives leaving** | [0003](../adr/0003-receipt-watermark.md) |
| Delivery | `delivery` | Life of the membership | [0004](../adr/0004-message-durability.md) |
| **Outbox rows** | `outbox` | **Deleted on successful fan-out. Failed rows: 24 h, then purged** | this document |
| Presence | Redis | 45 s TTL. Nothing to retain | [0006](../adr/0006-presence.md) |
| Typing | nowhere | **Never stored** | [0006](../adr/0006-presence.md) |
| Sessions | `session` | Better Auth default. Deleted immediately on erasure | [0041](../adr/0041-erasure-is-a-tombstone.md) |
| Credentials | `account` | Life of the account | [0001](../adr/0001-self-hosted-better-auth.md) |
| Verification rows | `verification` | Expire on their own. Deleted on erasure | [0041](../adr/0041-erasure-is-a-tombstone.md) |
| Tombstones | `user` | **Forever** | [0041](../adr/0041-erasure-is-a-tombstone.md) |
| Rate-limit counters | Redis | ≤ the longest window in use (1 h) | [0043](../adr/0043-rate-limits.md) |
| Backups | R2 | 30 days, minus any pre-erasure dumps | [0042](../adr/0042-backups.md) |
| Logs | wherever | 30 days | this document |

The outbox is the only new rule here and it needs one sentence of justification: the outbox is the
**durable record of sends not yet delivered**, so the moment a send *is* delivered the row has done
its job. Keeping it forever is unbounded growth for a table whose contents stop being true. Deleting
it is safe because catch-up is keyed on `messages.seq`, not on the outbox
([0005](../adr/0005-message-ordering.md)). 24 hours of failed rows is enough to notice a systematic
failure and short enough not to be a second database.

### Export is nearly free, and here is why

**The scope is not this document's to set.** [`0022`](../adr/0022-settings-boundary-and-transports.md)
settles what "your data" means and what export contains; this section records only the shape of the
implementation and the one thing that makes it cheap.

One exported function, `export_user(...)`, returning JSON — **the same pattern as
[0009](../adr/0009-message-search.md)'s search function, for the same reason.** Swapping the format
later is one function rather than a rewrite of every caller, and the access rules live in exactly one
place instead of two that drift.

Two boundaries from `0022` are worth restating because they are the easy mistakes: **the `session`
row's `userAgent` and `ipAddress` are included and its `token` is not** — a bearer credential in a
downloadable file is a leaked credential — and **Credentials are excluded entirely**, because the
glossary says a Credential "is never rendered" and an export is a rendering.

**The reason this is cheap is that vartalap stores plaintext on a server it controls.** That is not
an accident to be proud of; it is a decision that makes GDPR export, server-side search, and
server-side moderation all fall out of the same query layer. The price is paid on the other side of
the ledger, and it is the next section.

**One line on scope, flagged rather than silently overridden.** `0022` exports the messages a member
**authored**, not every message in conversations they were a member of. The reading is coherent — the
transcript belongs to the conversation, not to one participant, and the member holds it anyway — but
it is a narrower promise than "your data" suggests to a person who was in a group for a year.
Whoever implements H-22 should know it was considered rather than overlooked.

### What E2EE costs, now that it can be priced

The map lists end-to-end encryption as fog and says *"the schema should not foreclose it."* This
ticket can make that concrete, because two settled decisions are in the blast radius:

1. **Server-side search stops working.** [0009](../adr/0009-message-search.md) stores a generated
   `tsvector` over `messages.body` and indexes it with GIN. **A `tsvector` cannot be built from
   ciphertext.** E2EE does not make search expensive; it makes server-side search *impossible*
   without a second index of searchable plaintext — which is the entire privacy guarantee, stored in
   a column, defeating the purpose.
2. **Export moves to the client.** [0041](../adr/0041-erasure-is-a-tombstone.md)'s tombstone keeps
   message bodies that the server can read. Under E2EE the server can export metadata and nothing
   more; a member exporting their own history means a client-side decrypt over what it happens to
   hold, which is not the same promise for a member who has since reinstalled.

So "don't foreclose E2EE" concretely requires: `messages.body` as an opaque column (cheap — it
already is), **and** accepting that search becomes client-side, and **and** accepting that export
becomes partial. The third is the one that hurts, and it is the reason this belongs at Gate 2 as an
explicit decision with an owner rather than a fog line.

---

## Deliberately not doing

| not doing | why |
|---|---|
| Cloudflare's canned security-header rules | Ship two deprecated headers and no CSP. See [0040](../adr/0040-security-headers.md). |
| CDN caching of app HTML | The per-request nonce forbids it. Assets stay cached; the shell is a fraction of the bytes. |
| `Cross-Origin-Embedder-Policy` | Buys `SharedArrayBuffer`, which nothing uses; costs a cross-origin check per asset. Revisit with WASM threads. |
| HSTS `preload` | One-way door. Not until every hostname under the registrable domain is HTTPS-only, forever. |
| Postgres RLS | Settled in [0007](../adr/0007-conversation-model.md) — defence in depth here means two implementations of one rule, and the client copy is the one that drifts. |
| Cloudflare WAF managed rules | No hostile traffic to filter yet, and they cost a request. Revisit at Gate 2 with something to filter. |
| Distributed tracing | `request_id` gets most of it at two processes. |
| Automatic message deletion | Incompatible with the watermark model and the glossary's promise about former members. |
| Hard-deleting tombstones | Would require messages to point at a table of ids instead of users. Worth it at a real user population, or on instruction from a regulator. |

---

## Open, and not yet verified

Carried forward rather than quietly settled:

- **Whether Neon's 6-hour history on Free is the same feature as Instant restore.** The pricing table
  lists Instant restore as unavailable on Free while the history window is listed at 6 hours. If PITR
  is genuinely unavailable on Free, the "recent mistakes" half of the backup story depends entirely on
  H-21. **Check before relying on either.**
- **The restore rehearsal has not happened.** H-08 is a gate, not a task. Every claim in
  [0042](../adr/0042-backups.md) about restore behaviour is a claim about documented semantics, not a
  measurement.
- **What `written_data_bytes` actually counts** — heap bytes, WAL bytes, or both. It is set to 20 GiB
  with roughly 300× headroom over expected traffic, so the ambiguity does not bite now. It might.
- **The four rate-limit numbers are judgment.** Stated as chosen values with reasoning, not as
  derived ones. H-23 replaces them with measurements.
- **The application framework is not pinned.** The header module in [0040](../adr/0040-security-headers.md)
  must not depend on one, and whichever framework lands must be able to read a request-scoped nonce.
  This is the most likely thing to break H-01.