# Stage 5 — conversations

The operational plan for stage 5. Decisions live in ADRs and concepts; this file holds **sequence,
scope, and acceptance only**. Read [`docs/decisions-index.md`](../decisions-index.md) first, then
ADR [0007](../adr/0007-conversation-model.md).

**State at the time of writing:** stages 3 and 4 are committed. Conversations exist only as far as
stage 3 needed them to: `createDirectConversation` in the test fixture, `isCurrentMember` as the
one membership predicate, and a send path that checks membership but explicitly does not check
blocks ("Blocks are stage 5 and are NOT implemented" — `send.ts`). There are no conversation
routes, no block operations, no leave, and no groups. This stage builds all of it.

---

## The three gates

| Gate | Guarantee | Proved by |
|---|---|---|
| **C1** | Two people messaging each other for the first time simultaneously get one conversation, never two. | 5.A |
| **C2** | A blocked sender is refused with the reason the composer renders, in both block directions; an unblock restores sending. | 5.B |
| **C3** | Leaving retains the row and the receipt; rejoining resumes it; a former member cannot write anywhere. | 5.C |

Unlike G1b, C1 runs everywhere: the uniqueness is a constraint (`ON CONFLICT DO NOTHING` on
`direct_key`), not a timing property, so PGlite's serialisation does not make the test vacuous —
two concurrent inserts still yield exactly one row, which is precisely the claim.

### Rulings made here, not later

- **Blocks gate sending, not reading.** "A block prevents the blocked party from sending"
  (0007). Receipt advances and delivery acks keep the membership-only predicate: a blocked
  member is still shown the conversation (blocking is not hiding), and a watermark for what
  they were shown is a true statement. If a later decision wants blocked members' receipts
  frozen, that is a new ADR, not a reinterpretation.
- **`canSend` is one function.** 0007: "called by the send path and by the interface." The
  send path, the receipt path and the delivery path already share `isCurrentMember`; the block
  check joins that same function rather than becoming a second predicate the send path alone
  calls. Three hand-written variations is how one of them eventually gets relaxed.
- **Direct conversations have no stored name, ever.** 0007: the title and avatar derive from
  the other member, so they cannot go stale. A `title` written onto a direct row is a bug even
  if nothing reads it yet.
- **Group membership changes are explicit.** Joining and leaving are writes to `member`,
  never side effects of sending. A send from a non-member is refused, not treated as a join.

---

## Units

### 5.A — The direct pair, as a route

`createDirectConversation` graduates from fixture to product: `POST
/api/conversations/direct` (or the shape 0059's successor decides — the send endpoint ADR is
the closest precedent), doing `INSERT … ON CONFLICT DO NOTHING` then re-selecting, seeding
both `member` rows, and creating both `receipt`/`delivery` rows so a new conversation never
has a member with no watermark. Group creation rides the same route family with `direct_key`
NULL — unlimited rows, same table, per 0007 — enforcing the **500-member ceiling with a clean
rejection**, not a partial fan-out.

**Done when:** C1 passes — two simultaneous creations for one pair yield one row — plus the
ceiling test (501st member refused, 500 sends intact) and the title rule (a direct row with a
stored title fails).

### 5.B — Blocks

Block and unblock writes on the `block` table, and the block check inside `canSend`: B blocks
A ⟹ A cannot send to B, and B's messages to A are not delivered. Both directions tested —
`blocked_by_me` and `blocked_by_them` are different reasons with different composer copy, and
a test that only blocks one way proves half the predicate. Unblock restores sending with no
residue: no tombstone, no flag, the row is gone.

The refusal answers `403 sendBlocked` with the reason, which the error envelope already
carries as `retryable: true` — being blocked ends without the sender doing anything, which
is exactly the composer's test for retryable.

**Done when:** C2 passes — each direction refused with its own reason, unblock restores, and
breaking the check (delete the `block` lookup) fails the tests. Plus the negative space: a
block changes nothing about receipts, delivery, or history visibility, asserted rather than
assumed.

### 5.C — Leaving and rejoining

Leave sets `left_at`; rejoin clears it on the same row. The receipt row survives both —
nobody deletes it, which is why a rejoining member inherits it rather than starting at zero.
A former member is refused on all four write paths (send, receipt, delivery, sharing) through
the same predicate, and reads the empty page from history and catch-up (3.D's rule, unchanged).

**Done when:** C3 passes — leave, advance nothing, rejoin, receipt where it was; former-member
writes refused everywhere; and the rejoin of a never-left member is a no-op rather than an
error.

---

## Sequence

```
5.A ──▶ 5.B ──▶ 5.C ──▶ stage 6
```

Strictly sequential: 5.B's predicate extends 5.A's creation (a blocked pair's first message),
and 5.C's former-member rule is enforced by the same `canSend` 5.B completes.

## Rules for every unit

- One commit per unit, and the commit lands with its tests green.
- No new dependency. None is foreseen.
- Breaking a gate's guarantee must fail its tests — delete the `ON CONFLICT`, delete the
  block lookup, delete the `left_at` check, and watch. Report the real output.
- If a unit discovers that a decision is wrong, stop and write the ADR that changes it.
