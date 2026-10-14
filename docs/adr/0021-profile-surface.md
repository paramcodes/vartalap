# 0021. The profile renders what cannot be edited, and says so

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Profile and settings spec"
**Builds on:** [0016-identity-is-one-table](0016-identity-is-one-table.md) (storage),
[0016-identity-is-one-table](0016-identity-is-one-table.md) (`immutableUsername: true`),
[0018-socket-is-a-lease](0018-socket-is-a-lease.md)
(`cookieCache` off), [0007](0007-conversation-model.md) (derived direct-conversation titles),
[0008](0008-media-pipeline.md) (avatars), [0002](0002-messenger-token-layer.md) (tokens need callers)
**Teaches:** [`docs/concepts/profile-and-settings.md`](../concepts/profile-and-settings.md)

## Context

The ticket asked which profile fields are required, which are optional, and which are ever shown;
whether a handle change is permanent; and what a stranger sees. Storage was already settled by the
auth spec, and this ADR is the surface for it.

**One decision in this area was taken twice, by two agents working adjacent tickets in the same batch,
to opposite answers.** Recorded here rather than hidden, because the process failure is part of what a
reader of this repo needs.

The [profile and settings ticket](https://github.com/paramcodes/vartalap/issues/17) had the premise
that "handle changes are permanent in Better Auth". Checking the plugin source refuted it:
`username()` ships an `immutableUsername` option, enforced server-side. That agent read the premise as
false and therefore read permanence as *configurable* — and chose to allow changes, with a
`handle_history` table making availability a constraint rather than a check.

The [auth spec ticket](https://github.com/paramcodes/vartalap/issues/14) reached the same source
finding and chose the opposite product answer: `immutableUsername: true`, a handle set at signup and
never changed.

**The auth spec wins, and the reason is mechanical rather than a matter of taste.** Its enforcement is
three Postgres triggers on `user`. [0001](0001-self-hosted-better-auth.md) already identified the
realistic bug — vartalap writes to `user` with Drizzle, which never touches the plugin's normaliser —
and a trigger is the only enforcement point that catches *every* writer, including the one that has
forgotten the rules. An application-level transaction covering "our own claim endpoint" catches the
writers that go through it and leaves the bypassing one uncovered. The stronger design is the one that
does not need its callers to cooperate.

That decision also retires the question this ticket asked. **There is no rename flow to specify.**

What remains here is genuinely this ticket's: which fields the profile screen offers, what it says
when it declines to offer one, what a stranger sees, and three traps in Better Auth's plugin that
make the profile form wrong in ways no amount of careful UI work will fix.

## Decision

### The four fields, and what the screen does with each

| Field | Column | Editable | Unique | Changes |
|---|---|---|---|---|
| Handle | `user.username` | **no** | yes, and forever reserved | never |
| Handle display casing | `user.display_username` | **yes** | no | freely |
| Display name | `user.name` | **yes** | **no** | freely |
| Avatar | `user.avatar_media_id` → `media(id)` | **yes** | no | freely |

### The handle is shown, not edited — and not as a disabled field

The profile screen renders the handle as **read-only text**, with one sentence saying it is set at
signup and does not change.

**Not a greyed-out input.** [0022](0022-settings-boundary-and-transports.md) records the rule this
comes from: never render a disabled switch, because a disabled control reads as *a promise this build
has not kept yet*, and that is how a declined decision comes back two releases later as a `TODO`. A
disabled handle field would be worse than a disabled toggle, because the promise is not ours to make
twice — [0016-identity-is-one-table](0016-identity-is-one-table.md) already accepted the permanence and
records that reversing it is one config line plus a history table. Advertising the reversal as a
greyed-out field invites someone to ship it without the table.

### The display casing is editable. The handle is not.

This is the non-obvious consequence, and it only appears when the two decisions are read together.

`immutableUsername: true` blocks `user.username` from changing. It does **not** touch
`user.display_username`, which the plugin validates independently. So a user with a handle of
`param` can change how it is *displayed* — `Param`, `param`, `PARAM` — forever, while the underlying
handle is fixed.

**The profile screen therefore offers an edit on the casing and not on the handle.** That looks
inconsistent next to a read-only handle unless the copy explains it: *"This is how your handle appears.
The handle itself was set when you signed up."*

One name, two controls, different lifetimes — which is the ticket's own opening observation about
profiles, arriving in the smallest possible form.

### Display name is required at signup and free afterwards

`signUp.email` requires `name`, so it is collected at signup. It is required in the sense of
**collected**, not constrained: not unique, not validated beyond length, and defaults to the handle's
display casing. So a user who never edits it still has a name, and every direct conversation they are
in is still titled.

### Renaming yourself rewrites everyone's conversation header

The sentence this screen owes the user, and the most surprising thing on it.

[0007](0007-conversation-model.md) gives a direct conversation **no stored name and no stored picture**
— both derived from the other member. A group stores both. So changing your **display name** retitles
every direct conversation you are in, for both of you, immediately; changing your **avatar**
repictures them the same way; and a **group** changes for neither.

Nothing propagates, because there is nothing to propagate — there is no denormalised copy and no job
to fail. The cost is entirely communication: in a settings screen, "this is how I am shown" is the
natural reading and "this is how every conversation we have is titled" is the true one. **Both halves
must be stated**, because the user cannot tell which kind of conversation they are in.

### No bio

Three fields and an avatar, deliberately. A bio is other people's text about this user, surfaced in
this user's profile, with no report path in v1 — and moderation is on the hardening ticket's honest
"not yet" list. A column is not the cost here; the moderation surface is. Messenger has none either,
and "a bio if there is one" was the ticket's hedge rather than a finding.

### Avatar: one pipeline with attachments, forking only at geometry

Attaching and avataring share the worker, the server-side sniff, the image allowlist, and the rule that
**only derived variants are ever served** ([0008](0008-media-pipeline.md)). The raw upload never
reaches a browser, so an uploaded HTML file has no URL.

They differ in one thing: **what a variant is.** An attachment keeps its aspect ratio; an avatar is
square. So the media row carries a `purpose` read at ingest, and the geometry follows. Forking any
earlier would mean two upload paths, two allowlists, and two sets of bugs.

| | `thumb` | `preview` | `full` |
|---|---|---|---|
| Attachment | yes | yes | yes |
| Avatar | **128px square** | **512px square** | **none** |

**No `full` for an avatar.** Nothing renders a profile picture above a few hundred CSS pixels, and
R2's free egress — the reason R2 was chosen — does not make an object nobody fetches useful. It is
[0002](0002-messenger-token-layer.md)'s first trap in a different costume: *a token with no caller is
not a token*.

**The client crops square before it uploads**, so a 12-megapixel phone photo never crosses the wire.
The server still sniffs, still enforces a pixel cap well below `sharp`'s 268MP default, and does not
trust the crop — [0008](0008-media-pipeline.md) already showed the signing layer binds the
`Content-Type` header and not the bytes. The client crop is a courtesy to the network, not a control.

**WebP for every avatar variant**; attachments carry WebP *and* AVIF. Avatar decode happens in a list
painting fifty rows at once, and the decode-cost argument for AVIF does not survive being multiplied
by fifty. That argument is engineering judgment, not a cited measurement.

**Removing an avatar nulls the pointer; the media row survives**, because media outlives what
references it on purpose and removal is the scheduled purge, not a cascade. The picture disappears at
once and the bytes go later, which is correct and needs no explanation on screen.

**The default avatar is initials on a hue derived from the user id** — settled in the auth spec, which
is why an avatar is optional and why the settings surface is where it gets set.

### What a stranger sees

Someone in a conversation with you, opening your profile, sees **avatar, display name, handle,
presence** — and nothing else. No email, no last seen, no bio, no creation date, no conversations in
common. That last one would disclose the *existence and membership* of a conversation they are not in.

A stranger with no shared conversation sees a **search result, not a profile**: handle, display name,
avatar, enough to start a conversation and nothing more.

**vartalap is an open directory.** No blocked discovery, no friends-only, no unlisted mode. The honest
answer to "who can see my profile" is *every signed-up user*, and that follows from
[0007](0007-conversation-model.md) letting any member add any member rather than from a stance.
[0022](0022-settings-boundary-and-transports.md) records why the switch that would change this is not
built.

**There is no `/u/<handle>` route**, so no handle change can break a shared link — and none is needed.

## Traps in the plugin, found in the source

**The availability check will say yes to a handle that signup then refuses.**
[0016-identity-is-one-table](0016-identity-is-one-table.md) enforces the reserved list in a
`databaseHooks.user.create.before` hook, which is right — [0001](0001-self-hosted-better-auth.md)
recorded that a reserved list in `usernameValidator` blocks sign-in for anyone already holding one. But
the hook fires on **create**, and `/is-username-available` is a **read** against `user`. So the signup
form's live availability check reports `available: true` for `admin`, `support`, or the product's own
name, and the claim then fails.

The fix belongs to the form: the reserved list is a `Set<string>` in one module, so the availability
endpoint must consult the same module. A form that cannot distinguish *unavailable* from *reserved*
turns a correct rejection into a mystery. And the hook's `USERNAME_IS_ALREADY_TAKEN` error code is
right for this — one failure branch, and no leak that a name was reserved rather than taken.

**`displayUsername` has no fallback on update.** The `displayUsername`-from-`username` fallback is
registered under a matcher for `"/sign-up/email"` **only**. With `immutableUsername` this is narrow —
it applies to the *first* set of a handle, and to any display-name change — but the edit on the casing
described above has to send both fields deliberately rather than relying on the server to infer one.
Otherwise the casing silently freezes at whatever the signup handler recorded.

**Re-setting a user's own current handle succeeds.** The plugin compares the found user against the
session and lets it through. A form that renders "taken" on that response is wrong, and with
`immutableUsername` the only way to reach it is the first set of a handle — which is exactly when a
user is most likely to try twice.

**`session.cookieCache` silently defeats `immutableUsername`.** A second, independent reason to keep it
off, and the one nobody has written down.
[0018-socket-is-a-lease](0018-socket-is-a-lease.md) keeps
`cookieCache: { enabled: false }` because revoked sessions would otherwise stay live for `maxAge`. The
immutability guard is vulnerable to the same staleness, and more quietly: it reads
`session.user.username`, which with the cache enabled can come from the `session_data` cookie —
signed, not encrypted, and old. A tab holding a cookie minted before the handle was claimed sees
`username: null`, so `hasUsername` is false, the guard passes, and **a second handle is set from a
stale tab.** The entire identity posture rests on one boolean in a plugin; this is the config line that
silently removes it.

## Consequences

- **The profile is four controls, one of them read-only.** Every one of them has a stated lifetime,
  which is the difference between a settings screen and a form.
- **The avatar is the only asynchronous control on the page.** It uploads, is sniffed, and produces
  variants in a worker, and [0008](0008-media-pipeline.md)'s `failed` state is what gives the retry
  affordance. The pointer changes only after the media row exists.
- **One R2 egress path, two geometries.** Chosen for egress rather than price, so a fifty-row avatar
  list is cheap — which is the whole reason a dedicated 128px variant is worth having rather than a
  resize of `full`.
- **Renaming is the only edit with a reach beyond the editor.** It is also the only one with a copy
  requirement, and the copy is not optional.

## What would reverse this

**Handle immutability reverses** the moment a product requires renewable handles, as
[0016-identity-is-one-table](0016-identity-is-one-table.md) records: `immutableUsername: false` plus a
history table. The profile screen's read-only handle becomes the only control that has to be rebuilt,
and it is the *simplest* thing on the page to rebuild — which is a deliberate choice, not luck.

**The open-directory answer reverses** the moment there is a `/u/` route, a shareable link, or a
discovery policy. All three would create a real audience question, and none of them exists.