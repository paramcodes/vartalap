# 0054. Build the durable spine before any surface

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Roadmap sequencing: what gets built in what order"
**Teaches:** [`docs/concepts/roadmap.md`](../concepts/roadmap.md)

## Context

Eighteen tickets produced twenty-four ADRs and twelve concept documents. They are individually
sound and, taken together, they impose an order that none of them states.

The pressure pushing against that order is familiar and reasonable: nothing is visible until
something renders, and a project with no visible progress for two weeks is a project that gets
quietly abandoned.

That pressure is what this ADR exists to refuse, for a specific reason.

## Decision

**The durable spine is built and proven before any interface is written.**

Concretely, in this order:

1. Groundwork — monorepo, schema, `packages/protocol`
2. Identity — Better Auth, handle reservation, sessions
3. **The spine** — ordering, optimistic send, dedupe, outbox, receive, pagination, reconnect
4. Reading and liveness — receipts, delivery, presence, typing
5. Conversations — the direct-pair race, blocks, leaving
6. A **thin** interface over what exists
7. Media, push, search
8. Hardening, Gate 1

## Why

**The spine is the part that is expensive to change and invisible when it is wrong.**

Every interface decision downstream assumes it. The chat view renders a `seq`, shows "Seen" under
the last outgoing message, and merges an optimistic row whose position is `null` until an ack
arrives. If the send path turns out to need a different shape — because dedupe has to move, because
the position cannot be assigned in-transaction, because the client UUID cannot double as the
idempotency key — then every one of those assumptions is wrong, and they are wrong *in a component
that already exists and looks finished*.

Building the surface first means optimising against a contract that was never validated.

**There is a concrete precedent for the cost.** The advisory lock in
[0005](0005-message-ordering.md) is a single SQL line that eliminates the commit-inversion race. It
is also the kind of line a well-meaning refactor deletes, and the reason it is survivable is that
ADR 0005 paired it with an independent `COUNT(*)` reconciliation underneath. That pairing was a
deliberate decision made *because* the guarantee is carried by one line. This ADR is the same
instinct applied to the whole build.

**The alternative is not "build the UI first because it's easier".** It is that the UI is where the
unknowns get discovered, and discovering them against a real spine is cheap.

## Consequences

- **There is a real dry spell, and it is named here rather than discovered.** Stages 1–5 produce no
  interface. The mitigation is stage 6: a deliberately *thin* one, built on a proven spine, that
  omits media, push and search so that what remains is small enough to be correct.
- **Stage 3 is the one that must be right.** Everything before it is ordinary work. The ordering
  invariant, the monotonic upserts, the single receive write path and the cursor reconciliation are
  the four things worth building first and testing hardest inside it.
- **Hardening is last, and that is deliberate rather than lazy.** The
  [hardening backlog](../concepts/hardening-backlog.md) is 27 items and two gates. Gate 1 — "before a
  second user exists" — is ~10–11 days, of which **four are a single item**: performing a backup
  restore, timing it, and recording what was missing. That is the most valuable four days in the
  entire backlog and it is nearly free to do at one user, which is the only time it is free.
- **A demo is available from stage 6 onward, not before.** If the project needs to be demonstrable
  sooner than the spine is trustworthy, the honest response is to say the demo is running on an
  unproven contract — not to move the contract.
- **The one thing that would justify reordering is a change to a spine decision**, and by then the
  tickets that recorded it are closed and the reasoning is on file. That is the point.

## What would reverse this

**A second user.** Gate 1 of the hardening backlog is defined as "before a second user exists", and
everything in it — CSP, rate limits, account deletion, backups — is cheap at one user and awkward
later. Reaching for users before Gate 1 is closed means paying the hardening bill on someone else's
schedule.

**And a hard external deadline**, which this ADR cannot see from inside the repository. A dated
demonstration is a legitimate reason to build a thin surface over an unproven spine — provided
nobody then describes it as production-ready, which is the specific confusion this map's Notes
already forbid.