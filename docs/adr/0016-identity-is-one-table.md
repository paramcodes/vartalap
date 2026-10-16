# 0016. Identity is one table, a handle is claimed once, and a handle signs you in

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Auth, onboarding and identity spec"
**Builds on:** [0001](0001-self-hosted-better-auth.md), [0009](0009-message-search.md)
**Narrower on:** [0017](0017-handle-alphabet.md) — the character set and the index expression
**Teaches:** [`docs/concepts/auth-and-identity.md`](../concepts/auth-and-identity.md)

## Context

[0001](0001-self-hosted-better-auth.md) settled *which* auth service. It did not settle what that
service owns, what the signup form asks for, or what a person types into the sign-in box — and those are
the questions that decide whether the choice was worth making.

The ticket's framing carried two premises inherited from Neon Managed, both of which [0001] removed:

> *"the mirror is not optional — presence, conversations and read state live in our database regardless of
> provider — and the question is whether the mirror is a copy that can drift or the thing everything else
> points at."*

> *"if the handle only exists in the provider's table, each of those crosses a schema boundary."*

Self-hosting Better Auth on the same Neon Postgres put its `user` table **in our database**. There is no
mirror. The second premise is a latency question, not a consistency one.

What survives is sharper and more uncomfortable: if the library and our product both write that one
table, then the *seams* between them are where every bug in this subsystem will live.

**A note on process, because it changed an answer.** The [profile and settings
ticket](https://github.com/paramcodes/vartalap/issues/17) reached this ADR's territory first, read the
same plugin source, and decided that handle changes *are* allowed — with a `handle_history` table making
availability a constraint. This ADR reached the opposite product answer, and
[0021](0021-profile-surface.md) adopted it. The argument that decided it is not a matter of taste and is
set out under *The claim is a trigger* below, where the difference is mechanical.

## Decision

### `user` is our table, and everything else points at it

| Concern | Owner | Lives in |
|---|---|---|
| **Credential** — password hash, external-provider tokens | auth layer | `account` |
| Session | auth layer | `session` |
| **Identity** — id, handle, **display name**, avatar | **us** | `user`, our Neon DB |
| Handle **claim**, release and reservation | **us** | `handle_reservation`, our triggers |
| Membership, authorship, receipts, delivery | us | FKs to `user(id)` |

Presence is derived, not mirrored — a Redis TTL ([0006](0006-presence.md)). Read state is derived from a
receipt ([0010](0010-receipt-mechanics.md)). Neither copies anything the auth layer holds.

There is no synchronisation code because there is nothing to synchronise.

### `immutableUsername: true` — a handle is claimed once

A handle is set at signup and **never changes**. [0001](0001-self-hosted-better-auth.md) verified the
problem: `username()` has no history table, a release frees the old handle immediately, and an abandoned
`@alice` silently re-points to a stranger. Nothing about that looks wrong — Priya's messages say
`@alice`, a stranger signs up, and Priya's colleagues reach the stranger.

`immutableUsername` removes the release path entirely, which leaves exactly one door: account deletion.
[0041](0041-erasure-is-a-tombstone.md) closes it — erasure writes a tombstone and the handle stays
claimed by it forever.

The product argument is independent: **a handle change silently rewrites the visible history of every
conversation the user is in.** Every message they ever sent is stamped `@oldname`, and the stamp is not
part of the message. In a Messenger clone the handle is the citation, and citations do not get edited.

Rejected: allowing renames with a reservation window. It costs a history table, a rename rate limit, a
cooldown, a UI explaining that your old handle now belongs to someone, and it buys a **bounded** promise,
since an attacker waits out the window.

### The claim is a trigger on `"user"`, which is why signup can stay inside `signUp.email`

```sql
CREATE TABLE handle_reservation (
  handle      text PRIMARY KEY,
  reason      text NOT NULL,             -- 'released' | 'reserved' | 'policy'
  reserved_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION reserve_handle() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO handle_reservation (handle, reason)
         VALUES (OLD.username, 'released')
    ON CONFLICT (handle) DO NOTHING;
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM handle_reservation WHERE handle = NEW.username) THEN
    RAISE EXCEPTION 'handle % is reserved', NEW.username USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER user_reserve_handle_ins BEFORE INSERT ON "user"
  FOR EACH ROW EXECUTE FUNCTION reserve_handle();
CREATE TRIGGER user_reserve_handle_upd BEFORE UPDATE OF username ON "user"
  FOR EACH ROW EXECUTE FUNCTION reserve_handle();   -- defence in depth; unreachable while immutable
CREATE TRIGGER user_reserve_handle_del BEFORE DELETE ON "user"
  FOR EACH ROW EXECUTE FUNCTION reserve_handle();
```

This is the argument that decided the process conflict above, and it has two halves.

**A trigger is atomic; a hook is not.** `user.deleteUser.afterDelete` fires *after* the row is gone. A
crash between the delete and the reservation insert loses that handle **silently and permanently** — the
exact failure the table exists to prevent, arriving through the mechanism meant to prevent it. A trigger
runs inside the statement's transaction, so the reservation cannot drift from the user row.

**A trigger catches every writer; application code catches the writers that cooperate.** [0001]
established that vartalap writes to `"user"` with Drizzle directly, which never touches the plugin's
normaliser — the realistic bypass, not a hypothetical one. An application-level transaction covering "our
own claim endpoint" leaves that writer uncovered. The stronger design is the one that does not need its
callers to behave.

**The consequence is a requirement the ticket's own framing would have missed: signup does not leave
`signUp.email`.** Because a trigger supplies atomicity, we do *not* need to own the write path — and
owning it would have been expensive. `signUp.email` writes the `user` row *and* hashes the password into
`account` in one request; writing `user` ourselves means writing `account` ourselves, against a hash
format **that is not documented on any Better Auth page**, with `signIn.username` then verifying our hash
against a library whose format we guessed.

That risk is avoided entirely by the trigger. It is the single riskiest seam in this subsystem and it
does not have to be taken.

### Ids are `uuid`, deliberately

`advanced.database.generateId: "uuid"`. Every other table's id is a `uuid`, and
`message.author_id → user.id` is the hottest join in the product; the library default is a
32-character random string into `text`.

[0001]'s trap is repeated because the failure is invisible: pointing the default `text` generator at a
`uuid` column fails **only for new signups**, because seeded and existing rows keep working.

### Avatar is a media reference, not a URL

`ALTER TABLE "user" ADD COLUMN avatar_media_id bigint REFERENCES media(id);`

Not `user.image`, which is a URL string the social providers write and cannot express "one of our stored
media rows". The glossary is explicit that an **Avatar** is *"a reference to media, not a distinct
concept"*. Not a `profile` table either: a one-row-per-user table beside `user` is a second thing that
can disagree about whether it exists.

> **Cross-reference discrepancy, for whoever reconciles the ADRs.**
> [0041](0041-erasure-is-a-tombstone.md) writes `image = NULL` in its anonymisation statement. Under
> this ADR the avatar column is `avatar_media_id`, and that statement must null it instead. The
> behaviour is identical; the column name is not.

Run `npx auth check schema` once to confirm an extra nullable column does not trip
`advanced.database.validateSchema`.

### Handle lookups are our query, and Better Auth's availability endpoint is disabled

Autocomplete, "start a conversation", and the availability check under the input are the **same query**,
through the exported function [0009](0009-message-search.md) already put behind the whole search surface.
`disabledPaths: ["/is-username-available"]` — which the plugin's own documentation describes as being
*"useful if you want to protect usernames from being enumerated"*.

Three reasons, all checkable:

- It **throws HTTP 422 on a malformed candidate** rather than returning `available: false` — verified on a
  live deployment in [0001].
- It returns a **boolean** where a list of candidates is wanted.
- It is a `findOne` on the `user` model, so it **cannot see `handle_reservation`** and will report a
  released handle as available. That is the exact failure [0001] flagged.

**Our endpoint reads both tables and the same reserved-list module**, so it can distinguish *unavailable*
from *reserved* — a form that cannot tell those apart turns a correct rejection into a mystery.

**The library is not on the keystroke path.**

### A handle signs you in. The email address never does.

The sign-in form's primary identifier is the handle. Email sign-in exists as a secondary option on the
same form and is never the default.

The product reason is the map's original reason for choosing Better Auth. The security reason is sharper
and is why this is a decision rather than a preference — OWASP's Credential Stuffing Prevention cheat
sheet, *Require Unpredictable Usernames*:

> A significant number of websites use the email address as the username […] as most users will have a
> single email address they use for all their accounts, which makes the combination of an email address
> and password very effective for credential stuffing attacks. **Requiring users to create their own
> username when registering […] makes it harder for an attacker to obtain valid username and password
> pairs**, as many of the available credential lists only include email addresses.

[0001] forced an email on every user. **The decision that matters is refusing to let it be the name they
log in with.** An email-primary form would take the exact surface breach corpora contain and make it
vartalap's.

Rejected: email-only sign-in, which makes the mandatory email load-bearing. Rejected: no email sign-in
at all, because a forgotten password with no recovery is a dead account.

**Sign-in answers identically for "no such user" and "wrong password."** Better Auth does this for the
email path; the handle path needs a test asserting it, because the failure is an enumeration oracle
nobody notices.

### The signup funnel is four fields, and the last one is the one people resent

| # | field | column | required |
|---|---|---|---|
| 1 | display name | `name` | yes — makes the handle read as a caption, not a login |
| 2 | handle | `username` | yes — the thing people recognise you by |
| 3 | password | → `account` | yes |
| 4 | email | `email` | yes — library requirement, recovery seed, nothing more |

One screen. **Email is collected, never verified, and never emailed to.** `requireEmailVerification`
stays false; no `sendVerificationEmail` is implemented.

The consequences, stated rather than discovered:

- **There is no password reset in v1.** You cannot prove you own an address we never wrote to. The v1
  answer is a documented manual procedure, owned by the hardening ticket.
- `email_verified` is `false` for every user and the column is decorative.
- Nothing stands between signup and the empty conversation list — which is the point. A verification gate
  is an inbox round trip before the product's first screen.

Rejected: a generated placeholder address, which throws away an address the user was willing to type once
and breaks the recovery path that will eventually exist.

**`autoSignIn: true`, and what it costs.** Better Auth's sign-up email-enumeration protection returns the
same `200` whether or not the email is registered — but **only** when `requireEmailVerification` is on or
`autoSignIn` is `false`. We chose neither, so sign-up reveals whether an email is taken.

Taken deliberately, with the compensating control named: the auth limiter in
[0043](0043-rate-limits.md) is keyed on IP and fails closed, and the failure copy for "handle taken" is
identical whether the cause was a collision, a reservation, or a prior release — so sign-up leaks the
*handle's* status, which is public anyway, and not the email's.

### Passwords: length, no composition rules, breach-checked

`minPasswordLength: 12`, above Better Auth's default of 8. No symbol or digit requirements — length
beats composition, and composition rules are the most common reason people write `Password1!`.

Checked against Pwned Passwords' **range API** from the client: five characters of a SHA-1 leave the
browser and the password does not. It **warns** rather than blocks — ASVS 4.0 §2.1.7 and OWASP both ask
for the check; neither asks for a hard block.

**Hashing stays Better Auth's default `scrypt`.** It is memory-hard and CPU-intensive by design and is
on OWASP's list of acceptable functions. Swapping it for Argon2id would be a downgrade in evidence and an
upgrade in nothing.

### Reserved names are a config list, and they are not the validator

A `Set<string>` of lowercased handles in one module, plus **prefix rules** — `admin`, `support`, `help`,
`security`, `postmaster`, `root`, `system`, `null`, `undefined`, `about`, `settings`, `login`, `signin`,
`signup`, and the product's own name. Prefixes rather than words, because `admin` alone does not stop
`admin123`.

Not a table: read once per signup, changes with a deploy, and a table would need its own admin surface
and migration story for a list that will not grow in v1. Not inline code: then there is no single file to
point a reviewer at.

**Enforced in a `databaseHooks.user.create.before` hook, never in `usernameValidator`.** [0001] verified
why, and it is the kind of trap that looks like a convenience: a reserved list in the validator makes
those names fail **sign-in** as well as sign-up — a permanent lockout for anyone already holding one.
The hook throws an `APIError` carrying `USERNAME_IS_ALREADY_TAKEN` so the interface has one failure
branch and never leaks that a name was reserved rather than taken.

**A name reserved after someone claimed it stays with them.** Freeing it would re-attribute their
messages to a stranger, which is the harm `handle_reservation` exists to prevent. The list is checked at
claim time and nowhere else.

## Corrections to the original ticket

- **"The mirror is not optional […] is it a copy that can drift or the thing everything else points at?"**
  There is no mirror. This is a false dichotomy created by the managed-auth assumption [0001] removed, and
  it is the largest thing the ticket got wrong about its own starting point.
- **"If the handle only exists in the provider's table, each of those crosses a schema boundary."** False.
  One table, one database, one indexed column.
- **"An account holds credentials."** Not our vocabulary. A **User** holds Credentials; Better Auth's
  `account` table is one row per credential and the word is already taken.

## Consequences

- **One table, one writer of identity, and the meeting point between library and product is two triggers
  and one hook** — all visible in `auth.ts`.
- **`npx auth check schema` is a CI step**, not a one-off: a library that believes it owns a table will
  eventually disagree with us about it.
- **Handle space grows monotonically and is never recycled.** One row per deleted account. At v1's scale
  that costs nothing; it stops being free when burned names collide with demand, and then the answer is a
  cooling-off period, which is a migration and not a redesign.
- **A user with a typo in their handle keeps the typo.** They can change the **display name** to
  anything, which is what display names are for.
- **No recovery path.** A user who forgets their password is stuck until the operator intervenes. A real
  product gap in v1, recorded so it reads as a decision.
- **No multi-factor authentication.** OWASP rates MFA as the strongest defence against credential
  stuffing — Microsoft's analysis puts it at 99.9% of prevented compromises. A per-IP limiter is a weak
  substitute, and the weakness is named rather than implied.

## What would reverse this

**Social or OAuth sign-in** is the change that puts a second identity in the table, and it is exactly the
case [0001] warned about: the shipped type says `username: string` and the runtime value is `null` for
any user created without one. The `BEFORE INSERT` trigger is the thing that must be re-thought, because a
social signup arrives with no `username` and the `handle_reservation` lookup would compare `NULL`.

**Handle changes** reverse the moment a product requires renewable handles. `immutableUsername: false` is
one line, the `UPDATE` branch of the trigger already re-reserves, and the only new artefact is a history
table — [0021](0021-profile-surface.md) records that the profile screen's read-only handle is then the
only control that has to be rebuilt.
