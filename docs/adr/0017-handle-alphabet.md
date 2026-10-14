# 0017. The handle alphabet is `[a-z0-9_]`, and the uniqueness index pins its collation

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Auth, onboarding and identity spec"
**Builds on:** [0001](0001-self-hosted-better-auth.md), [0016](0016-identity-is-one-table.md)
**Defers to:** [0016](0016-identity-is-one-table.md) (claim lifecycle and the reservation table), [0041](0041-erasure-is-a-tombstone.md) (erasure)
**Teaches:** [`docs/concepts/auth-and-identity.md`](../concepts/auth-and-identity.md)

## Context

[0001](0001-self-hosted-better-auth.md) settled *whether* handles are unique — a write-path convention
plus a plain `CREATE UNIQUE INDEX … (username)`. It settled two things about the alphabet in passing and
neither was a decision:

> The validator is ASCII-only by default. `"café"` is rejected as `INVALID_USERNAME`. Configurable via
> `usernameValidator`, which is the property that kept Better Auth ahead of Clerk. **Deciding whether
> vartalap opens this up is a product question, and belongs to the auth spec.**

> **`"Lowercase-unique" is a write-path convention, not a database invariant.** […] **Mitigation: add
> `CREATE UNIQUE INDEX ON "user" (lower(username))` in our own migration.**

The plugin documentation adds two facts neither had. The default validator allows *"alphanumeric
characters, underscores, and **dots**."* And validation **runs before normalisation by default** —
`validationOrder` exists precisely to change that.

So the mitigation [0001] recommended has a gap, the alphabet has a character nobody has ruled on, and the
order in which the plugin checks and normalises means the validator and the column can disagree about
which string they are talking about.

## Decision

### `^[a-z0-9_]{3,20}$`, lowercased before it is checked

```ts
username({
  minUsernameLength: 3,
  maxUsernameLength: 20,
  validationOrder: { username: "post-normalization" },
  usernameValidator: (h) => /^[a-z0-9_]{3,20}$/.test(h),
})
```

### The dots are removed, and the reason is parsing, not taste

The default character class permits `.`. A handle is printed inline in prose more often than it is typed
into a field, and in

> see @alice.

the period is sentence punctuation. Every mention implementation we could write would have to decide
whether `@alice.` is a handle or a handle followed by a full stop, and every one of those decisions is a
place for messages to be attributed to nobody.

`first.last` looks appealing and costs that ambiguity plus a collision with subdomain-shaped reservation
tricks. The character class is ours to change; it is changed here.

### ASCII stays, and a separate display name is the answer to why

A person named राहुल picks an ASCII handle and sets the **display name** to राहुल. That is precisely
what a free-form display name is for, it is the trade every product with an ASCII handle makes, and it is
already what the funnel asks for ([0016](0016-identity-is-one-table.md)).

Rejected: a Unicode normaliser. It makes `lower()` in Postgres and `toLowerCase()` in JavaScript disagree
— see below — which is a bug class that only appears after the day someone widens the charset, on a
column that has a unique index on it.

### Validation runs after normalisation, not before

The default validates the **raw** string and then normalises. So the validator sees `"Alice"` while the
column and the index see `"alice"`.

Lowercasing is length-preserving, so nothing breaks today. `validationOrder: "post-normalization"` is set
so that the day normalisation stops being `toLowerCase()` — because it will have to change for any
non-ASCII character — nothing silently inherits a validator that was checking a string the database never
stored.

### Two indexes, because one cannot do both jobs

```sql
-- read path: every handle resolution is written  WHERE username = $1
-- (Better Auth's CLI generates this)
CREATE UNIQUE INDEX "user_username_unique" ON "user" (username);

-- guarantee: catches any writer that skipped normalisation
CREATE UNIQUE INDEX user_username_lower_key ON "user" (lower(username COLLATE "C"));
```

They are not redundant. An expression index cannot serve a `WHERE username = $1` predicate, so dropping
the plain one sends every handle lookup to a sequential scan. An index with no caller is the same sin as
a theme token with no caller.

### `COLLATE "C"` is the part [0001]'s index was missing

PostgreSQL's collation chapter is explicit:

> In addition to comparison operators, collations are taken into account by functions that convert between
> lower and upper case letters, such as **`lower`, `upper`, and `initcap`**.

and

> **`default`** — The `default` collation selects the locale specified at database creation time.

So an unqualified `lower(username)` in an index expression computes under whatever locale Neon created
the database with, while the validator computes under JavaScript's `toLowerCase()`. On ASCII they agree,
which is why nobody notices. The day the charset widens they stop agreeing, the index becomes **silently
weaker than the application believes**, and the symptom is two users holding `@café` in different cases —
discovered long after the widening that caused it.

`COLLATE "C"` lowercases exactly `A`–`Z` and nothing else, which matches the validator's alphabet **by
construction** rather than by coincidence.

`[0001]` recommended `CREATE UNIQUE INDEX ON "user" (lower(username))`. This is the same index, made
total.

### The reserved list is not the validator

Recorded here because the alphabet and the reserved list are configured in the same object and are
routinely confused:

```ts
// WRONG — [0001] verified this also blocks *sign-in*, permanently, for
// anyone who already holds the name.
usernameValidator: (h) => !RESERVED.has(h) && /^[a-z0-9_]{3,20}$/.test(h)

// RIGHT — syntactic only, so sign-in is never gated by policy.
usernameValidator: (h) => /^[a-z0-9_]{3,20}$/.test(h)

databaseHooks: { user: { create: { before: rejectReservedHandle } } }
```

The list, the prefix rules, and the retroactive-reservation rule are in
[0016](0016-identity-is-one-table.md).

## Consequences

- **A user whose name is not Latin-script needs two fields.** That is the cost, it is visible at signup,
  and the alternative is a column whose uniqueness depends on a collation nobody has read.
- **No dotted handles**, so no `first.last`, and no ambiguity about a trailing full stop.
- **Twenty characters, not the plugin's thirty.** Short enough to read in a bubble and to leave the
  trigram prefix room. It is a constant, not a principle.
- **Every handle write goes through the trigger in [0016](0016-identity-is-one-table.md)** and therefore
  stores an already-lowercased value. The functional index should never fire. It is a net, and a net is
  worth nothing until it is the only thing between you and a duplicate.

## What would reverse this

**Widening the charset.** Then, and only then, `COLLATE "C"` has to come off — but the normaliser has to
be unified *first*, on one side, so what JavaScript writes and what the index compares are the same
function. **Changing the index first produces the bug, not the fix.**

**Multi-word handles** are the other reversal, and it is a different decision from a Unicode one:
separating with `-` or `_` is still ASCII, and needs only the character class and the trigram prefix to
account for the extra punctuation.
