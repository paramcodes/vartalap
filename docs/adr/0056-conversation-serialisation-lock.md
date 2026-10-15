# 0056. The conversation lock is derived in SQL, and the `::text` cast is the part that matters

**Status:** Accepted
**Date:** 2026-10-15
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Build the spine first" — the advisory lock's `int64` derivation, left as the literal placeholder `<int64 derived from conversation_id>` by [0005](0005-message-ordering.md)
**Extends:** [0005](0005-message-ordering.md), which settled serialisation but not the key
**Feeds:** the send path (stage 3.C) and gate G1a, which asserts the derivation rather than a value
**Teaches:** [`docs/concepts/message-ordering.md`](../concepts/message-ordering.md)
**Evidence:** executed against this machine's PGlite (PostgreSQL 18.6). Every number below is measured, not recalled.

## Context

Five documents write the send path's opening line and all five leave a hole in it:

```sql
SELECT pg_advisory_xact_lock(<int64 derived from conversation_id>);
```

ADR 0005, [`message-ordering.md`](../concepts/message-ordering.md), [`roadmap.md`](../concepts/roadmap.md), and `schema.ts` itself. The placeholder survived because the *guarantee* was settled — within a conversation, commit order equals `seq` order — and the key derivation reads like an implementation detail of a line that already has a decision attached to it.

It is not a detail. **The derivation is the identity of the lock.** Two properties are load-bearing and both are properties of the derivation, not of the call:

1. One conversation must always produce the **same** key.
2. Two conversations must produce **different** keys.

Get either wrong and ADR 0005's guarantee is gone with no error anywhere. So this has to be a decision with a number in it, and the number has to have been run.

## Decision

```sql
BEGIN;
  SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 8530225013392695664));
  INSERT INTO message    (id, conversation_id, author_id, body, client_created_at) VALUES (...);
  INSERT INTO outbox     (message_seq, conversation_id, payload) VALUES (...);
COMMIT;
```

The seed is **`8530225013392695664`**, which is `0x76617274616C6170`, which is ASCII `vartalap`. Verified in-database: `('x' || encode('vartalap'::bytea,'hex'))::bit(64)::bigint = 0x76617274616C6170` is `true`. The constant is legible on purpose — a reader who has never seen this ADR can still tell at a glance that the number belongs to us and is not a hash someone copied out of another project.

### The function

`hashtextextended(text, bigint) → bigint`. Confirmed present in `pg_catalog` on PostgreSQL 18.6 with `provolatile = 'i'` (**IMMUTABLE**) and `proisstrict = true`.

`hashtext` is not the choice. It returns `integer` — measured, `hashtext('abc')` is `-785388649` — so a 32-bit key. The birthday bound reaches 50% at roughly 2^16 conversations, and vartalap will pass that. Widening a 32-bit hash to 64 bits afterwards buys zero extra bits; the entropy is already gone, and the widening is where sign-extension bugs live. The seed argument is precisely what makes this the 64-bit function rather than a widened `hashtext`.

### Why in SQL, and not in JavaScript

Three reasons, and the third is the one that would have bitten us.

**A JavaScript hash is a second implementation of a function that already exists inside the server.** It would have to reproduce `hashtextextended`'s exact output bit for bit. The moment it does not, two code paths take two different locks for one conversation, silently — because nothing anywhere compares a JavaScript-derived key with a SQL-derived one, and no test asserts the equality. ADR 0005 already records that this line is "the kind of thing a well-meaning refactor deletes"; a second copy of the derivation is a second line of the same kind, with the same failure mode and less visibility.

**The expression belongs inside the lock statement.** Computing it in JavaScript and binding the result means the value crosses the driver, and gate G1a — which exists precisely because ADR 0005 recorded that this lock "carries no comment of its own **and no test**" — would end up asserting a statement that no longer contains the derivation. The test would still pass while checking something weaker.

**And the cast is not a cast. It is the normalisation, and hashing the raw string breaks the guarantee.**

PostgreSQL's `uuid` input accepts four spellings of the same value and its `::text` output is one canonical lowercase hyphenated form. Hash whatever the client sent and those four spellings are four different locks. Measured on this machine:

| what was hashed | lock key for `A1B2C3D4-E5F6-47A8-9B0C-1D2E3F405162` |
|---|---|
| `'…'::uuid::text` (canonical) | `9066591240603247267` |
| the same UUID, lowercase | `9066591240603247267` |
| the same UUID, **uppercase** | `8524694820592140863` |
| the same UUID, **no dashes** | `4657951911570372232` |
| the same UUID, **braced** | `-656177458958907693` |

Four distinct keys for one conversation. A member whose client sends the uppercase spelling and another member whose client sends the lowercase spelling take **different locks**, their sends commit concurrently, and ADR 0005's race is back — with no error, no log line, and no gap the client can detect. That is not a theoretical hardening item. It is one `.toUpperCase()` in a request builder away, and it is only preventable by deriving after the `uuid` type has normalised the input, which means deriving in SQL.

### What the value's sign means

The result is a **signed** 64-bit integer and roughly half of them are negative: measured, **9,952 of 20,000** inputs hashed negative with this seed, spanning `-9223288586109104403` to `9223314247095996060` across 20,000 inputs with no duplicates.

`pg_advisory_xact_lock(bigint)` takes negative keys without complaint — verified by locking a conversation whose key hashes negative, inside a real transaction, and committing. So there is nothing to mask and nothing to normalise, and no `& 0x7FFF_FFFF_FFFF_FFFF` appears anywhere in this design. It is recorded because a JavaScript reimplementation using `Number` rather than `BigInt` would silently lose the low bits at exactly this magnitude, and would do so on half the conversations.

### Collision with another conversation

**Cannot be proven absent, and does not need to be.** Two claims, and they are different in kind.

*Measured:* 200,000 distinct UUIDs hashed with this seed produced **200,000 distinct keys — zero collisions**. That is evidence about the function's distribution, not a proof about any future set of conversation ids.

*Argued:* a collision is **not a correctness failure**. Two conversations sharing a key means a send into one waits for a send into the other. That is exactly the shape ADR 0005 already declares harmless — cross-conversation serialisation costs throughput and never ordering, because a client paging conversation B backwards never encounters conversation A's `seq`. **This is the one invariant in ADR 0005 that keeps holding when the hash is imperfect**, and it is why the hash can be a hash at all. A collision-free derivation was never available; benign collisions were the design goal.

### Collision with another advisory-lock user in the same database

This one *would* matter — an unrelated lock could block a send — so it gets a real answer rather than a shrug.

**Nobody takes an advisory lock in this database today.** ADR [0043](0043-rate-limits.md) contemplates "Postgres advisory locks plus a row per user" only as a fallback for a system with no Redis; vartalap has Redis, and that ADR already flags sharing the store as "a coupling worth noticing even if it is convenient". When it is built it will be keyed on user id, and it cannot reuse this derivation by accident because the derivation is one expression written down here and nowhere else.

**The escape hatch needs no argument at all.** PostgreSQL's advisory-lock functions are documented as identifying resources "either by a single 64-bit key value or two 32-bit key values (**note that these two key spaces do not overlap**)". Both overloads exist — confirmed in the catalog on this machine:

```
pg_advisory_xact_lock(bigint)              → void
pg_advisory_xact_lock(integer, integer)    → void
```

So a second advisory-lock user that cannot choose its derivation takes the **two-argument form** and provably cannot collide with this one. We hold the one-argument space; the other form is reserved and stays that way.

That last claim is documentation, not measurement. It could not be executed here: PGlite serves one connection, so there is no second session to contend with, and `docs/plans/stage-3.md` already records that a test which "passes" on PGlite has proved nothing about concurrency. The key-space statement is quoted from PostgreSQL 18 §9.28.10 rather than claimed as observed.

## Consequences

- **The placeholder is gone from all five documents, and the lock is now a line that can be grepped.** `hashtextextended(conversation_id::text, 8530225013392695664)` appears in `packages/database/src/schema.ts` next to the guarantee it carries. A future reader who deletes it is deleting something identifiable, not something anonymous.
- **G1a becomes possible.** Asserting "the send path issues `pg_advisory_xact_lock` with the documented derivation, inside the transaction that inserts the message, before the insert" requires a derivation to be documented. That is the test ADR 0005 says does not exist.
- **Changing the seed is a compatibility break in the other direction, and it is safe.** Every conversation's key changes, so a deploy mid-flight has old and new code taking different locks for the same conversation. There is no overlap window to reason about at this scale — a rolling deploy on a single-user system — but it is a migration-shaped change, not a refactor, and should be written down when it happens.
- **One expression, one place, one number.** There is no JavaScript constant to keep in step with the SQL, and no build step that could produce a different one on a different platform. `BigInt` serialisation does not enter the design at all.
- **`hashtextextended` is IMMUTABLE, so the planner may fold it.** With a bound parameter it is not folded, which is the case that matters. With a literal it becomes a constant at plan time, which is harmless.

## What would reverse this

**A hash collision that costs something real.** The argument above says a conversation-to-conversation collision is throughput-only. That holds because nothing *reads* the lock's identity. The first design that makes the lock key observable — a debugging view, a `pg_locks` dashboard, a "why is this send slow" query that maps a held lock back to a conversation id — turns the key from opaque to load-bearing, and at that point a collision is a wrong answer rather than a slow one. That design should store the key, not recompute it.

**A hash function that is not seeded, or a seed that changes per connection.** `hashtextextended` is IMMUTABLE, verified, so this cannot happen from the database side. It can happen from ours: anything that interpolates the seed from configuration rather than from the literal turns a constant into a deployment difference, and the first two environments to disagree serialise nothing.

**Two genuinely concurrent relays or send-paths needing the same conversation lock from different databases.** Advisory locks do not cross databases, and this decision is silent about that because nothing in vartalap needs it to be otherwise. The moment a second database holds message rows for the same conversation — a shard, a read replica with writes, an archive that is still accepting sends — the guarantee is per-database and the lock has to move up a layer.