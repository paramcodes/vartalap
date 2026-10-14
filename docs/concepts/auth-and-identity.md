# Auth, onboarding and identity

From a person typing a handle into an empty box to a live socket carrying their messages — and back out
again when they sign out.

Decisions are in [0016](../adr/0016-identity-is-one-table.md),
[0017](../adr/0017-handle-alphabet.md) and
[0018](../adr/0018-socket-is-a-lease.md), on the auth service itself in
[0001](../adr/0001-self-hosted-better-auth.md), on the profile surface in
[0021](../adr/0021-profile-surface.md) and on erasure in
[0041](../adr/0041-erasure-is-a-tombstone.md). The devices screen is
[0022](../adr/0022-settings-boundary-and-transports.md) and the rate limiter
[0043](../adr/0043-rate-limits.md). Vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md).

---

## Verified against Better Auth 1.7.7

The prose below was written before the library was installed and is correct about
intent. These are the points where the actual library disagreed, established by reading
the published package source rather than the docs — better-auth.com serves `latest`
unversioned, and two places below are already stale in it.

**The docs are wrong twice.** The Drizzle adapter has moved out of core into
`@better-auth/drizzle-adapter` on its own version train; `better-auth/adapters/drizzle`
still re-exports it, so older guides work and the dependency is nonetheless named
separately. And the CLI writes `auth-schema.ts`, not `schema.ts`, which the CLI page
states outright.

**It issues no DDL through the Drizzle adapter.** `migrate` is hard-gated to the built-in
Kysely adapter, so tables come from our migrations in our order. `auth generate` writes a
`.ts` file and nothing else — and it **overwrites its whole target without merging**, which
with `-y` is silent. Never point `--output` at the application schema.

**`name` is required and cannot be removed.** It is `required: true` upstream, and schema
validation checks every declared field for existence on every request — a missing one is
`missing-column` and takes auth down with a 500, not a warning. So `user.name` exists and
is the **account** display name, the one a member sees before they have a
per-conversation one; `member.display_name` is the override inside a Conversation.
`user.image` is dead: avatars are Media through [0008](../adr/0008-media-pipeline.md).

**Ids must be told to be UUIDs.** The default generator emits a 32-character opaque
string, and every primary key here is `uuid`. Without `advanced.database.generateId:
'uuid'` the first sign-up fails with `22P02 invalid input syntax for type uuid` — and
because Better Auth surfaces that as `Failed to create user`, it reads as a duplicate
handle rather than an id-shape problem.

**`validationOrder` is not optional for us.** The username validator runs *before*
normalisation by default, so `Param` is rejected for containing a capital — the user's own
display casing fails sign-up. `validationOrder: { username: 'post-normalization' }` fixes
it, and `usernameNormalization` lowercases.

**`immutableUsername` is application-layer only**, enforced on `POST /update-user` and
nothing else. A direct SQL update bypasses it entirely. The `BEFORE UPDATE OF username`
trigger is the real enforcement, which is the same reason the reservation is a trigger.

**Uniqueness is read-then-write.** The plugin's check is a `findOne` followed by an
insert, with no `ON CONFLICT`. The `unique: true` in its schema is a migration hint and
nothing more. The expression index is what makes the guarantee atomic, and
`Username is already taken` is a race loser rather than a verdict.

**`auth.api.*` called server-side is not rate limited.** Only client-initiated HTTP is. The
chat endpoints need their own limiter ([0043](../adr/0043-rate-limits.md)).

**Do not enable `cookieCache`.** A revoked session stays live elsewhere until the cache
expires, which is a correctness bug against "revoke this device now"
([0022](../adr/0022-settings-boundary-and-transports.md)). Core `listSessions` reads the
**signed** cookie, so the server-side API cannot exercise it — `packages/auth/smoke.ts`
asserts on session rows instead.

---

## One table, and no mirror

Better Auth is self-hosted and pointed at **the same Neon Postgres as everything else**, so its `user`
table is one of ours:

```sql
CREATE TABLE "user" (
  id              uuid PRIMARY KEY,
  email           text NOT NULL UNIQUE,
  email_verified  boolean NOT NULL DEFAULT false,  -- permanently false in v1
  name            text,                            -- the display name
  username        text UNIQUE,                     -- the handle, already lowercased
  display_username text,                           -- the handle's display casing: @Param
  avatar_media_id bigint REFERENCES media(id),
  status          text NOT NULL DEFAULT 'active',  -- 'deleted' marks a tombstone
  created_at      timestamp NOT NULL DEFAULT now(),
  updated_at      timestamp NOT NULL DEFAULT now()
);

-- read path.  An expression index cannot serve  WHERE username = $1.
CREATE UNIQUE INDEX user_username_unique ON "user" (username);

-- guarantee.  Catches any writer that skipped normalisation. See below.
CREATE UNIQUE INDEX user_username_lower_key ON "user" (lower(username COLLATE "C"));
```

Four things happen at signup: a **User** is created, a **Credential** is stored, a **Session** is
created, a **Handle** is claimed. Everything downstream — conversation membership, authorship, receipts,
delivery — is a foreign key to `user(id)`. Presence is a Redis TTL and read state is a derived position;
neither copies anything.

There is no mirror, and no code that keeps one in step, because there is only one copy.

---

## A handle is claimed once, and a released one is reserved forever

`immutableUsername: true`. A handle is set at signup and never changes, so the only path that can release
one is account deletion — and erasure writes a tombstone that keeps holding it
([0041](../adr/0041-erasure-is-a-tombstone.md)).

```sql
CREATE TABLE handle_reservation (
  handle      text PRIMARY KEY,          -- a released or reserved handle, forever
  reason      text NOT NULL,
  reserved_at timestamptz NOT NULL DEFAULT now()
);
```

The table is consulted and written by **triggers on `"user"`**, not by an endpoint:

```sql
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
```

Triggers fire `BEFORE INSERT`, `BEFORE UPDATE OF username`, and `BEFORE DELETE`.

**Why this and not an application write.** The reservation has to be in the same transaction as the user
row, or a crash between them loses a handle forever — the exact failure the table exists to prevent,
arriving through `afterDelete`, the mechanism meant to prevent it. And because the trigger is the only
thing that does this, it is also the only enforcement no writer can bypass, which matters because
[0001](../adr/0001-self-hosted-better-auth.md) already found that writing `user` through Drizzle skips the
plugin's normaliser.

**The payoff is that signup stays inside `signUp.email`.** An endpoint writing the `user` row itself
would have to write the `account` row too, and Better Auth's password-hash format is not documented — the
library would end up verifying a hash we guessed. The trigger removes that seam entirely.

---

## The four fields, and the order they go in

| field | column | why it is where it is |
|---|---|---|
| display name | `name` | First, so the handle below reads as a caption rather than a login |
| handle | `username` | Second — the thing people recognise you by |
| password | → `account` | Third |
| email | `email` | **Last, because it is the one people resent** |

One screen. `minPasswordLength: 12`, no composition rules, and a breach check against Pwned
Passwords' range API from the browser — five characters of a SHA-1 leave the client and the password does
not. It **warns**; it does not block.

**The email is collected, never verified, and never emailed to.** So:

- there is **no password reset** — you cannot prove you own an address we never wrote to;
- `email_verified` is `false` forever, and anything that later treats it as an identity claim is reading
  a field nobody filled in;
- nothing stands between signup and the empty conversation list. That last one is the point.

**`display_username` is not the display name.** It is the *handle's* display casing — `Param` for a
handle stored as `param`. The display name is `name`, free-form, not unique, and may be anything,
including `राहुल`. That is what it is for, and it is why the handle can stay ASCII.

### A handle signs you in, and the email never does

OWASP, *Require Unpredictable Usernames*:

> A significant number of websites use the email address as the username […] **Requiring users to create
> their own username when registering […] makes it harder for an attacker to obtain valid username and
> password pairs**, as many of the available credential lists only include email addresses.

The library forces an email on every user. The decision that matters is refusing to let it be the name
they log in with. And sign-in answers **identically** for "no such user" and "wrong password" — the handle
path needs a test asserting that, because the failure is an enumeration oracle nobody notices.

---

## Handle availability: one query, two arbiters

Autocomplete, "start a conversation", and the availability check under the input are the **same query**,
through the exported function [0009](../adr/0009-message-search.md) already put behind the whole search
surface:

```sql
-- the shape inside search_handles(); no call site writes this itself
SELECT u.id, u.username, u.display_username, u.name
  FROM "user" u
 WHERE u.username COLLATE "C" % $1        -- trigram: candidate set
 ORDER BY similarity(u.username, $1) DESC
 LIMIT 20;
```

Better Auth's `/is-username-available` is **disabled**. It answers a boolean where a list is wanted, it
**throws 422** on a malformed candidate instead of saying `false`, and in the plugin source it is a
`findOne` on the `user` model — so **it cannot see a released handle** and will report one as available.

### The check-then-claim race is not a race we can lose

The availability check is advisory and may be a millisecond stale. The claim is not:

```
GET  /api/handles/available?handle=alice   →  a hint, from user + handle_reservation + the list
POST /api/auth/sign-up                      →  commits against
       • UNIQUE (username)                    the ordinary read/write path
       • user_username_lower_key              a writer that skipped normalisation
       • the BEFORE INSERT trigger            a handle that was released or reserved
```

A stale hint is a stale hint. Nobody can win a race they lose atomically.

### What is reserved, and where

A `Set<string>` of lowercased handles in one module, plus **prefix rules** — `admin`, `support`, `help`,
`security`, `postmaster`, `root`, `system`, `null`, `undefined`, `about`, `settings`, `login`,
`signin`, `signup`, and the product's own name. Prefixes, not words, because `admin` alone does not stop
`admin123`.

Enforced in a `databaseHooks.user.create.before` hook, **never in `usernameValidator`** — [0001](../adr/0001-self-hosted-better-auth.md)
verified that a reserved list in the validator makes those names fail **sign-in** too, a permanent lockout
for anyone already holding one.

**A name reserved after someone claimed it stays with them.** Freeing it would re-attribute their messages
to a stranger, which is the harm the reservation exists to prevent.

### The alphabet

`^[a-z0-9_]{3,20}$`, checked **after** normalisation.

The plugin's default class allows **dots**, and a handle is printed inline in prose more often than it is
typed: in `see @alice.` the period is sentence punctuation. No dots.

ASCII stays, and the display name is why. And `validationOrder: "post-normalization"` because the default
validates the raw string — so a validator checking `"Alice"` is checking something the column never
stored.

---

## The signed-in second

Three round trips, in this order, and they are not interchangeable:

```
1.  POST /api/auth/sign-in/username     { username, password }
        → Better Auth verifies the Credential, creates a session row,
          sets an HttpOnly Secure SameSite=Lax cookie

2.  GET  /api/me
        → auth.api.getSession() reads session.token → user row
        → this is where avatar_media_id becomes a media URL

3.  GET  /api/realtime/connection-token
        → the same session cookie, the same read
        → mints { sub, exp: now + 60, aud, iss } for Centrifugo
```

Step 3 costs that read **again**, sixty seconds later, for the life of the connection. That is the design:
**the socket holds a lease, not a credential**, and renewing it is the only thing that re-consults the
database.

`session.cookieCache` is off. It would let a `session_data` cookie — signed, not encrypted — keep a
revoked session alive for `maxAge`, and a stale `user.username` out of one is enough to defeat the handle
guard entirely.

---

## Revocation

Deleting the session row is the revocation. Everything else is making it reach the places a row cannot.

| | database | realtime |
|---|---|---|
| sign out here | `DELETE` this `session` row | `disconnect { user }` |
| sign out on another device | `DELETE` this `session` row | `disconnect { user, whitelist: [current] }` |
| sign out everywhere | `DELETE FROM session WHERE user_id = $1` | `disconnect { user }` |

Centrifugo closes the connection when `exp` passes and gives a **25-second grace period** for the SDK to
present a fresh token. Ceiling on a revoked connection: **85 seconds**, with no other mechanism involved.

**Omit `exp` and there is no ceiling at all** — *"If the `exp` claim is not included, Centrifugo will not
expire the connection."* Nothing about that looks broken. It looks like a chat app that works.

`aud` and `iss` are unchecked by default on both sides. The token lives in memory, never `localStorage`,
and the `getToken` fetch uses a **relative URL** — `fetch` defaults to `credentials: "same-origin"`, so an
absolute cross-origin URL silently drops the session cookie and the connection authenticates as nobody.

**Every revocation disconnects all of that user's connections.** The ones whose sessions survive
reconnect in about a second. Centrifugo can target one `client`, but matching it to a session row means
two vocabularies for one word.

The client never calls `/sign-out` itself — it calls our route, which calls the library and then
Centrifugo, so the pairing cannot come apart.

### Three devices is not a device model

There is no device table. `listSessions` already returns `{ createdAt, expiresAt, token, ipAddress,
userAgent }` — a browser, an OS, a sign-in time, an expiry. The devices screen is
[0012](../adr/0022-settings-boundary-and-transports.md)'s; what the transport adds is that the same rows
are the set of **leases**, so revoking one is the same `DELETE` plus `disconnect` as revoking all of them.

---

## Rate limiting, and the header that defeats it

[0014](../adr/0043-rate-limits.md) owns one Redis token-bucket module, with auth keyed on **IP** at
10/min, burst 3, **failing closed**. **Better Auth's own limiter is switched off** (`rateLimit.enabled:
false`) rather than left alone — its default is `enabled: true` in production at 100 requests per 10
seconds, and one module should own one set of numbers.

**And the proxy configuration that makes it mean anything.** Better Auth reads the client IP from
`X-Forwarded-For` by default and documents that behind a proxy chain you must list your proxies in
`advanced.ipAddress.trustedProxies` so it resolves the real client *"instead of the spoofable leftmost
`X-Forwarded-For` token"*. Without it, an attacker rotates a header and the bucket never fills.

---

## Onboarding after the first signin

There is one screen after signup: **the conversation list, empty.**

- **No first conversation is created for you.** A conversation needs two members, and
  [0007](../adr/0007-conversation-model.md) settled that a conversation with one member is nothing. A
  "Message Yourself" row would violate the glossary's own definition.
- **No avatar prompt.** Initials on a hue derived from the user id. Asking for a photo during onboarding
  puts an R2 upload between the person and their first message.
- **No permission prompt, no tour, no contact import, no "find your friends".** Each is friction on a
  product whose value is one tap to message someone.

What the empty state owes them is one button — **New message** — which opens handle autocomplete. If the
funnel has done its job, the handle they chose is enough to start.

---

## What the interface never sees

A **Credential** belongs to the auth layer and is never rendered, and the way to guarantee that is not a
code-review convention:

**No query that returns a `user` row joins `account`.** The password hash and any provider token are
unreachable from any endpoint that renders a person, by construction rather than by discipline.

`user.email` appears in exactly one place — the user's own settings — and never to anyone else. The data
export includes `session.userAgent` and `session.ipAddress` and **excludes `session.token`**: a token in a
downloadable file is a bearer credential.

---

## Traps

1. **`lower()` is collation-sensitive.** Postgres applies collations to `lower`, `upper` and `initcap`,
   and `default` is whatever locale the database was created with. Without `COLLATE "C"` the index and
   the validator are two functions that agree only on ASCII — and the day the charset widens, the index
   is silently weaker than the application thinks.
2. **The default handle validator allows dots.** `see @alice.` is a sentence, not a handle.
3. **Validation runs *before* normalisation by default**, so the validator checks a string the column
   never stored.
4. **`usernameValidator` also gates sign-in.** A reserved list put there is a lockout, not a signup rule.
5. **A `session_data` cookie is signed, not encrypted.** With the cookie cache on it can carry a stale
   `username: null`, which defeats the handle guard as well as revocation.
6. **The cookie cache's `maxAge` is a revocation floor**, on every device, including one that never
   receives the `disconnect` call.
7. **`fetch` defaults to `credentials: "same-origin"`.** An absolute URL on the connection-token fetch
   drops the session cookie, and the symptom reads as an authorisation failure.
8. **PgBouncer transaction mode has no session-level advisory locks.** `pg_advisory_xact_lock` works;
   `pg_advisory_lock` does not.

---

## Honest gaps

**No password reset.** Email is never verified, so it cannot prove anything. The v1 answer is a
documented manual procedure, owned by the hardening ticket. A user who forgets their password is stuck
until the operator intervenes — a real product gap, not a detail.

**No multi-factor.** OWASP rates MFA as the strongest defence against credential stuffing. A per-IP
limiter is a weak substitute, and the weakness is named rather than implied.

**`email_verified` is a lie until someone implements verification.**

**Scale-to-zero costs latency, not data.** A suspended Neon compute resumes in a few hundred milliseconds
and storage was never at risk; what is cold is the buffer cache, so the first sign-in after five quiet
minutes is slower than the fiftieth.

**The sixty-second lease is a judgement, not a measurement.** 85 seconds of revocation latency is a good
trade for one fewer database read per minute per connection. Centrifugo's 25-second grace period is its
number; everything else is ours to have chosen differently.
