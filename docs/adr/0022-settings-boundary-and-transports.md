# 0022. Three homes for a setting, two transports for a change, and three switches that must not exist

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Profile and settings spec"
**Extends:** [0002](0002-messenger-token-layer.md) (theme), [0004](0004-message-durability.md) (transports),
[0006](0006-presence.md) (presence), [0010](0010-receipt-mechanics.md) (sharing)
**Defers to:** the auth, hardening and push tickets, all resolved by sibling agents in the same batch —
storage and `cookieCache` to [0018-socket-is-a-lease](0018-socket-is-a-lease.md),
handle immutability to [0016-identity-is-one-table](0016-identity-is-one-table.md),
deletion to [0041-erasure-is-a-tombstone](0041-erasure-is-a-tombstone.md),
rate limiting to [0043-rate-limits](0043-rate-limits.md)
**Teaches:** [`docs/concepts/profile-and-settings.md`](../concepts/profile-and-settings.md)

## Context

The ticket named the fault line precisely: *what a user chooses about themselves* and *what the
product exposes about them to others* have different audiences, different risks, and different
lifetimes, and merging them is how settings screens become unreviewable.

It then asked for the boundary explicitly — which state is local, which is synced, which is
per-conversation — calling it the most common source of settings that appear not to work on a second
device. That is right, and the answer is not a list. It is a **rule**, because a list goes stale and
a rule is checkable against a setting nobody has thought of yet.

## Decision

### One rule, three homes

**Anything needed before first paint is device-local. Anything needing the server's authority is
account-scoped. Anything scoped to a relationship lives on the membership.**

| Setting | Home | Why it lands there |
|---|---|---|
| Theme (`light` / `dark` / `system`) | **device-local** | Rendering cannot wait on a round trip |
| Notification permission | **browser, read-only** | We can read it; we cannot set it |
| Push subscription | **one row per device** | The endpoint dies with the browser |
| Display name, handle, avatar | **account-scoped** | Identity |
| Per-conversation mute | **membership** | It is a fact about a relationship |
| Read-receipt sharing | **membership** | [0010] freezes a stored position per conversation |
| Conversation density, list order | **device-local** | Perceptual, and about this screen |

**Theme is device-local, and that is the load-bearing rejection.** Syncing it would mean reading
`user_settings` before first paint to avoid a flash — trading a blocking round trip on every load for
a preference that is inherently about this screen. The rule earns its keep here: theme fails the
"needed before first paint" test, so it is local, and the flash question is answered locally too.

### The theme class is on `<html>`, set by an inline script in `<head>`, and the dark *variant* is overridden — not the *tokens*

```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));
```

```html
<head>
  <script>
    document.documentElement.classList.toggle("dark",
      localStorage.theme === "dark" ||
      (!("theme" in localStorage) &&
       matchMedia("(prefers-color-scheme: dark)").matches));
  </script>
</head>
```

This is Tailwind's own documented pattern for a manual toggle, and its docs note the script belongs
inline in `<head>` precisely to avoid the flash. "System" is the *absence* of a stored key, not a
stored value — so following the OS later needs no write, only a `matchMedia` listener.

**`@custom-variant` is not `@theme inline`, and the [0002](0002-messenger-token-layer.md) guarantee is
untouched.** Overriding a variant re-points a selector; it does not paste a literal into a utility.
The two directives are frequently confused because they both live in the same file, and conflating
them is how a well-meaning cleanup ends up freezing every token at build time and leaving `.dark`
nothing to override.

`color-scheme: light dark` goes in the theme block as a token — and per [0002]'s first trap it only
exists once something renders it, which is the `<html>` element.

### Disclosure changes are broadcasts. Privacy changes are `POST`s.

The organising sentence of this ticket, and it cuts across the settings screen in a place no field
label shows.

**Avatar and display name changes ride the realtime path.** [0007](0007-conversation-model.md) derives
a direct conversation's title and picture from the other member, so a rename has to reach them or
every conversation header is stale.

**Every privacy change is a `POST` that only the author ever sees.** Two reasons, both settled
elsewhere. [0004](0004-message-durability.md): sending is a `POST` because a socket write has no
defined failure, and a settings change must be able to say it failed. And a privacy decision put on a
fan-out channel becomes a broadcast of a private act — the frame exists, other members' connections
carry it, and "I turned off read receipts" becomes something that happens *to* the group.

Settings changes are rare and never high-frequency. There is no throughput argument for the socket,
and a strong one against it.

### Read-receipt sharing is per-conversation. There is no global switch.

The control is **per-conversation**, on the `receipt` row as `sharing boolean not null default true`.

Not on the membership, because a receipt exists for every member ([0003](0003-receipt-watermark.md))
and sharing is a fact about the receipt. Not in a separate table, because there is exactly one of
them per (conversation, member) — the same row the two positions live in.

**No global switch**, and the reason is behavioural rather than technical: a global switch invites a
user to believe that turning it off hides a read *in one conversation*, which is false and
surprising. The function people actually want from a global switch is a panic button, and leaving the
conversation serves it better.

**What the copy may and may not promise.** The honest sentence is the one the mechanism already makes
true — *you still read normally, your unread badge still works, and the other person stops seeing how
far you have read.* What it must **not** say is "invisible". [0010] is careful here and its wording
can be sharpened: the mechanism has no position leak and no discontinuity, but progress *rate* is
observable, so a share-off period shows up as a pause and then a slower-than-normal catch-up. The UI
must not promise more than [0010] already decided, and [0010]'s "no leak" is about position.

### Notifications: two stored switches, one the browser owns

`notify_on_message` on the user's settings row, `muted_at` on the membership. Effective state is
`notify_on_message AND muted_at IS NULL`, and **the UI shows the effective state** — a muted
conversation under a global "off" must not render as though notifications were on.

Both exist because they answer different complaints: "this one is too loud" and "all of it is too
loud". Per-conversation alone forces fifty toggles; global alone cannot exempt one person.

**Notification permission is not a switch.** It lives in the browser, per origin, per browser profile,
and `Notification.requestPermission()` resolves `granted` / `denied` / `default` — where `default`
means *act as if denied*. vartalap can read it and can never write it. So the control is a toggle
whose click handler is the permission request: WebKit's own wording is that the request must be "in
response to direct user interaction — such as tapping on a 'subscribe' button", and MDN says the
method should be called from the click handler. Click → request → write the stored switch → if the
browser says no, the stored switch still records the intent and the UI says the *browser* is blocking.

**Nothing in settings may imply delivery is guaranteed.** [#10](https://github.com/paramcodes/vartalap/issues/10)
settled that web push is best-effort with no receipt, and Firefox applies a quota to push messages
that do not generate notifications. "You will never miss a message" is a promise the platform cannot
keep.

**The push endpoint never appears on a settings page.** MDN states that a push endpoint is a
*capability URL* — "knowledge of the endpoint is all that is necessary to send a message to your
application" — and that "the endpoint URL therefore needs to be kept secret". A subscription row is
a stored secret, not a setting the interface renders; and MDN's warning that subscriptions must be
protected against CSRF means the same write is a `POST` like every other privacy change.

### Three switches that must not exist — and must not render as disabled

| Switch | Why not |
|---|---|
| **Last seen** | Not in v1 ([0006](0006-presence.md)). No Centrifugo primitive beats a 60s TTL, and a timestamp keyed to a user id is personal data under GDPR Art. 4(1). Rendering a dead toggle re-introduces it as a promise. |
| **Hide my active status** | Presence is a **server-side fact about a connection** ([0006](0006-presence.md)), not a disclosure the user makes. Withholding it means answering "is this person connected?" with "no", which is a lie the other member will act on. There is no switch because there is nothing to switch. |
| **Profile visibility** | Vacuous in v1. A profile is reachable only from inside a conversation, and [0007](0007-conversation-model.md) lets any member add any member — so vartalap is an **open directory**, and the honest answer to "who can see my profile" is *every signed-up user*. A control would need a discovery policy, and a discovery policy is a friend graph, which is not a v1 feature. |

**The rule underneath all three: never render a disabled switch.** A greyed toggle reads as *a promise
this build has not kept yet*, which is how a declined decision comes back two releases later as a
`TODO`. Render a **sentence** instead. "vartalap never records when you were last online" is a fact;
"Last seen: soon" is a debt.

### Export and deletion: what the screen promises, and what it may not

The **mechanism** is settled in [0041-erasure-is-a-tombstone](0041-erasure-is-a-tombstone.md) and is
not restated here. This section is only about what the settings page is allowed to say about it.

**Export ships in v1.** One authenticated endpoint returning JSON of: profile fields, memberships,
**the messages you authored**, your receipts, session metadata, and settings.

It excludes anything that is not yours: other members' messages in a shared conversation, and every
**Credential** — the glossary says a Credential "is never rendered", and an export is a rendering.
**Session tokens are excluded too**, which is not the same rule for a different reason: a token in a
downloadable file is a bearer credential. The `session` table's `userAgent` and `ipAddress` are
included; `token` is not.

**The deletion control is irreversible and the copy has to say so once, plainly, before the
confirmation.** Whether the screen hides it behind a modal is a settings decision; the endpoint is
not. And the copy must not claim anything it does not do — it does not remove your messages from
other people's transcripts, and GDPR agrees for once: Art. 17(1)(a) does not reach content others
hold, and Art. 17(3)(1) exempts freedom of expression outright.

### Sessions: the core table, and a button that is not a row

The mechanism — including `cookieCache: { enabled: false }` and the socket disconnect — belongs to
[0018-socket-is-a-lease](0018-socket-is-a-lease.md). This
section is the user-visible face of it.

The devices list is the core `session` table — `userAgent`, `ipAddress`, `createdAt`, `updatedAt` —
revoked by token through `revokeSession`, with `revokeOtherSessions` as "sign out everywhere else".
**The token is never rendered**; the device is described by its parsed user agent.

**Revoking the current session is not a row in the list.** It is *Sign out*, at the bottom. A mixed
list means one misclick locks someone out and nobody can tell which row did it.

**The `multiSession` plugin is not used.** Its documented purpose is maintaining several accounts in
one browser — account switching, which v1 does not want. It adds a `multi_session` cookie and a second
cookie's worth of state, and its `maximumSessions` (default 5) is a per-device account cap, not a
security control. Nothing the devices surface needs is in it.

**Revoking the current session is not a row in the list.** It is *Sign out*, at the bottom. A
mixed list means one misclick locks someone out and nobody can tell which row did it.

## Consequences

- **The settings page is three sections with different sync stories**, and the sync story is the only
  thing that differs. Appearance is local, notifications and privacy are the account, and per-conversation
  controls sit in the conversation.
- **A second device does not inherit the theme.** That is the decision, not an oversight, and the UI
  says "on this device" beside it.
- **Every settings change is auditable from the server's request log** — an authenticated `POST` with
  one user id. Nothing privacy-shaped exists as a broadcast frame.
- **Two settings changes are re-broadcast by proxy.** A display name change reaches the group chat via
  message authorship; an avatar change reaches it via the conversation picture. That is correct, and
  it is why those two are on the socket while the rest are not.

## What would reverse this

**Syncing the theme** reverses the moment there is a server-rendered shell that can read settings before
paint. That is a real and reachable condition, and it is the one thing that would justify it.

**A global read-receipt switch** reverses if there is ever a discovery policy — if you cannot message
a stranger, "turn it off everywhere" becomes the only lever, and the per-conversation control becomes
the exotic one.

**Profile visibility** reverses the moment there is a directory, a shareable `/u/` route, or a public
conversation link. None of those exist, and all three would create the audience question the ticket
thought was already here.