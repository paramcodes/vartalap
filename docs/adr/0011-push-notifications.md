# 0011. Push is our own sender, triggered by the outbox — never the transport's job

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Push notifications without coupling to the transport"
**Extends:** [0004](0004-message-durability.md) (the outbox row), [0005](0005-message-ordering.md) (global `seq`), [0006](0006-presence.md) (the presence key)
**Teaches:** [`docs/concepts/push-notifications.md`](../concepts/push-notifications.md)

## Context

The map chose self-hosted Centrifugo over Redis, fed by a Postgres transactional outbox. A message
reaches a member with a live connection because of that outbox row. The question this ADR settles is
what happens to everyone else — and the trap is framing push as a feature of the transport.

It is not. Push is a **second, independent consumer of the same outbox row**, with a different egress.
The socket goes out over Centrifugo; push goes out over HTTPS to a browser vendor's push service
(FCM, Mozilla autopush, Apple). Neither knows about the other, and the outbox row is the only thing
they share.

That framing was reached after checking what the vendors actually sell, and the check changed one of
the ticket's premises and one of its conclusions.

### What the vendor check found

**Centrifugo's push API is real and it is PRO-only.** The documentation lives at
`/docs/pro/push_notifications`, under Centrifugo PRO. It integrates FCM, HMS, APNs and native Web
Push (VAPID), stores device tokens in PostgreSQL, and queues sends on Redis Streams. The ticket's
claim here is **confirmed**. Since [0006](0006-presence.md) and the deployment shape both committed us
to Centrifugo **OSS**, this option was never open to us — the commercial gate is beside the point, and
the decisive fact is that our transport has no push surface at all.

**Ably does not gate push behind a paid door.** The ticket claimed "both Ably and Centrifugo sell push
behind a paid door." Ably's published pricing table lists *Native mobile and web push notification*
and, under Ably Chat, *Mobile and web push notifications* — both available in the **Free**, $0
package. That half of the claim is **false**. What survives is narrower and is the part that matters:
Ably's push is reachable only by being an Ably customer, so it couples the notification path to the
realtime transport. The commercial objection is **coupling and metering**, not a paywall.

**Centrifugo's docs sanction our composition — with a caveat the ticket skipped.** The PRO docs do say
you may "use your own device token storage and use Centrifugo PRO as a high-performance way to send
push notifications." So the ticket's "use your own subscription table" is explicitly legitimate. But
that sentence keeps **Centrifugo PRO in the send path**; it is an argument for owning token storage,
not for dropping the vendor. The inference "therefore neither is needed" is the map's, not
Centrifugo's. We reach it anyway — because our Centrifugo is OSS — but the reasoning was borrowed
and has been corrected here.

### The corrections that changed the design

**The plain `Notification` constructor does not work on mobile.** The ticket proposed "the plain
`Notification` API when the tab is hidden … works in every PWA." MDN's Notifications API is explicit:
*"If your code needs to run on mobile devices then you **must** use persistent notifications! The
`Notification()` constructor will throw a `TypeError` on most mobile browsers."* The Notifications API
is also flagged **Limited availability — not Baseline**. The v1 "no push needed" path is therefore a
desktop path, and its mobile form is `ServiceWorkerRegistration.showNotification()` from a service
worker, not a constructor call.

**It is not permission-free.** The same MDN page has a section headed *"Notifications require user
permission."* The ticket's phrasing — "needs no push permission at all" — is true only in the narrow
sense that it needs no *push subscription*. It still needs
`Notification.requestPermission()`. Any plan that treats the in-app tier as a no-prompt tier is
planning a prompt it has not budgeted.

**The Firefox quota is drawn on a different axis.** The ticket said "Firefox even applies a quota to
non-raw push messages." MDN's Push API says: *"Firefox allows a limited number (quota) of push
messages to be sent to an application, **although Push messages that generate notifications are
exempt** from this limit. The limit is refreshed each time the site is visited. In Chrome there are no
limits."* The axis is **whether the push surfaces a notification**, not raw versus non-raw. Every vartalap
push produces a visible notification, so it sits in the exempt class as documented. The quota is real,
but it constrains *silent wake pushes*, which we do not send.

**iOS install is manual, and the prompt is non-standard everywhere.** Confirmed on both counts.
web.dev: *"Chrome and Edge on iOS and iPadOS do not support PWA installation, so the
`beforeinstallprompt` event can't fire. In this case, the only option is to open the PWA using Safari,
where it is installable from the share, add to the home screen menu."* And `beforeinstallprompt` is
itself non-standard — it has been moved out of the Web App Manifest spec into a WICG incubator, and
MDN labels it **Non-standard**. So there is no standards-based programmatic install prompt on any
platform.

**One genuine surprise in favour of iOS:** Apple's own WebKit blog states that Home Screen web apps
use APNs but *"You do not need to be a member of the Apple Developer Program to use it."* For a
single operator, the cost of iOS push is **UX, not money, certificates, or an annual fee**.

## Decision

### The trigger is the outbox row, and the recipient filter is a presence `MGET`

The relay that reads the outbox for fan-out reads it a second time for push. For each member of the
conversation who is **not** the sender, it checks `presence:<userId>` ([0006](0006-presence.md)). A
live key means send nothing — the socket already delivered it. A missing key means: push to every
subscription row that member owns.

Deduplication therefore happens at **member** granularity, never at device. A member offline across
three browsers gets three notifications, and that is the correct answer: a phone in a bag and a laptop
in a sleeve should each light up. Choosing *one* device would require device identity, which
[0004](0004-message-durability.md) names as the fact that is unfixable by construction.

### The payload renders and routes, and carries nothing else

```
{ conversationId, messageId, senderName }
```

`senderName` is the notification **title**. The **body** is a fixed string ("New message"). **The
message body never enters the payload.**

The reason is the shade, not the size. Android exposes a user setting for how much notification
content shows on a secure lock screen — *"Users may elect to allow none, some, or all notification
content to be shown on a secure lock screen"* — and iOS has an equivalent "Show Previews" control.
A permissive default is common, and **the implementer does not get a say**. A body in the payload is
content copied out of Postgres into an OS notification store whose retention, backup, and pre-unlock
visibility we do not control. Encrypting it to the subscription keys (RFC 8291) protects it from the
push service; it protects it from nothing on the device.

The principle: **the payload is exactly enough to render the notification and route the tap.** A
notification must be displayable from its payload alone, because the service worker may wake with no
network — which is why `senderName` is in there and must be. It is also why the server-assigned `seq`
is **not**: the server already holds it on the outbox row, and a field no client reads is a field that
will be trusted later for something it was never sized for.

### Suppression has two layers: a presence filter, then a cancelled delayed push

The filter handles the ordinary case with no latency and no client work. It cannot see the race where
a device connects in the instant between the filter's read and the push service's delivery — which is
precisely the "notification fires while you are reading it" bug the ticket calls the single most
noticed class.

So the push is **enqueued with a short delay**, and cancelled before it fires if delivery has already
happened. Because `seq` is a single global column ([0005](0005-message-ordering.md)) and delivery is a
watermark ([0004](0004-message-durability.md)), the test is one comparison:

```
delivery.delivered_through >= message.seq   →   cancel the queued push
```

This is not an invention. It is the pattern Centrifugo's own documentation describes: *"you may send
slightly delayed push notification together with real-time message and if client provided an ack to
real-time message — cancel push notification."* We are taking a good idea from a paid product we are
not buying, which is exactly the trade this ADR makes.

A third, client-side guard was considered and **rejected**: having the service worker consult Dexie
before showing the notification. A service worker is a separate execution context racing the page for
the same storage, and the failure it adds (a notification that suppresses itself when it should not)
is worse than the one it removes.

### Subscriptions are a table we own, and the endpoint is a capability URL

One table, `push_subscriptions`, keyed on `endpoint`.

MDN is blunt about what that key is: *"The endpoint for the subscription is a unique **capability URL**:
knowledge of the endpoint is all that is necessary to send a message to your application. The endpoint
URL therefore needs to be kept secret, or other applications might be able to send push messages to
your application."* It is an authentication artefact. It is never logged, never returned by an API,
and never included in an error report or a support screenshot.

### Cleanup is push-service-driven, and there is deliberately no inactivity sweeper

A subscription dies when the push service says so. `404` or `410` on send means delete the row
immediately — this is what Centrifugo PRO does automatically and it is the behaviour we copy. The
browser half exists too: `pushsubscriptionchange` fires when a subscription *"has been invalidated, or
is about to be invalidated (e.g., when a push service sets an expiration time.)"*, at which point the
client re-subscribes and upserts the new endpoint.

What we do **not** build is a sweep that prunes by registration recency. Centrifugo's own guidance is
against it: *"leave it unset for notification-centric apps (rarely opened, but you still want to reach
them) and rely on the automatic dead-token cleanup instead."* A chat app is rarely opened. **The
subscriptions most worth pruning by age are the ones belonging to the people you most want to reach.**
Sign-out deletes explicitly; the push service does the rest.

### v1 is three tiers, and only the third needs a subscription

| tier | what it is | permission | works offline |
|---|---|---|---|
| 1 | unread badge, tab-title counter | none | n/a — client state |
| 2 | local notification when a frame lands in a hidden tab | notification permission | no |
| 3 | Web Push, behind a feature flag | notification permission **and** a subscription | yes |

Tier 2 is not a cheaper push. It is a **socket-side fallback**: it fires when a frame arrives in a tab
that is open but not visible. The socket is already connected there, so this is the narrow case push
cannot serve — pushing to a device with an open page would be pure waste. Per the correction above, its
mobile form is `registration.showNotification()` from the service worker, because
`new Notification()` throws.

### iOS gets the install instructions; it is not a separate mode

On iOS 16.4+ a Home Screen web app gets push, and the request *"can only be made in response to direct
user interaction."* There is no prompt to summon, so the app renders its own instructions. web.dev
gives the exact mechanism: show them only under `@media (display-mode: browser)`, because anything
else means the user has already installed.

This is cheap for a reason that has nothing to do with iOS: **`beforeinstallprompt` is non-standard
everywhere**, so the Chromium in-app install button is already platform-branched code. On iOS that
same branch renders instructions instead of a button. Shipping "notifications unavailable on iOS"
would save one media query and cost every iOS user the feature.

Badging came along for free, too: iOS 16.4+ Home Screen web apps support the Badging API, so the
unread badge reaches iOS once installed.

### TTL is short, and delivery is not provable

A `2xx` from a push service means **the push service accepted the request** — nothing more. The
service then holds it until *"the client comes online and the push service delivers the push message"*
or *"the message expires."* There is no receipt, and web.dev is direct that browsers do not currently
permit a push that carries no user-facing notification.

So `TTL` is the one real lever, and we set it short. A notification saying "New message" for something
sent an hour ago is worse than silence, and the cost of missing one is **zero**: the unread count is
derived from the receipt and never from a push ([`GLOSSARY.md`](../../GLOSSARY.md)), so nothing
durable depends on the send landing.

No UI may imply otherwise. Push is a hint that something happened. The receipt is the truth.

## Consequences

- **The outbox row is the only thing fan-out and push share.** Swapping Centrifugo for anything else
  touches the first consumer and leaves the second untouched. That is the decoupling the ticket
  wanted, and it is structural rather than promised.
- **We own an SSRF-shaped surface.** A push endpoint is a URL supplied by a user's browser and
  fetched later by our server — the same class as webhook delivery. Centrifugo's PRO implementation
  spells out the defences it applies: HTTPS only, no IP-literal hosts, refusal when the host resolves
  to loopback, RFC 1918, IPv6 ULA, link-local (including the cloud-metadata address) or unspecified,
  and no redirect following. Because we are writing the sender, **those are ours to implement**, and
  the cloud-metadata address in particular is not hypothetical on a cloud host.
- **Push adds a second clock to the message path** — the push service's queue and TTL, which the
  outbox knows nothing about. It is the only part of delivery we cannot make idempotent or replayable,
  and the reason the payload is a hint rather than a fact.
- **Coalescing is free and worth taking.** The Web Push protocol has a `topic` option — *"an
  optional string the push service uses to coalesce notifications,"* max 32 characters — so one topic
  per conversation collapses a burst into a single notification. Correct for a chat transcript.
- **The push service sees the endpoint and the timing, never the content.** Worth stating because it
  is the strongest privacy property here: payloads are encrypted to the subscription keys
  (RFC 8291, `aes128gcm`), so the push service sees an opaque request it must deliver and nothing in
  it. It is not privacy from the device, which is why the body is excluded above.
- **⚠️ Two platform claims are engineering judgment, not measurement.** "Every disconnected device
  lights up" and "one conversation, one coalescing topic" are correct-by-construction from the
  protocol, but nobody has published a measured engagement difference for a messenger of this size.
  They are not backed by a figure and should not be cited as though they were.
- **Firefox's quota is a constraint we are choosing not to be subject to.** As documented, pushes that
  surface a notification are exempt. That exemption is MDN's statement about Mozilla's push service,
  not a standard guarantee, and it is the reason we send **no silent pushes**: tier 1 and tier 2
  already cover "wake the client without showing anything", so nothing is lost by staying in the
  exempt class.

## What would reverse this

**Reaching for Centrifugo PRO's push API** is the obvious reversal, and it is now a *licence*
decision rather than a technical one. What we would be buying is token storage, a Redis Streams send
queue, templating, localisation, timezone-aware scheduling, and per-user rate limits — real
operational value for a single operator. What we would be giving up is the decoupling at the top of
this document, because the send would re-enter the transport.

**Sending the message body in the payload** is the reversal most likely to arrive as a
well-meaning feature request — "but then people see a preview." The answer must be that the privacy
cost is not ours to spend on their behalf, and that the OS notification store is a copy of user
content whose retention we do not control.

**Per-device delivery tracking** (Centrifugo PRO does this via `update_push_status` and ClickHouse
analytics) would give real push telemetry. It is rejected because it introduces a second truth about
delivery beside `delivery.delivered_through`, and [0004](0004-message-durability.md) already records
that per-device delivery is the one fact that cannot be retrofitted without a migration. Push
analytics would be the thing that tempts someone to try.

**Silent pushes** — wake the client, show nothing, let it sync — are what tier 1 and tier 2 already do
while a connection exists. They become interesting only for background media or search indexing, which
is out of v1. If they are ever wanted, revisit the Firefox quota paragraph above; it is the only
reason they are not on the table.