# Profile and settings

What a person controls about themselves, and who else gets to see it. These are two different
surfaces that share a screen, and the reason they are separate is not tidiness — they have different
audiences, different failure modes, and different lifetimes.

The decisions are in [0021](../adr/0021-profile-surface.md) (the profile half) and
[0022](../adr/0022-settings-boundary-and-transports.md) (the settings half). The handle's permanence is
not decided here — it is
[0016-identity-is-one-table](../adr/0016-identity-is-one-table.md), from the auth ticket. This document is the
tour: what the screen is, what it says, and the traps that only show up once someone builds it.

---

## The split

**Profile** — things a user chooses *about themselves*, which the product then shows to everyone they
have a conversation with. Display name, handle, avatar. Chosen once and then re-chosen.

**Settings** — things a user chooses *for themselves*, which nothing else ever observes. Theme,
notifications, read-receipt sharing, mute, sessions, data. None of it appears in another member's
view, ever.

The failure mode of merging them is not a messy layout. It is that a field acquires an audience
nobody chose for it — a preference becomes an observation, and the settings page starts having
disclosure consequences nobody reviewed.

---

## Profile

### The four fields, and what each one is

| Field | Column | Required | Unique | Changes |
|---|---|---|---|---|
| **Handle** | `user.username` (normalised, lowercase) | yes, at signup | yes, across every user | **never** |
| **Handle display casing** | `user.display_username` | no — defaults from the handle | no | **freely** |
| **Display name** | `user.name` | yes, at signup | **no** | freely, and it propagates |
| **Avatar** | `user.avatar_media_id` → `media(id)` | no | no | freely, and it propagates |

**All four live on Better Auth's `user` table.** There is no profile table, and that is settled —
[0016-identity-is-one-table](../adr/0016-identity-is-one-table.md) rejects one on the grounds that a
one-row-per-user table beside `user` is a second thing that can disagree about whether it exists.
`avatar_media_id` is a column we add, not `user.image` (a URL string the social providers write,
which cannot express "one of our stored media rows").

Better Auth hosts no avatar of its own, which is why one thumbnail pipeline serves both profile
pictures and message attachments.

**Display name is required at the auth layer**, because `signUp.email` requires `name`. It is
required in the sense of *collected*, not in the sense of *constrained*: it may be anything, it need
not be distinct, and the default is the handle's own display casing. So a user who never edits it
still has a sensible name, and every direct conversation they belong to is still titled.

### The display name is not yours alone

This is the sentence the settings screen owes the user, and it is the most surprising thing on it.

[0007](../adr/0007-conversation-model.md) gives a direct conversation **no stored name and no stored
picture at all** — both are derived from the other member. A group stores both. So:

- change your **display name** → every direct conversation you are in is retitled, for both of you,
  immediately. A group's header does not change.
- change your **avatar** → same split. Direct conversations repicture; groups do not.

Nothing propagates, because there is nothing to propagate — there is no denormalised copy to keep in
sync, and no job to go wrong. The cost is that the user must be *told*, because in a settings screen
"this is how I am shown" is the natural reading and "this is how every conversation we have is
titled" is the true one.

The UI must state both halves. A member who renames to something unprofessional and then sees eleven
chat headers change is not going to read a tooltip.

### No bio

**There is no bio field in v1.** Not because a column is expensive — it is not — but because every
field added is a field to moderate, and moderation is on the hardening ticket's honest "not yet" list.
A bio is other people's text about this user, surfaced in this user's profile, with no report path in
v1. Messenger has none either; "a bio if there is one" was the ticket's hedge, not a finding.

The profile is deliberately three fields, and that is the moderation surface for v1.

---

## The avatar

An avatar is **a reference to media**, not a distinct kind of thing ([`GLOSSARY.md`](../../GLOSSARY.md)).
It runs through the identical pipeline as a message attachment
([0008](../adr/0008-media-pipeline.md)): presigned upload to R2, a worker that **sniffs the bytes**,
an image allowlist, and **only derived variants are ever served**. The raw upload never reaches a
browser, so an uploaded HTML file has no URL at all.

### One pipeline, one allowlist, two geometries

Attachments and avatars share the worker, the sniffing, the allowlist and the variant machinery. They
differ in one thing: **what a variant is**. An attachment keeps its aspect ratio; an avatar is square.

So the media row carries a `purpose`, read at ingest, and the variant geometry follows from it. This
is the point where the pipeline forks, and forking any earlier would mean two upload paths, two
allowlists, and two sets of bugs.

| | `thumb` | `preview` | `full` |
|---|---|---|---|
| Attachment | yes | yes | yes |
| Avatar | **128px square** | **512px square** | **none** |

**No `full` for an avatar.** Nothing renders a profile picture above a few hundred CSS pixels, and R2
egress being free — the reason R2 was chosen — does not make an object nobody fetches useful. It is
[0002](../adr/0002-messenger-token-layer.md)'s first trap wearing different clothes: *a token with no
caller is not a token*. A variant with no renderer is storage you pay to write and never read.

### Square at ingest, in the browser before upload

**The client crops to a square before it uploads**, so a 12-megapixel phone photo never crosses the
wire, and the server's resize is a plain scale with no per-request crop decision.

The server still sniffs, still enforces the pixel cap well below `sharp`'s 268MP default, and does not
trust the crop — the client is the untrusted party, exactly as in [0008], where the signature binds
the `Content-Type` header and not the bytes. The client-side crop is a courtesy to the network, not a
control.

Formats: **WebP for every avatar variant.** Attachment variants carry WebP *and* AVIF. Avatar decode
happens in a list that paints fifty rows at once, and the decode-cost argument for AVIF does not
survive being multiplied by fifty. That argument is engineering judgment, not a cited measurement,
and is labelled as such.

### Removing an avatar

The pointer is nulled; the media row **survives**. Media outlives what references it on purpose, and
removal is the scheduled purge from [0008], not a cascade. So "remove" makes the picture disappear
instantly and the bytes disappear later — which is correct, and which the UI does not need to explain.

---

## The handle: shown, not edited

The handle is set at signup and **never changes** — decided in
[0016-identity-is-one-table](../adr/0016-identity-is-one-table.md), not here. `immutableUsername: true` plus
a Postgres trigger on `user` means there is no release path to attack, and no rename flow for this
screen to specify.

So the profile shows it as **read-only text with one sentence of explanation**. Not a greyed-out input:
a disabled control reads as *a promise this build has not kept yet*, and reversing immutability is
one config line plus a history table — which means advertising the reversal invites shipping it
without the table.

**The display casing is editable.** `immutableUsername` blocks `user.username` and does not touch
`user.display_username`. So a user can change how `@param` *appears* — `Param`, `PARAM` — forever,
while the handle underneath is fixed. One name, two controls, different lifetimes, which is the
ticket's own opening observation arriving in its smallest possible form.

The copy explains it: *"This is how your handle appears. The handle itself was set when you signed up."*

### Three things the form gets right, each because the source says so

1. **The availability check will say yes to a handle that signup then refuses.** Reserved names are
   enforced in a create hook, and `/is-username-available` is a read against `user` — so `admin`
   reports `available: true` and the claim fails. The form must consult the same reserved list, or a
   correct rejection becomes a mystery.
2. **Send `displayUsername` with anything that touches a handle.** Its fallback-from-`username` is
   registered for `/sign-up/email` **only**, so nothing downstream infers it.
3. **Handle two error shapes.** A malformed candidate is rejected with HTTP 422 rather than answered
   `available: false`; a genuine collision is a different error; and **re-setting your own current
   handle succeeds**, because the plugin compares the found user against the session and lets it
   through. A form that renders "taken" there is wrong.

### There is no profile link to break

v1 publishes no `/u/<handle>` route, so nothing can share a link that a permanent handle would have to
keep working. When one is built, the reservation table means it resolves correctly from the start.

---

## What a stranger sees

Someone in a conversation with you, opening your profile, sees four things:

**Avatar · display name · handle · presence** (if you share a conversation).

And nothing else. No email, no last seen, no bio, no account creation date, no conversations in common
— that last one would disclose the *existence and membership* of a conversation they are not in.

**A stranger with no shared conversation sees a search result, not a profile.** Handle search returns
a handle, a display name and an avatar, which is enough to start a conversation and nothing more,
because [0007](../adr/0007-conversation-model.md) lets any member add any member.

**vartalap is an open directory.** There is no blocked discovery, no friends-only, no unlisted mode.
The honest answer to "who can see my profile" is *every signed-up user*, and that is a consequence of
the membership model rather than a stance.

---

## Settings

### Three homes, one rule

**Anything needed before first paint is device-local. Anything needing the server's authority is
account-scoped. Anything scoped to a relationship lives on the membership.**

| Home | Settings |
|---|---|
| **Device-local** | Theme; conversation density and order |
| **Account-scoped** | `notify_on_message`; display name, handle, avatar |
| **Membership** | `muted_at`; `receipt.sharing` |
| **Browser, and read-only for us** | Notification permission |
| **Per-device** | Push subscription |

The rule earns its keep on theme: syncing it would mean reading settings before first paint to avoid
a flash, which trades a blocking round trip on every load for a preference that is about this screen.

### Appearance

Three states — light, dark, system — as a class on `<html>`, set by an inline `<head>` script, with
`@custom-variant dark (&:where(.dark, .dark *))` overriding the *variant*. The [0002](../adr/0002-messenger-token-layer.md)
guarantee is untouched: overriding a variant re-points a selector, it does not paste literals into
utilities the way `@theme inline` does. System is the *absence* of a stored key, not a stored value,
so following the OS later needs no write.

The control says **"on this device"**, because that is true.

### Notifications

Two stored switches — `notify_on_message` and per-conversation `muted_at` — because they answer
different complaints: *this one is too loud* and *all of it is too loud*. Effective state is
`notify_on_message AND not muted`, **and the UI shows the effective state**.

The permission itself is not a switch. It belongs to the browser, per origin, per profile, and
`Notification.requestPermission()` can only be called from a gesture — WebKit's wording is "in
response to direct user interaction — such as tapping on a 'subscribe' button". So the toggle's click
handler *is* the permission request, and a denial writes the stored switch anyway and says the
browser is blocking.

Nothing here may imply delivery is guaranteed. Web push has no receipt, Firefox applies a quota to
push messages that do not generate notifications, and a browser may drop one silently.

**The push endpoint is never rendered.** MDN calls it a *capability URL*: knowing it is all that is
needed to send to this app, so it stays a stored secret in a row, not a field on a screen.

### Privacy

`receipt.sharing`, per conversation. Turning it off:

- your own reading is unaffected, and your unread badge keeps working
- the other member stops seeing how far you have read
- turning it back on resumes from the frozen position

**There is no global receipt switch.** A user who turns one off expecting it to hide a read in one
conversation has been told something false, and the remedy they actually want — leaving — is one tap
away.

What the copy must not say: *invisible*. There is no position leak and no discontinuity, but progress
**rate** is observable, so a share-off period shows up as a pause and then a slow catch-up.

### Three switches that are not there

**Last seen.** Not in v1 ([0006](../adr/0006-presence.md)). No Centrifugo primitive beats a 60s TTL,
and a timestamp keyed to a user id is personal data under GDPR Art. 4(1).

**Hide my active status.** Presence is a server-side fact about a *connection*, not a disclosure the
user makes. Withholding it means answering "is this person connected?" with "no" — a lie the other
member acts on. There is no switch because there is nothing to switch.

**Profile visibility.** Vacuous: a profile is reachable only from inside a conversation, and any
member may add any member. A real control needs a discovery policy, and a discovery policy is a friend
graph.

> **Never render a disabled switch.** A greyed toggle reads as *a promise this build has not kept
> yet*, which is exactly how a declined decision returns two releases later as a `TODO`. Render a
> **sentence**. "vartalap never records when you were last online" is a fact. "Last seen: soon" is a
> debt.

### Data

**Export ships.** JSON of your profile fields, memberships, **the messages you authored**, your
receipts, session metadata, and settings. Not other members' messages. Not any **Credential** — the
glossary says one is never rendered, and an export is a rendering. Not session **tokens**: that is a
different rule for a different reason, because a token in a downloaded file is a bearer credential.

**Delete anonymises the author and then removes your own state** — the mechanism is
[0041-erasure-is-a-tombstone](../adr/0041-erasure-is-a-tombstone.md). What this screen owns is the
copy: it does not remove your messages from other people's transcripts, and GDPR is unusually aligned
that it should not — Art. 17(1)(a) does not reach content others hold, and Art. 17(3)(1) exempts
freedom of expression outright. Say that once, plainly, before the confirmation. Do not claim anything
the endpoint does not do.

### Sessions and devices

The core `session` table: user agent, IP, created, last seen, revoked by token. **The token is never
rendered.** "Sign out everywhere else" is `revokeOtherSessions`. **Sign out is not a row in the list**
— it is the button at the bottom, so a misclick cannot lock someone out with an unidentifiable row.

**`session.cookieCache` is off in v1**, for the reason
[0018-socket-is-a-lease](../adr/0018-socket-is-a-lease.md)
gives: with it on, "revoked sessions may remain active on other devices until the cookie cache
expires", so a screen offering *revoke this device* has a device that stays alive.

It has a second, quieter reason nobody had written down, and the whole identity posture rests on it:
the `immutableUsername` guard reads `session.user.username`, and a stale `session_data` cookie reports
`null` — so a tab holding a cookie minted before signup could set a **second handle**. One config line,
two unrelated guarantees, and the dependency between them is invisible unless written down.

**The `multiSession` plugin is not used.** It is for account switching in one browser, which v1 does
not want; it adds a cookie, and its `maximumSessions` cap is per-device accounts, not a security
control.

---

## What crosses the wire, and how

**Disclosure changes ride the socket.** Avatar and display name must reach other members, because
direct conversations derive their title and picture from them — otherwise every header goes stale.

**Privacy changes are `POST`s only the author ever sees.** Two settled reasons converge here. Sending
is a `POST` because a socket write has no defined failure, and a settings change has to be able to say
it failed ([0004](../adr/0004-message-durability.md)). And a privacy decision on a fan-out channel is
a broadcast of a private act — the frame exists, other members' connections carry it, and "I turned
off read receipts" becomes something that happens *to* the group.

That is the sentence that organises the whole screen, and it is invisible in the UI because it is a
property of the transport rather than the layout.

---

## Traps for whoever builds this

- **A token with no caller is not a token.** The same rule that ate `--radius-xl` in [0002](../adr/0002-messenger-token-layer.md)
  eats the avatar `full` variant. If nothing renders it, do not emit it.
- **Never `@theme inline`.** Overriding the dark *variant* is not the same act; conflating them is how
  a cleanup freezes every token and leaves `.dark` nothing to override.
- **A stale session silently defeats a server-side guard.** `cookieCache` + `immutableUsername` is the
  concrete case: a cached `username: null` passes a check that a fresh read would fail.
- **A `displayUsername` fallback that only exists at signup** is not a fallback.
- **A read path and a write path can disagree about the same rule.** Reserved names are enforced on
  *create*, and the availability check is a *read* — so it will say yes to a name that signup refuses.
- **A hook that fires on commit cannot inform the check that ran before it.** That is the shape of the
  bug above, and it is the general one: any validation that lives only on the write path is invisible
  to every live check the interface makes.
- **Show the effective notification state**, not the stored switch. Muted under global-off reads as on.
- **A settings screen must not imply delivery, guarantee, or invisibility.** None of the three is
  available, and all three are one copy edit away from being promised.