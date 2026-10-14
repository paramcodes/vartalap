# 0044. There is no dollar cap anywhere on this stack; the ceilings are five integers and two lifecycle rules

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "The hardening plan: what production-ready means for a learning project"
**Corrects:** the map's infra posture — *"Nothing bills without a hard cap"* — which is true on Neon Free and false the moment a plan changes
**Feeds:** [`docs/concepts/hardening-backlog.md`](../concepts/hardening-backlog.md)

## Context

The map states a posture: **nothing bills without a hard cap.** The ticket asked which services have
caps and what happens when one is hit.

The finding is that **the posture cannot be satisfied as written, on this stack, in dollars.** There
is no spend cap on Neon, and there is none on R2. What exists is a set of *resource* caps that
suspend rather than bill, plus two rounding cliffs that make the effective cost curve worse than the
headline rates suggest. So the honest form of the map's posture is:

> **Every billable thing has a resource ceiling someone chose, and the dollar ceiling is the sum of
> those choices — about four dollars a month per branch, not zero.**

This ADR records the ceilings, because "about four dollars a month" is only true if someone writes
down five integers. Without them the number is accidental.

## Decision

### Five Neon consumption quotas, set deliberately, on the production project

### `autoscaling_limit_max_cu = 1` on every endpoint — this is the hard ceiling on compute spend

### R2 is bounded by **bounding its inputs**, not by capping its meter

### A daily poll of consumed-vs-quota, alerting at 50%. **The alert is not the cap.**

## Neon: what actually stops you, and what only tells you

### The dollar cap does not exist

Neon's `spending_limit_cents` is a **notification**, not a stop: email at 80% and 100%, with the
documented behaviour that *"Projects continue to run, and charges continue to accumulate."* It is a
Launch/Scale feature, so **on Free there is neither a cap nor an alert** — Free is silent right up to
the moment it hard-stops.

### Free is a hard-budget plan, and that is the part worth knowing

Free's limits are real ceilings with real consequences, not warnings: running out of CU-hours or
egress **suspends compute until the next billing period**; exceeding 1 GB of Postgres storage per
project blocks writes; hitting 10 branches blocks branch creation. **None of them delete data**, and
*"Upgrade to lift any limit immediately"* — which is to say the entire cap structure is one click
away from not existing.

So on Free the plan **is** the cap, and the residual risk is not a bill, it is an upgrade.

### Paid plans: the five quotas

Set through `settings.quota` on the project, with these semantics:

| quota | scope | reset | chosen value | what it is for |
|---|---|---|---|---|
| `compute_time_seconds` | project | monthly | **86 400** (24 h) | the real compute ceiling |
| `active_time_seconds` | project | monthly | **604 800** (7 days) | backstop for a long-running low-CU workload |
| `written_data_bytes` | project | monthly | **21 474 836 480** (20 GiB) | write amplification runaway |
| `data_transfer_bytes` | project | monthly | **53 687 091 200** (50 GiB) | runaway only — see the trap |
| `logical_size_bytes` | **per branch** | **never** | **5 368 709 120** (5 GiB) | the only permanent storage stop |

Plus, per endpoint — these are not quotas and are configured separately:

| setting | value | why |
|---|---|---|
| `autoscaling_limit_max_cu` | **1** | the closest thing Neon offers to a hard cap on compute spend; Free would otherwise allow 2 |
| `suspend_timeout_seconds` | 300 | matches the Free default, stated rather than inherited |

### The four sharp edges, all of which will bite someone

**`0` means unlimited, and it is also how you un-suspend.** Setting a quota to `0` removes the limit
entirely, and is the documented way to reset a suspended project. So the number you type to say "no
cap" and the number you type to say "cap at zero" are the same character with opposite meanings.
**Never set a quota to `0` while trying to shut something off.**

**`logical_size_bytes` never resets.** It is the only quota that is not monthly, so it is the only
one that catches a workload growing slowly enough to stay under every monthly ceiling. It applies
**per branch**, so a project with five branches has five times the storage ceiling. Crossing it
suspends that branch only.

**`data_transfer_bytes` can block the operation that would save you.** Neon names this failure
directly: a cleanup that moves data across the network — *"for instance, to create an offsite backup
before deletion"* — can be prevented by the transfer quota. **That is [0042](0042-backups.md)'s
nightly dump, exactly.** Two controls meant to manage cost interfering with each other is the same
class of bug as Neon Managed Auth's Scale-to-Zero interaction in
[0001](0001-self-hosted-better-auth.md), so the transfer quota is set generously and treated as a
runaway catcher rather than a cost lever. Launch includes 500 GB of egress per project anyway; 50 GiB
trips long before the money does.

**Suspension is persistent and does not lift on reconnect.** When a quota trips, all active computes
suspend and **stay suspended until the next billing period** — explicitly not like scale-to-zero,
which restarts on the next interaction. The app is down, and no amount of retrying brings it back.
That is why the next section exists.

## The dollar ceiling, derived rather than hoped for

Neon Launch compute is **$0.106/CU-hour**, storage **$0.35/GB-month**.

- `compute_time_seconds = 86 400` → 24 CU-hours → **$2.54/month**
- `logical_size_bytes = 5 GiB` per branch → **$1.75/branch/month**
- egress → inside the 500 GB included → **$0**
- scheduled snapshots at ~100 MB → **~$0.01**

**≈ $4.30/month per branch.** A project with a production branch, a staging branch and a scratch
branch for [0042](0042-backups.md)'s restore rehearsal is about **$13/month**. These are ceilings, not
forecasts — the expected spend at vartalap's scale is a small fraction of them, which is the point of
a ceiling.

## The alert is not the cap, and it is the part that is easy to skip

Neon updates consumption metrics every 15 minutes with **up to an hour of reporting lag**, and they
reset monthly. A daily read of each metric against its quota, alerting at 50%, is early enough to
act and cheap enough to run from a cron.

This exists because of the suspension semantics above. **A cap with no readout is a coin flip:** it
either never trips, or it trips at 3am on the 28th and the app is down for three days. The alert
does not replace the cap — nothing does — it is the only thing standing between a hard stop and an
outage.

## R2: no cap, so bound the inputs

R2 has no spend cap and no spend alert that would be useful here. What it has is free egress, and the
pricing shape is worth stating precisely because it is not "free":

| | rate | free tier |
|---|---|---|
| Storage (Standard) | $0.015 / GB-month | 10 GB-month |
| Class A operations | $4.50 / million | 1 million |
| Class B operations | $0.36 / million | 10 million |
| Egress | free | — |

Three facts that change the plan:

**Free egress is not free reads.** [0008](0008-media-pipeline.md) chose R2 for egress, and that
choice stands — egress genuinely is free, including via the Workers API, the S3 API and `r2.dev`
domains. But every thumbnail the browser fetches is a **Class B operation**, billed after the first
ten million. A busy conversation replays hundreds of thumbnail URLs per user per session, so ten
million reads is roughly ten thousand heavy sessions. The free benefit is narrower than the phrase
"free egress" suggests, and this is the line item to watch as usage grows.

**Two operations are free and they are exactly the ones that bound cost.** `DeleteObject` and
`AbortMultipartUpload` cost nothing. **The purge from [0008](0008-media-pipeline.md) and the
lifecycle rule are therefore free**, and the whole cost-control story for R2 is that a defence which
deletes is free while a defence which refuses is not.

**Billing rounds up to the next unit, in blocks.** *"If you have performed one million and one
operations, you will be billed for two million operations."* And storage: 1.1 GB-month bills as 2.
**Crossing a free-tier boundary by a single request costs a full unit of the tier above it** — one
operation too many is $4.50, and 0.1 GB over is another $0.015 that keeps charging all month. Any
cost projection for R2 has to be written with the ceilings at the next block, not at the boundary.

The controls, none of which is a cap:

- **The worker's 10 MB rejection**, from [0043](0043-rate-limits.md), followed by the delete. Free.
- **A lifecycle rule aborting incomplete multipart uploads after one day.** An abandoned multipart
  upload has already spent `CreateMultipartUpload` plus one Class A operation **per part** — parts are
  5 MB to 5 GB — and those parts sit there billing storage. Aborting is free; doing it late is not.
- **The scheduled orphan purge.** Free, and already required by
  [0008](0008-media-pipeline.md) for correctness reasons, so cost control is a side effect of a
  process that has to exist anyway.
- **20 presigns per hour per user**, from [0043](0043-rate-limits.md). One image is roughly four
  Class A operations, so the free tier's million is about 250 000 images — not the binding
  constraint. Storage is.

## Email: the only meter an outsider can run up

Self-hosting Better Auth means `sendVerificationEmail` and `sendResetPassword` are ours, on a public
endpoint, and both send a real email to a real provider. **The 10/min-per-IP auth limit in
[0043](0043-rate-limits.md) is the only thing bounding that bill**, and no provider hard-caps
transactional email at our scale.

## Consequences

- **The ceilings are seven integers in one place**, and that place is a version-controlled file, not
  a console. A cap that lives in a web UI is a cap the next person cannot see.
- **`logical_size_bytes` is the only permanent one, so it is the one that matters most.** Neon's
  storage is otherwise unbounded on paid plans — *"there's no hard per-branch size limit and your
  storage grows with your usage"* — so this number is the only thing between a runaway write loop and
  an unbounded storage bill. It is also the number that will be hit first in practice, which is
  exactly why the storage HUD exists in the backlog.
- **The storage HUD is a cost control, not a developer convenience.** Two separate ceilings bite
  silently: Neon Free's 1 GB per project **blocks writes with no error in the application**, and
  `logical_size_bytes` suspends the branch. Neither is visible without looking.
- **Free is genuinely free and genuinely capped**, so the honest v1 answer is to start on Free, set
  quotas anyway so the numbers are written down before they are needed, and move to Launch only when
  [0042](0042-backups.md)'s scheduled snapshots justify it.
- **The quota poll doubles as the backup-health check**, since it reads the same project object.

## What breaks without this

Not a runaway bill — a **silent outage**. The most likely failure by a wide margin is a quota or a
free-tier boundary tripping with nobody watching: writes blocked on Free's 1 GB with no error in the
app, a suspended branch that does not restart until the month rolls over, a media bucket that rounds
over a storage boundary and quietly bills all month. Every one of these looks exactly like a bug in
vartalap, and none of them is. **That is the real reason this is an ADR: the cost controls and the
reliability controls are the same controls, and the map only asked about one of them.**

## What would reverse this

**A paid plan with a real budget cap.** Neon's own comparison page now leads with "cap your maximum
monthly spend", which reads like a dollar cap and is not — it is a link to per-project consumption
quotas, exactly as described here. A provider that hard-stops at a dollar figure would let the
map's original posture be satisfied literally, and would make most of this ADR deletable.

**A self-hosted Postgres on a VM with a billing alert at a hard threshold.** This is the version that
actually delivers a dollar ceiling, and it trades away the thing [0042](0042-backups.md) depends on:
branching, point-in-time restore, and scale-to-zero for pennies. It is a legitimate answer at a scale
where $13/month is worth avoiding, and it is not one now.