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

Different primary key type, different naming convention, different timezone semantics, different column set. Ejecting **after** real users exist is a data migration with id remapping, not a repoint.

That would have been expensive. It is not, because vartalap has no users and no production code. **The right time to eject was before building anything**, which is where we are.

## Consequences

- **Ejecting now costs zero.** Choosing Managed and ejecting later would have cost a migration. Choosing self-hosted now costs nothing.
- **We run one more process.** The map already decided to self-host Centrifugo for realtime, so this is a marginal addition, not a new posture.
- **`username()` has no history table.** Verified: tables are `user`, `session`, `account`, `verification` only. A released handle is freed and never reserved. If vartalap ever needs handle-recycling protection, that is our table to build — a real tradeoff to take deliberately.
- **The validator is ASCII-only by default.** `"café"` is rejected as `INVALID_USERNAME`. Configurable via `usernameValidator`, which is the property that kept Better Auth ahead of Clerk. Deciding whether vartalap opens this up is a product question, and belongs to the auth spec.
- **Validation rejects; it does not report availability.** `isUsernameAvailable` throws HTTP 422 (`USERNAME_TOO_SHORT`, `INVALID_USERNAME`) for a malformed candidate rather than returning `available: false`. The handle-availability UI must handle both shapes.
- **Version 1.7.6 is deployed under Managed, not the 1.4.18 previously recorded** — that number came from a stale dev-dependency pin. Managed Better Auth is also GA, not beta, and AWS-only. These corrections matter only historically; we are not using the service.

## What would reverse this

If Neon ships `username()` on Managed Better Auth, this is worth revisiting — but only with evidence it is actually usable, not that it is planned. Managed also refuses to enable on projects using IP Allow or Private Networking, which would independently disqualify it.