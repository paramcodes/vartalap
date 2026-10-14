# 0023. A handle is claimed through us, and every handle a user has held stays theirs

**Status:** ⚠️ **Superseded** — kept because sibling ADRs cite its verified findings
**Date:** 2026-10-14
**Written by:** the profile and settings ticket (#17), as an agent delegated decisions by the human
**Superseded by:** [0016-identity-is-one-table](0016-identity-is-one-table.md) and
[0017-handle-alphabet](0017-handle-alphabet.md) (auth ticket #14); surface consequences in
[0021-profile-surface](0021-profile-surface.md)
**This is not the decision.** Two agents working adjacent tickets in the same batch reached opposite
answers on the same source, and this document is the losing side, kept rather than deleted because
four other ADRs cite findings from it.

## What it decided, and why it lost

It decided that **handle changes are allowed** — once per 7 days — with a `handle_history` table whose
`UNIQUE (username)` makes availability a constraint rather than a check, so no handle is ever released
to anyone but its holder.

The auth ticket decided **`immutableUsername: true`**, enforced by Postgres triggers on `user`.

The auth ticket wins, and the reason is mechanical rather than a matter of taste. ADR 0001 had already
identified the realistic bug: vartalap writes to `user` with Drizzle, which never touches the plugin's
normaliser. **A trigger is the only enforcement point that catches every writer, including the one that
has forgotten the rules.** An application-level transaction covering "our own claim endpoint" covers
its callers and leaves the bypassing writer uncovered. The stronger design is the one that does not
need its callers to cooperate.

The premise this document was correcting was real and is preserved in [0021](0021-profile-surface.md):
"handle changes are permanent in Better Auth" was false. `username()` ships `immutableUsername`,
enforced server-side.

## Verified findings that survive, and where they now live

These are read off Better Auth's `username()` plugin source, not inferred from docs, and other ADRs
cite them:

- **The immutability guard reads `session.user.username`.** With `session.cookieCache` enabled that
  `user` can come from the `session_data` cookie — signed, not encrypted, and stale. A tab holding a
  cookie minted before the handle was claimed sees `username: null`, so `hasUsername` is false and the
  guard passes. **The entire identity posture rests on one plugin boolean, and one config line
  silently removes it.** → [0021](0021-profile-surface.md).
- **There is no reservation hook.** The only availability check in the source is `findOne` on the
  `user` model; `usernameValidator` is a synchronous boolean that cannot reach a database; and
  `disabledPaths` removes an endpoint rather than extending one. ADR 0001 said a reserved list needs
  "a hook, not a validator" — the source says there is no hook at all. →
  [0016-identity-is-one-table](0016-identity-is-one-table.md).
- **Re-setting a user's own current handle succeeds.** The plugin compares the found user against the
  session and lets it through, so a form that renders "taken" on that response is wrong. →
  [0021](0021-profile-surface.md).
- **`displayUsername` has no fallback on update.** The fallback-from-`username` is registered under a
  matcher for `"/sign-up/email"` only. → [0021](0021-profile-surface.md).

## One thing it got wrong about its own design

Its partial unique index (`where released_at is null`) is safe, and it said so — but its reason was
almost stated as the trap. ADR 0007's recorded trap is a partial index whose predicate contains a
**parameter** (`user_id = $1`), which a prepared statement can never prove. That is the failure mode;
a literal predicate is not it. Worth keeping in mind when reading the "no partial indexes" rule
against any new table.

## What is left open

Nothing that was decided here is left hanging. The open question — whether vartalap ever needs
renewable handles — is recorded, with its trigger, in [0017-handle-alphabet](0017-handle-alphabet.md).