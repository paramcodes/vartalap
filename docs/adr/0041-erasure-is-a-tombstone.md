# 0041. Erasure anonymises the user row to a tombstone and cascades nothing

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "The hardening plan: what production-ready means for a learning project"
**Scope:** the **mechanism** only. What "your data" means — which tables are in scope, what export
contains, what the settings screen offers — belongs to
[`0022`](0022-settings-boundary-and-transports.md), which defers the mechanism here.
**Extends:** [0001](0001-self-hosted-better-auth.md) (self-hosted auth, so we own the user table), [0003](0003-receipt-watermark.md) (messages and receipts survive people)
**Feeds:** [`docs/concepts/hardening-backlog.md`](../concepts/hardening-backlog.md)

## Context

The ticket asked for the flow, not a policy: *"anonymise the sender, then cascade."* The instinct is
to read "cascade" as the mechanism and then discover what the schema says.

What the schema says is the decision, and it says it in a way that is easy to misremember:

**`ON DELETE NO ACTION` does not delete referencing rows.** It errors, exactly like `RESTRICT`. The
two differ only in deferrability. Every message, receipt, delivery and membership in vartalap points
at a user through such a foreign key, so `DELETE FROM "user"` is **guaranteed to fail** — it does not
silently orphan anything, and it does not quietly cascade. That is a good property: the schema
already refuses the naive erasure, which means the interesting question is what to do instead.

And the constraint on the answer is not only legal. **You cannot delete what other people hold.**
ICO is explicit that an erasure instruction obliges you to inform each recipient and instruct other
controllers to erase — it does not, and cannot, make a stranger's cached copy disappear. vartalap's
messages live in other members' browsers, in Dexie, and in screenshots nobody indexed.

## Decision

### `DELETE /account` exists in v1. It runs one transaction and it cascades nothing.

### The user row survives, holding nothing personal

```
UPDATE "user" SET
  email            = NULL,
  email_verified   = false,
  name             = NULL,
  username         = NULL,
  display_username = NULL,
  image            = NULL,          -- the avatar Media goes to the purge
  status           = 'deleted',
  deleted_at       = now()
WHERE id = $1;
```

Everything a person could be identified or contacted by is gone. The row remains as a **tombstone**:
an id that other rows can still reference, and nothing else.

### Sessions and credentials are deleted — they are the exception to "cascades nothing"

The `session` and `account` rows go, and so does Better Auth's `verification` row. The reasoning is
that these are not the person's *content*, they are the person's **ability to act**, and leaving a
deleted user signed in is a security defect rather than a privacy feature.

**What "cascades nothing" is a fact about.** It is a fact about *this endpoint*, not about the schema,
and the distinction matters because the schema is the opposite of uniform. Erasure is an `UPDATE`, so
no foreign key fires at all. Were anyone to run `DELETE FROM "user"` on a tombstone, four tables
cascade — `account`, `session`, `block` from either column, and `push_subscription` — while
`receipt`, `delivery`, `member`, `message.author_id` and `media.owner_id` are `NO ACTION` and
**refuse the delete**.

**So the reason receipts and deliveries survive is not that a cascade was configured off. It is that
the user row survives to be referenced.** That is the actual mechanism behind the decision below, and
it is worth stating because the alternative reading — "there are no cascades from `user`" — is false
and would produce the wrong fix for the wrong reason.

**`block` and `push_subscription` are the two this ADR does not account for.** Harmless today, for the
reason above. They stop being harmless in the one scenario *What would reverse this* already names —
staged deletion, hard-deleting the tombstone after a window — where both vanish with no event: a push
subscription stops receiving, and **a block stops blocking.** The second is behavioural rather than
cosmetic — the erased member's block on somebody disappears and that somebody can message them again,
with nothing in this document and nothing in the H-06 runbook saying so. **A staged deletion must
enumerate both tables by name before it is permitted to `DELETE`.** Recorded as an open item in
[`docs/concepts/hardening-backlog.md`](../concepts/hardening-backlog.md).

### The handle is reserved permanently. It is never released.

### Membership is untouched, attachments are retained, receipts and deliveries are retained

## Why a tombstone rather than a delete

Three options, and two of them are bad for reasons that are only visible once the schema is in
front of you.

**Delete the row and let the foreign keys complain.** It errors. Every time. The only way to make it
work is to drop the author reference to a nullable column, which is a rewrite of every query that
renders a sender and a rewrite of the send path.

**`ON DELETE SET NULL` on `message.author_id`.** This looks tidier and it is worse. It costs every
query a nullable author, and it erases the distinction the glossary cares about: a message whose
sender is null because they *erased* is indistinguishable from one whose sender is null because they
were *never recorded*, and a former member's messages must survive while remaining attributable. It
also means the tombstone is invisible, and an invisible tombstone is a row that rots.

**Anonymise in place.** One row stays. Every message keeps an author that renders as a fixed
string. No query changes shape. The delete is idempotent, because running it twice is the same
statement.

The cost, stated plainly: **vartalap keeps a record that a user with this id once existed.** That is
the honest residue of a design in which other people's transcripts are still readable.

## The handle is never released, and that is the subtle one

[0001](0001-self-hosted-better-auth.md) already recorded that Better Auth's `username()` has no
history table: a rename frees the old handle immediately, and an abandoned `@alice` silently
re-points at whoever signs up next.

Releasing the handle on erasure would make that failure permanent and unarguable. **Someone else's
messages would render under an identity the erased person no longer controls** — not merely a
squatted name, but a transcript attributed to a stranger.

**So this ADR does not decide that; it decides that erasure must not bypass whatever does.** The
mechanism — a reservation table enforced by a trigger, because a hook cannot be atomic, plus
`immutableUsername` so the handle is never released in the first place — is owned by the auth and
profile tickets, and it is stronger than anything this document would have written. The requirement
this ADR places on it is one line: **the erasure transaction must not null the handle column in a way
that slips past the reservation trigger.** Set `username = NULL` as above and the trigger has to fire
first; that ordering is the whole implementation risk in this section, and it is the reason the
anonymisation statement is written out in full rather than assembled at runtime.

## The obligations that are not code

Two of the three things erasure requires cannot be written as a transaction, and pretending
otherwise is how a compliance feature becomes a lie.

**Tell the recipients.** Every current member of every conversation the erased user belonged to is
to be informed, and other controllers holding the data are to be instructed to erase. vartalap can
send that notice. vartalap cannot make anyone comply with it. The notice is sent from the operator's
runbook until the mail path exists, and the runbook names the obligation in full rather than
summarising it as "tell people".

**Put the backups beyond use.** ICO requires erasure from backups too, and is equally clear that a
backup cannot be overwritten in place — the data must be put *beyond use*. In this architecture
that is tractable, because the backup is a file we own and can delete: **[0042](0042-backups.md)'s
nightly dump deletes the pre-erasure dumps on the next run rather than serving their 30-day
lifecycle.**

Two honest caveats. The erased bytes survive in the bucket's own version history — which is why the
erasure runbook deletes noncurrent object versions in the media bucket too, not just the current ones.
And nothing in the restore runbook will ever put that data back into a database, which is the
*operative* meaning of beyond use: **the data is retained but not usable, and the control is a rule
rather than a wipe.** That is weaker than true erasure, and it is exactly what the guidance says it
is allowed to be.

**The one thing that does cascade** is the user's own avatar media. It is theirs alone, nothing
references it, and it goes to the same scheduled purge as every other unreferenced object from
[0008](0008-media-pipeline.md). **Attachment media is retained**, because the message referencing it
survives and deleting the bytes would leave a permanent hole in someone else's transcript.

## Consequences

- **The endpoint bypasses Better Auth entirely.** It is our write path against a table Better Auth
  also owns. That is a real cost: the transaction spans both schemas, and any future Better Auth
  migration that touches `user` has to know this statement exists. This is the price of
  self-hosting the auth layer, and it was paid knowingly in [0001](0001-self-hosted-better-auth.md).
- **Anonymisation must be listed explicitly.** A generic "clear all nullable profile columns" loop
  would miss a column added next year, and would leave a personal datum in a row we promised was
  empty. The statement above is written out in full for that reason; a future schema change has to
  edit it.
- **Messages render a tombstone string, not a blank.** The interface needs one component that
  renders "Former member" for `status = 'deleted'`, everywhere a display name is drawn. It is
  interface copy borrowing nothing from anyone else's product.
- **Re-registration under the same email is a fresh user.** There is no merge, no resurrection, no
  path from the tombstone back to a person. That is the correct default and it should stay boring.
- **The runbook is a person.** Before a second user exists, honouring the recipient-notification
  obligation is a manual step by the operator. That is acceptable at one user and stops being
  acceptable at two.

## What breaks without this

There is no way to leave, short of the operator opening a SQL client and editing rows by hand —
which is not erasure, because nothing tells anyone it happened. Concretely: the data stays
identifiable, the retention promise is unkept, and the honest answer to "can I delete my account?"
is a shrug. It also means the backup story has an unexplained hole, because a dump that silently
retains deleted users is a breach waiting for a request.

## What would reverse this

**A staged deletion** — pseudonymise immediately, hard-delete the tombstone after a fixed window
(30 days) — is what a production deployment with a legal team would do, and it is strictly better.
It needs the author reference to survive the hard delete, which means either a nullable
`author_id` or a `deleted_users` table of ids that messages point at instead of users. Both are the
schema change this ADR avoids. **The trigger to pay it is a real user population**, and the trigger
to pay it sooner is a regulator, not a feeling.

**Deleting message content on erasure, within a retention window**, is the other direction some
jurisdictions take. It is incompatible with [0003](0003-receipt-watermark.md)'s watermark model and
with the glossary's promise that a former member's messages survive. It would be a product decision,
not a hardening one, and it would need to be taken as a change to the domain model rather than
quietly applied at the delete endpoint.