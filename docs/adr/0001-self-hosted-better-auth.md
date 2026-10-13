# 0001. Self-hosted Better Auth, not Neon Managed Better Auth

**Status:** Accepted
**Date:** 2026-10-13
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Verify Neon Managed Better Auth can actually do usernames"
**Feeds:** "Auth, onboarding and identity spec"

## Context

The map chose **Neon Managed Better Auth** over Clerk and over self-hosted Better Auth. The deciding argument was the `username()` plugin: a lowercase-unique `username` plus a separate `displayUsername` for display casing — Messenger's exact model. Clerk's native username support is Latin-only by design and cannot be opted out of, which is why Clerk lost.

Better Auth's `username()` is also Latin-only **by default**, but its validator is a plain function (`usernameValidator`), so it can be changed. That difference is the whole reason Better Auth won the comparison, and it only holds if the plugin is actually reachable.

The map named the risk openly: Managed Better Auth might not enable custom plugins, in which case "the entire auth decision collapses." This ADR records the verified answer.

## Decision

**Auth is self-hosted Better Auth, running on Neon Postgres. Neon Managed Better Auth is rejected.**

Neon Postgres is unaffected and stays — it was the database decision, and it stands. Only the managed auth *service* is dropped.

## Evidence

### Managed Better Auth cannot serve `username()` — verified on a live deployment

Not inferred from docs. Provisioned an anonymous Claimable Neon project (72h, no signup), which grants Managed Better Auth in `us-east-2` (AWS), then probed it:

- **`POST /sign-in/username` → HTTP 404**
- **`POST /is-username-available` → HTTP 404**

The service was demonstrably alive and routing — the same sweep returned `GET /ok` 200, `POST /sign-in/email` 400/401, `POST /update-user` 401, `GET /list-sessions` 401, `POST /sign-out` 200. The 404s are specific to the username routes.

Supporting evidence from the same live project:

- `neon_auth.user` has 11 columns. **No `username`, no `displayUsername`.** The only `jsonb` columns in the schema are `project_config.*` (server config), so there is no user-metadata escape hatch.
- `project_config.plugin_configs` holds exactly three plugins — `magicLink`, `phoneNumber`, `organization`. No `username`, and no supported surface for adding one.
- The SDK is not merely missing it: `@neondatabase/auth` overwrites the caller's `plugins` array with a hardcoded supported list, so `plugins: [username()]` cannot be passed from app code at all.

Note the contrast with `/phone-number/send-otp`, which also 404s. That one is 404 because the plugin is *disabled* and can be switched on. The username routes are absent from the surface entirely.

### Self-hosted Better Auth serves it correctly — verified end to end

Ran the real library against a real Postgres engine (PGlite), with the Drizzle adapter and the CLI-generated schema. All checks pass:

| Probe | Result |
|---|---|
| sign-up with `username: "Param"` | stored `username = "param"`, `displayUsername = "Param"` |
| `POST /sign-in/username` | returns a token; session user carries both fields |
| `is-username-available` | correct `available: true/false` |
| case-variant collision | `"PARAM"` correctly collides with `"param"` |
| Drizzle direct read | sees `username` and `display_username` |
| duplicate sign-up | rejected, `USERNAME_IS_ALREADY_TAKEN` |
| `getSession` | exposes both fields with no `additionalFields` config |

Validated on Better Auth **1.7.7**.

## The escape hatch was not as advertised

The map described ejecting to self-hosted as "same library, same tables — just a process you run instead of one Neon runs." **The tables are not the same.** Diffing the live managed schema against the self-hosted one:

| | Neon Managed (`neon_auth.user`) | Self-hosted (`user`) |
|---|---|---|
| `id` | `uuid` | `text` |
| email verified | `emailVerified` boolean NOT NULL | `email_verified` boolean NOT NULL default false |
| timestamps | `createdAt` timestamptz | `created_at` timestamp (no tz) |
| `role`, `banned`, `banReason`, `banExpires` | present | absent |
| `username`, `display_username` | **absent** | present |

Different primary key type, different naming convention, different timezone semantics, different column set.

**Correction, after further research.** This overstated the cost. Better Auth natively supports pointing at a non-default schema (`database.schemaName`), and `advanced.database.generateId: "uuid"` switches its id DDL from `text` to `uuid`. With those, ejecting is closer to a config change plus a forced re-login than a rewrite. One incompatibility is genuinely unfixable: the session cookie is HMAC-signed with a secret held inside Neon's service, so **sessions cannot survive any eject** — every user re-authenticates. Neon offers no official migration guide for this direction and its own agent skill warns against promising session continuity.

Whether the `neon_auth` tables can be adopted as-is is **unconfirmed**: Better Auth addresses columns by its own expected names, and the live schema stores `emailVerified` where a self-hosted install generates `email_verified`. A `npx auth check schema` against a branch clone settles it in ten minutes. This does not affect the decision — we are not adopting Managed — but it is why "eject later" was still the wrong call.

What stands regardless: **ejecting before any code exists costs nothing, and ejecting after users exist costs a forced re-login plus an unresolved schema question.** That would have been a real migration. It is not one now.

## Consequences

- **Ejecting now costs zero.** Choosing Managed and ejecting later would have cost a forced re-login for every user. Choosing self-hosted now costs nothing.
- **We run one more process.** The map already decided to self-host Centrifugo for realtime, so this is a marginal addition, not a new posture.
- **We will write our own email code.** Managed Better Auth only offers a rate-limited dev SMTP endpoint; production needs a real provider on *either* side. Self-hosted also means supplying `sendVerificationEmail` and `sendResetPassword` and their templates. Budget roughly half a day, plus a small provider bill at our scale.
- **Redis is not required.** Sessions live in Postgres with `storage: "database"`. Nothing in this decision adds a cache.
- **Pick the id strategy deliberately.** Better Auth's default id generator emits a 32-character random string into a `text` column; `advanced.database.generateId: "uuid"` switches it to a real `uuid`. Pointing a `text` default at a `uuid` column fails *silently at runtime* — seeded and existing rows keep working, only new signups break. Since we own our schema we choose deliberately rather than inheriting a default; which one vartalap wants is an auth-spec decision.
- **`username()` has no history table.** Verified: tables are `user`, `session`, `account`, `verification` only, and a rename frees the old handle immediately — `isUsernameAvailable` then reports an abandoned `@alice` as available, and signing in with it fails. For a Messenger clone that means an abandoned handle silently re-points to a stranger. Reserving released handles is a table we build, not a plugin option.
- **"Lowercase-unique" is a write-path convention, not a database invariant.** The only artifact is a plain `CREATE UNIQUE INDEX ... (username)` — not `lower(username)`. Case-folding happens in a normalizer that runs *inside the Better Auth plugin*. Verified consequence: inserting `Param` and `param` through **Drizzle directly creates two distinct users**, because that write never touches the plugin. Since vartalap writes to the user table with Drizzle, this is our realistic bug. **Mitigation: add `CREATE UNIQUE INDEX ON "user" (lower(username))` in our own migration.** Better Auth already writes normalized, so the functional index is a pure safety net — it costs nothing and catches every bypassing writer. Settle this in the auth spec, before the first migration.
- **Email is mandatory; there is no username-only signup.** No `signUpUsername` endpoint exists, and `getTempEmail` is an open, unimplemented feature request. `username()` is a second credential layered on email/password, not a replacement. This matches Messenger, which also takes a phone or email before a handle, so it is not a deviation from the target model — but it should be stated plainly rather than discovered during onboarding.
- **The validator is ASCII-only by default.** `"café"` is rejected as `INVALID_USERNAME`. Configurable via `usernameValidator`, which is the property that kept Better Auth ahead of Clerk. Deciding whether vartalap opens this up is a product question, and belongs to the auth spec.
- **Reserved words block sign-in, not just signup.** Enforcing a reserved list through `usernameValidator` makes those names 422 at `/is-username-available` rather than `available: false`, and blocks sign-in for any account holding one. If vartalap wants a reserved list it wants a hook, not a validator.
- **Validation rejects; it does not report availability.** `isUsernameAvailable` throws HTTP 422 (`USERNAME_TOO_SHORT`, `INVALID_USERNAME`, `USERNAME_TOO_LONG`) for a malformed candidate rather than returning `available: false`. The handle-availability UI must handle both shapes.
- **The shipped type lies about `username`.** It is typed `username: string`, but the runtime value is `null` for any user created without one — a social or OAuth sign-in, for instance. Do not trust the type; handle `null`.
- **1.7.7 is the current Better Auth line, not 1.4.x.** `username()` first shipped in 1.2.0-beta.18, so any 1.4.x would work, but we would be several minor lines behind on username-relevant fixes. Self-hosting pins our own version, which is an argument for it beyond the plugin gap. Separately, the 1.4.18 previously recorded as Neon's deployed version was a stale dev-dependency pin; Managed runs 1.7.6, and is GA rather than beta. Both facts matter only historically — we are not using the service.

## What would reverse this

If Neon ships `username()` on Managed Better Auth, this is worth revisiting — but only with evidence it is actually usable, not that it is planned.

Two further marks against Managed, independent of the plugin gap: it refuses to enable on projects using IP Allow or Private Networking, and it carries an open defect where Managed Auth prevents Scale to Zero, with one user reporting roughly 4× the expected compute cost.