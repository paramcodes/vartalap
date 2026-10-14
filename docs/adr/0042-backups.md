# 0042. The backup is ours — a nightly `pg_dump` into R2 — and it does not exist until a restore has been timed

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "The hardening plan: what production-ready means for a learning project"
**Feeds:** [`docs/concepts/hardening-backlog.md`](../concepts/hardening-backlog.md)

## Context

The ticket's question was *"does the hosted Postgres offer them by default, and has anyone actually
restored one?"* The second half is the whole question. **"It has backups" and "we have restored a
backup" are different claims**, and only one of them is evidence.

The first half has an answer that contradicts the map's posture. Neon's Free plan lists **no
scheduled snapshots**; the automatic history is a 6-hour window with a 1 GB limit, and there is
exactly one manual snapshot. Scheduled snapshots are a Launch/Scale feature at $0.09/GB-month.
Free also cannot turn scale-to-zero off, which matters more than it first appears: **[a suspended
compute loses session state**, including advisory locks and `LISTEN`/`NOTIFY`, and `UNLOGGED` tables
are compute-local and do not survive it at all.

So "the hosted Postgres has backups" is not true on the plan we would start on.

## Decision

### A nightly `pg_dump` to R2 is the spine. It is portable, and portability is the whole point.

### It runs from a direct, unpooled connection, on an external scheduler

### Neon Launch is bought, for scheduled snapshots and a 7-day window — not instead of the dump

### **The backup does not exist until a restore has been performed and timed. That is a hard gate.**

## Why the unpooled connection is not a detail

`pg_dump` needs a session that holds a consistent snapshot for the length of the dump and issues
`SET` statements along the way. A transaction-pooling proxy can hand it a different backend
mid-dump, and PgBouncer's documented guidance is that `pg_dump` needs session-mode pooling for
exactly this reason. Neon's pooled endpoint is transaction-pooled.

The symptom of getting this wrong is not a clean error. It is an archive that fails halfway, or
that restores into a database missing the last few seconds of it. **A backup mechanism whose failure
mode is a quietly truncated archive is worse than no mechanism**, because it is believed in.

## Why an external scheduler

Neon suspends after 5 minutes and cannot be told not to. A cron inside the app would be a process
that has to stay warm on a schedule that exists only to keep it warm — a guaranteed-bill compute
whose sole purpose is to not be scaled to zero. GitHub Actions on a cron, or a Cloudflare Cron
Trigger, does the same work for free and starts from cold every time.

## The paid-plan re-consideration, resolved

The round-1 decision left this open on purpose: *"explicitly re-consider whether a paid Neon plan is
better given its scheduled backups."* It is, and the arithmetic is not close.

Neon's Launch plan is **pay-as-you-go with no monthly minimum**. At vartalap's actual scale — one
operator, roughly ten CU-hours a month, well under 100 MB of storage, egress inside the included
500 GB — Launch costs **about a dollar a month**. In exchange it buys:

| | Free | Launch |
|---|---|---|
| Scheduled snapshots | — | $0.09/GB-month |
| History window | 6 h | 7 days |
| Instant restore | — | $0.20/GB-month |
| Spending notifications | — | yes |

Roughly $0.01/month for a nightly snapshot of a database that fits in one object. **The argument
against is not cost, it is dependency**, and it is the reason both are kept.

## Two backups, two different jobs — do not collapse them

**Neon's scheduled snapshots** answer *"someone ran a bad migration forty minutes ago."* That is a
real, frequent, expensive mistake, it needs point-in-time recovery, and no amount of nightly dumps
helps. This is the job the paid plan is bought for.

**The `pg_dump` in R2** answers *"Neon is gone, or the account is locked, or the credentials are
rotated and nobody remembers where."* That is the disaster the vendor cannot help with, and it is the
only backup that survives leaving Neon — which is a migration we may want in v2, when we know more
about how this works than we do today.

**A backup you cannot restore without the vendor is not a backup; it is a subscription.** Keeping
both is cheap at this size and it means the restore rehearsal can be done against the dump, in a
scratch project, without anyone from Neon being involved.

## The gate: perform the restore, time it, and write down what is missing

Everything above is unverified until a restore has actually happened. The procedure, and the things
it will discover:

1. **Create a scratch Neon project.** Free tier, 72 hours is fine.
2. **Restore the most recent dump** into it and **time it, wall clock, from the R2 object to a
   queryable database.**
3. **Restore the media.** This is the step that will surprise, and it is the reason the rehearsal is
   a gate rather than a checklist item: **`pg_dump` contains rows and no bytes.** The media rows
   come back; every attachment points at an R2 key whose object is not in the dump. A database
   restore on its own is **a restore of a broken application** — the transcript renders with holes
   in it. Decide here, with evidence in hand, whether media recovery is:
   - **R2 object versioning on** (chosen), which recovers a deleted or overwritten object if the
     bucket still has it, or
   - accepted loss, with a surfaced "attachment unavailable" state rather than a silent gap.
4. **Record the number.** A restore time is an operational fact with a ceiling attached — it is how
   much data loss any given RPO can actually cost — and it is the only number in this ADR that will
   change without anyone noticing.

## Traps in the restore path, all of them billing or availability shaped

**A restore creates a branch, and that branch bills.** Neon keeps the pre-restore state as a
`_old_{timestamp}` branch. It counts toward the branch allowance and its storage bills. Ten branches
are included — and **Free includes ten**, so a handful of restores silently exhausts the allowance
and blocks branch creation. **Delete the `_old_*` branch after every restore**, and check the branch
list monthly as part of the quota poll in [0044](0044-cost-ceilings.md).

**A `_old_*` branch restored from a root branch can be undeletable.** If a root branch was restored
from one of these, the leftover branch cannot be removed at all. This is a permanent-storage trap
and it is the reason the delete-after-restore step is written into the runbook rather than left to
judgement.

**A restore overwrites the whole branch, including the auth tables.** Because auth is self-hosted,
`user`, `session`, and `account` live in this same database and **are** in the dump. **Restoring
therefore resurrects every revoked session.** The runbook's next step after any restore is
**rotating the Better Auth secret**, which invalidates every session token at once. Without it, a
restore is a session-revocation bypass with a timestamp on it.

**Restores do not carry R2 objects.** See step 3 above. This is the one that costs users their
content, and it is invisible until the rehearsal.

## Consequences

- **The restore rehearsal is the deliverable; the dump is a prerequisite for it.** Shipping the cron
  without performing the restore produces a green checkmark over an untested assumption, which is
  the specific failure this ticket opened to prevent.
- **Media gets object versioning, and that has a second purpose.** It recovers a deleted object, and
  it is also what makes [0041](0041-erasure-is-a-tombstone.md)'s "beyond use" claim honest: object
  versions are visible, so they are a place a later erasure instruction has to reach.
- **RPO is one night for anything catastrophic, and minutes for anything recent** — the second only
  on a paid plan. That is the number to write down, not "we have backups".
- **The dump is a `pg_dump`, so restoring it is version-coupled.** A dump from PG 17 does not load
  into PG 16. Pin the major version, and keep a copy of the `pg_dump` binary alongside the dump
  rather than trusting whatever is on the restore machine.
- **Secrets are not in the dump.** R2 credentials, the Redis URL and the auth secret are environment
  configuration, so the restore runbook is as much a part of the backup as the dump is. It is
  written, and it is short.

## What breaks without this

The worst realistic outcome for vartalap is not losing data — it is **discovering the backup does not
restore, during the loss**. Postgres restore procedures fail on extensions, on enum types, on
`pg_dump` version drift, and on the schema objects people forget they have. Every one of those is a
twenty-minute fix *before* the incident and an afternoon *during* it. Since the app is publicly
reachable on the internet and holds other people's messages, "we would lose everything" is the answer
that has to be defensible.

## What would reverse this

**Logical replication to a second database** would give a genuinely continuous, restorable copy with
a small RPO, and it is the correct answer at a scale where nightly is too coarse. It costs a
continuous compute and a schema-migration discipline — every migration must be applied to the
replica too or replication breaks — which is real ongoing cost for a benefit that only matters above
roughly one hundred active users.

**Dropping the dump and keeping only vendor PITR** is the cheap version of this decision and it is
wrong for one reason: it makes leaving Neon a data-export project rather than a connection-string
change. The dump costs about half a day and a cron, and it is the thing that keeps every future
option open.