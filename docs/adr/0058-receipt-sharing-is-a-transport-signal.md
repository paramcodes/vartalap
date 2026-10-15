# 0058. `receipt.sharing` is a transport signal, and `shared_through` is the mechanism

**Status:** Accepted
**Date:** 2026-10-15
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Build the spine first" — what `receipt.sharing` actually is, which stage 3 unit 3.B had to decide and no document stated
**Amends:** [0010](0010-receipt-mechanics.md), whose "Why a boolean cannot work" reads as though the boolean were rejected outright
**Extends:** [0022](0022-settings-boundary-and-transports.md), which placed the control on the `receipt` row
**Teaches:** [`docs/concepts/message-receipts.md`](../concepts/message-receipts.md)

## Context

[0010](0010-receipt-mechanics.md) made the right call and then left a hole in it.

It established that a receipt is **two positions, not one plus a boolean**, and argued it well:

> The obvious design is one row with a `sharing` flag. […] **A boolean cannot express "my position
> is frozen at where it was when I turned this off."** That requires a second stored value, and the
> second value is what carries the meaning.

Then it shipped a schema with the boolean in it. Nothing ever says what the boolean *is*.

And the gap is not academic, because the language everywhere around it invites the wrong reading. The phrase "while sharing is on" appears in [0010](0010-receipt-mechanics.md) line 25, in [`message-receipts.md`](../concepts/message-receipts.md), and in `schema.ts`, and every one of those sentences describes `shared_through` **freezing** while the flag is false. That is `shared_through` behaving like a mechanism and `sharing` like a switch on the mechanism — which is precisely the reading [0010](0010-receipt-mechanics.md) rejected when it argued the boolean was insufficient.

**The boolean was never wrong. It was insufficient *on its own*, and nothing recorded which of the two jobs it was doing.**

`message-receipts.md` had been explicit that the question was open — "**What the column is, exactly, is not decided** […] Whether it is a stored copy of the member's current setting […] or a signal the client re-sends with each advance […] the two readings are not interchangeable, and this document does not pick one." This ADR picks one.

## Decision

**`shared_through` is the mechanism. `sharing` is a signal about a permission.**

| | what it is | what it does |
|---|---|---|
| `shared_through` | the mechanism — the stored position everyone else reads | moves, or does not move |
| `sharing` | a transport signal — "may I move it right now?" | changes nothing by itself |

Concretely, on every receipt write:

- `read_through` advances to the position reported. **Always, whatever `sharing` says.** It drives
  the member's own unread count, and an unread count that stops working when someone reads privately
  is a worse bug than the leak it avoids.
- `shared_through` advances to the position reported **only when `sharing` is true on that write.**
- When `sharing` is false, `shared_through` **freezes at whatever value it already holds.** It is not
  reset, not held back by a server-side flag, not recomputed. It simply is not written.
- Turning sharing back on **resumes from the frozen value.** The sender sees ordinary forward progress
  that happens to lag.

### This is a statement about meaning, not about transport

The distinction that matters is mechanism-versus-signal, and it is **orthogonal to which endpoint
carries the flag.** [0059](0059-the-send-endpoint.md) settled that `sharing` does **not** ride the
receipt-advance body — it is a settings change with its own transport, per
[0022](0022-settings-boundary-and-transports.md) — and this ADR does not reopen that. The server still
learns the member's permission from a separate write. What this ADR fixes is the consequence on the
read path: having learned it, the server advances `shared_through` only while the permission is
granted.

Both transports carry a **signal**. Neither makes the boolean a mechanism. If someone reading this
wants the sharpest possible form of it: **the column says something about whether a position may
move; the position itself lives in a different column.**

### The consequence that follows from a signal, and that no one has written down

A signal is only as fresh as its last transmission. **A member who turns sharing off and then sends
nothing further leaves `sharing = true` on the server, and the server will keep advancing their
`shared_through` on any receipt that arrives from another device or a background sync.**

This is the honest cost of calling it a signal, and it is accepted rather than solved. The alternative
— treating the stored column as authoritative state that no transmission can contradict — is what makes
it a mechanism, and 0010 already showed what a mechanism-shaped boolean produces.

Nothing in the schema can prevent the stale row, and no poller should: a background job whose job is
to watch a privacy flag is a new failure surface, and a member whose settings write succeeded has
already been told the truth by the endpoint that accepted it.

## What breaks if someone treats `sharing` as the mechanism

Three failures, in descending order of how likely they are.

**The client stops sending while sharing is off, and re-enabling syncs `shared_through = read_through`.**
This is the big one, and it is [0010](0010-receipt-mechanics.md)'s entire argument reintroduced through
the door its own column opened. `read_through` has been advancing the whole time — it must, or the
unread badge breaks — so on re-enable the first write broadcasts the entire gap the member spent the
time hiding, immediately, to everyone. The privacy control was not merely ignored; it was
**inverted into a disclosure button**. The fix is one line, and it is the line this ADR exists to
prevent somebody from writing.

**A developer drops `shared_through` and keeps the boolean.** They read the shipped table, see a
boolean, and conclude [0010](0010-receipt-mechanics.md)'s "a boolean cannot work" means the boolean
should not exist. Now there is no frozen position at all, and the gap is not merely revealed on
re-enable — it cannot be expressed, so every implementation of "Seen" becomes approximate.

**The naming failure, which is the one that actually happens.** Somebody writes `WHERE sharing` in a
query. The column reads as a predicate, so they use it as one, and "Seen" silently becomes independent
of the frozen position. There is no type error, no failing test, and no output that looks wrong. The
guard is the word **signal** — a boolean you can write `WHERE` against is a boolean you will.

The schema cannot prevent any of the three. A stored column called `sharing` next to a stored column
called `shared_through` cannot say which one is load-bearing. Only the name and this record can.

## Consequences

- **The upsert has a branch, and the branch is the whole design.** 0010's
  `GREATEST(read_through, EXCLUDED.read_through)` runs unconditionally; the `shared_through` update
  runs only when the signal permits it. Two statements, or one with a `CASE`, and gate G2 is the test
  that a frozen value resumes rather than jumping.
- **Dropping `receipt_shared_le_read` is now explained rather than merely permitted.** The invariant
  `shared_through <= read_through` is a property of the write order, and 0010 line 68 already said so:
  *"No `CHECK` constraint: the invariant is about how a row is written, not what a single row
  contains."* Stage 3 dropped the shipped constraint. This ADR is why that is coherent — the row's
  validity is decided by the branch above and by nothing else.
- **ADR 0010's "Why a boolean cannot work" needs its heading read as "a boolean cannot be the
  mechanism".** As written it reads as a rejection of the column, and the column shipped anyway. That
  contradiction is now resolved in favour of the column existing: 0010 was right that a boolean cannot
  freeze a position, and right to add a second column for the freezing — which is a statement about
  roles, not about deletion.
- **`sharing` defaults `true`,** which means "advance `shared_through` to what I am reporting". The
  default is the permissive one because a receipt that never advances is indistinguishable from a
  member who has read nothing, and the second is a lie the schema would then be storing.
- **A settings write and an advance are separate writes**, so the flag and the position can disagree
  for as long as it takes the next advance to resolve it. That window is exactly one advance deep and
  it always resolves toward the flag, never away from it.

## What would reverse this

**A third column.** [0010](0010-receipt-mechanics.md) already names Matrix's private read as a
separate receipt *type* — `m.read.private` — which would make the two positions symmetric rather than
one gating the other. A schema that stored a private position alongside the shared one would need no
`sharing` column at all, because the absence of the private position would be the signal. That is a
better model of what is actually happening and it is more storage; this ADR picks the cheaper one
because the two positions advance on different clocks but describe the same act of reading.

**Dropping `sharing` entirely**, which 0010 also names. The cost is unchanged from 0010's account: a
member who wants to read privately must leave the conversation. Nothing since 0010 makes that worse.

**Reading the stored column as authoritative rather than as a signal** — that is the reversal this ADR
exists to refuse, and the only thing that would justify it is a server that cannot receive writes
reliably. A receipt transport that can be lost makes a signal useless and makes stored state the only
honest option. That is not the case today, and it would have to become true before this decision could
be called wrong.