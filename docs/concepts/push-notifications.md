# Push notifications

How a message reaches someone whose browser is closed, and why that path is not the realtime
transport's job.

This is the second delivery path. The first is described in
[The message lifecycle](./message-lifecycle.md): a message is committed to Postgres with an outbox
row, a relay reads that row, and connected members receive a frame. Everything here hangs off the
same row.

Vocabulary is load-bearing: **Message**, **Conversation**, **Member**, **Receipt**, **Outbox** and
**Presence** all mean what [`GLOSSARY.md`](../../GLOSSARY.md) says they mean. In particular, **presence
is never pushed as durable state** — it is a Redis TTL key that means "connected within the last 45
seconds" ([0006](../adr/0006-presence.md)), and push reads it rather than storing it.

---

## Two paths, one trigger

```
                     ┌──────────────────────────┐
   member presses    │  messages + outbox row   │   committed in ONE transaction,
   send ────────────▶│  (same transaction)      │──▶ before the server responds
                     └────────────┬─────────────┘
                                  │
                                  ▼
                         the relay reads it
                        ╱                  ╲
              path A: fan-out         path B: push
              Centrifugo, over         HTTPS to the browser's push
              Redis, to connected     service (FCM / autopush /
              members                 Apple), to everyone else
```

Path A is what [0004](../adr/0004-message-durability.md) is about. Path B is this document.

The two paths share exactly one thing: the outbox row. They do not share a broker, a client SDK, a
protocol, or a failure mode. **Neither of them is the transport.** Path A goes through Centrifugo;
path B goes out over ordinary HTTPS to whichever push service the user's browser vendor runs. Our
Centrifugo deployment is OSS and has no push API at all, which is why this document exists rather
than a configuration section.

Everything on this page follows from that seam. If you remember one thing: **the outbox row is the
trigger, and everything after it is a separate system.**

---

## Who gets a push

For every member of the conversation except the sender, the relay asks one question: *is this person
connected?*

That answer is `presence:<userId>` in Redis, the same key that paints the green dot. A live key means
**send nothing** — path A already delivered the message over the socket. A missing key means path B
runs.

The whole recipient filter is that comparison, and it is cheap because it is an `MGET` across the
member set, run alongside the fan-out that is happening anyway.

### Every device, or one?

A member who is offline everywhere might own three subscriptions. All three light up.

Deduplication happens at **member** granularity, never device. The reasoning is not politeness, it is
that device-granularity would require a way to choose a device, and choosing a device requires device
identity in the delivery record — which [0004](../adr/0004-message-durability.md) rules out as the one
fact that cannot be added later without a migration. **A phone in a bag and a laptop in a sleeve
should each light up.** That is not a side effect; it is the answer.

---

## The race worth designing for

> *A notification arrives while the tab is open and the socket is connected. The socket already
> delivered the message. The notification must not fire.*

This is the single most-noticed class of push bug, and a presence check alone does not fix it. The
filter reads presence at time *T*; the push service delivers at time *T + ε*. A device that connects
inside that window gets both the frame and the notification, and the person is looking straight at
the message when their phone buzzes.

Two layers fix it.

### Layer one — the filter

Already described. Handles every ordinary case at zero latency.

### Layer two — a delayed push, cancelled on acknowledgement

The push is not sent immediately. It is queued with a short delay, and before it fires the relay
re-checks one comparison:

```
delivery.delivered_through >= message.seq   →   drop it
```

Because `seq` is a **single global column** ([0005](../adr/0005-message-ordering.md)) and delivery is
a **watermark** ([0004](../adr/0004-message-durability.md)), this is a single integer comparison
against a row that already exists and is already indexed. No new table, no new protocol frame, no
per-message bookkeeping.

If the member is genuinely offline, their watermark does not move, nothing is cancelled, and the push
goes out after the delay.

> This pattern is not ours. It is what Centrifugo's own documentation describes — send a slightly
> delayed push alongside the real-time message, and cancel it if the client acknowledged the real-time
> message. We are taking one good idea from a product we are not buying.

### Layer three — the one we rejected

Having the service worker consult Dexie before showing a notification. A service worker is a separate
execution context racing the open page for the same storage. It adds a failure — a notification that
*suppresses itself when it should not* — which is worse than the one it removes, because you cannot
see it.

---

## What is in the payload

```
{ conversationId, messageId, senderName }
```

`senderName` is the notification **title**. The **body** is a fixed string. **The message body never
enters the payload.**

This is a privacy decision before it is a size decision, and the exposure is the notification shade.
Android exposes a user setting for how much notification content appears on a secure lock screen —
*"users may elect to allow none, some, or all notification content"* — and iOS has an equivalent
"Show Previews" control. The default is commonly permissive, and **the implementer does not get a say.**

A body in the payload is message content copied out of Postgres into an operating-system notification
store whose retention, backup behaviour and pre-unlock visibility we do not control. Web Push
encrypts payloads to the subscription keys (RFC 8291), so the push service never sees the content —
but that protects it from the push service, and from nothing on the device.

### The rule to remember

**The payload is exactly enough to render the notification and route the tap.** Nothing more.

That rule cuts both ways and explains both halves:

- **`senderName` is in there** because the service worker may wake with no network. A notification that
  needs a fetch to render is a notification that shows a blank box offline.
- **`seq` is not in there** because the server already holds it on the outbox row. A field no client
  reads is a field someone will later trust for something it was never sized for.

---

## The subscription lifecycle

### Storing it

One table, `push_subscriptions`, keyed on `endpoint`.

> **⚠️ The endpoint is a capability URL, and it is a credential.** MDN: *"knowledge of the endpoint is
> all that is necessary to send a message to your application. The endpoint URL therefore needs to be
> kept secret, or other applications might be able to send push messages to your application."*
> Anyone holding it can push to that device. It is never logged, never returned by an API, and never
> in an error report or a support screenshot.

### Killing it

A subscription dies when the push service says so, and it says so precisely:

- **`404` or `410` on send** → delete the row immediately. This is the whole cleanup story, and it is
  what Centrifugo PRO does automatically.
- **`pushsubscriptionchange` in the browser** → the subscription "has been invalidated, or is about to
  be invalidated". The client re-subscribes and upserts the new endpoint.
- **Sign-out** → delete explicitly.

### The sweeper we are not building

There is no job that prunes subscriptions by age. Centrifugo's own guidance argues against it:
*"leave it unset for notification-centric apps (rarely opened, but you still want to reach them) and
rely on the automatic dead-token cleanup instead."*

A chat app is rarely opened. **The subscriptions you would prune by age belong to the people you most
want to reach.** A table that only grows is a smaller problem than a table that quietly forgets.

---

## Three tiers, and only the last one needs a subscription

| tier | what it is | permission needed | survives a closed browser |
|---|---|---|---|
| 1 | unread badge, tab-title counter | none | no — it is client state |
| 2 | local notification when a frame lands in a hidden tab | notification permission | no |
| 3 | Web Push, behind a feature flag | notification permission **and** a subscription | yes |

Two corrections to what is usually assumed about tiers 1 and 2, both from MDN:

**`new Notification()` throws on mobile.** *"If your code needs to run on mobile devices then you must
use persistent notifications! The `Notification()` constructor will throw a `TypeError` on most mobile
browsers."* The mobile form is `ServiceWorkerRegistration.showNotification()` from a service worker.
The Notifications API is also flagged **Limited availability — not Baseline**.

**Tier 2 is not permission-free.** There is a section on that page headed *"Notifications require user
permission."* Tier 2 needs no *push subscription*; it very much needs
`Notification.requestPermission()`. Budget for the prompt.

### What tier 2 is actually for

Not a cheaper push. It is a **socket-side fallback**: a frame arrives, the tab is open but not visible,
so show a notification. Push is useless in that case by definition — the page is open, the socket is
already connected, and waking a device that is already awake is waste.

---

## iOS

Push on iOS requires the app to be added to the **Home Screen** (16.4+), and the permission request
*"can only be made in response to direct user interaction."*

**There is no prompt to summon.** `beforeinstallprompt` is **non-standard** — it has been moved out of
the Web App Manifest spec into a WICG incubator — and on iOS it does not fire at all: *"Chrome and
Edge on iOS and iPadOS do not support PWA installation, so the `beforeinstallprompt` event can't
fire. In this case, the only option is to open the PWA using Safari, where it is installable from the
share, add to the home screen menu."*

So on iOS the app renders its own instructions, gated on the one media query web.dev recommends:

```css
#installInstructions { display: none; }
@media (display-mode: browser) {
  /* nothing else means the user has already installed */
  #installInstructions { display: block; }
}
```

**This is not an iOS-specific cost.** Because `beforeinstallprompt` is non-standard everywhere, the
Chromium install button is already platform-branched code. On iOS that branch renders text instead of
a button. Declining iOS would save one media query and cost every iOS user the entire feature.

Two things arrived with it that are worth knowing:

- **No Apple Developer Program membership is required.** WebKit: Home Screen web apps use APNs, but
  *"You do not need to be a member of the Apple Developer Program to use it."* For a single operator
  the cost of iOS push is UX, not money or certificates.
- **The Badging API works on iOS 16.4+**, so the tier-1 unread badge reaches installed iOS too.

---

## Delivery is a hint, and nothing may say otherwise

A `2xx` from a push service means **the push service accepted the request**. It does not mean a
device displayed anything. The service then holds the message until *"the client comes online and the
push service delivers the push message"* or *"the message expires."* There is no delivery receipt.

So:

- **`TTL` is the only real lever, and it should be short.** A "New message" notification for something
  sent an hour ago is worse than silence.
- **Missing a push costs nothing.** The unread count is derived from the receipt and never from a
  push ([`GLOSSARY.md`](../../GLOSSARY.md)), so no durable fact depends on the send landing. This is
  what makes a short TTL free.
- **No UI implies delivery.** Push is a hint that something happened. The receipt is the truth. The
  existing delivery and receipt model already satisfies this; push just has to not break it.

### Firefox's quota

MDN: *"Firefox allows a limited number (quota) of push messages to be sent to an application,
although Push messages that generate notifications are exempt from this limit. The limit is refreshed
each time the site is visited. In Chrome there are no limits."*

Note the axis. It is **not** raw versus non-raw payloads — it is whether the push surfaces a
notification. Every vartalap push does, so we sit in the exempt class. The quota is real, and it is
the reason we send **no silent pushes**; tiers 1 and 2 already cover "change state without showing
anything" while a connection exists.

### Coalescing

The Web Push protocol has a `topic` option: *"an optional string the push service uses to coalesce
notifications,"* 32 characters maximum. One topic per conversation means a burst of messages collapses
into a single notification, which is what a chat transcript should do. Free, and at the protocol
level.

---

## Traps on this path

1. **The endpoint is a credential.** Log it once and anyone with the log can push to that device.
   This is the one on this page that is an incident rather than a bug.
2. **`new Notification()` throws on mobile.** The desktop path you tested is not the mobile path. Use
   `registration.showNotification()`.
3. **A local notification still needs permission.** It needs no *subscription*; it needs
   `requestPermission()`. Do not skip the prompt.
4. **Do not prune subscriptions by age.** The people you most want to reach are the ones who open the
   app least.
5. **Suppression must not live only in the client.** A service worker reading Dexie races the open
   page. Suppress on the server, cancel on the delivery watermark.
6. **Safari rejects a localhost VAPID subject.** `web-push` documents that a VAPID `subject` pointing
   at `https://localhost` gets `BadJwtToken` from Safari's push endpoint (`403 BadJwtToken` from Apple
   Push). Use a real `mailto:` or `https:` contact URI. This bites in development, where the origin
   *is* localhost, and it looks like an auth bug rather than a config bug.
7. **The push endpoint is user-supplied and we fetch it later.** That is the SSRF shape. Centrifugo's
   PRO implementation — which we read while designing ours — enforces HTTPS only, rejects IP-literal
   hosts, refuses hosts that resolve to loopback, RFC 1918, IPv6 ULA, link-local (including the
   cloud-metadata address) or unspecified, and does not follow redirects. **Because we wrote the
   sender, that is our code, not their option.**
8. **Two platform claims here are engineering judgment, not measurement**: that every disconnected
   device should light up, and that one topic per conversation is the right coalescing. Both follow
   from the protocol, and neither is backed by a published engagement figure. Do not cite a number.

---

## Where this stops

**Presence is read here, never pushed.** The filter consults `presence:<userId>`; it does not store
it, replicate it, or treat a push as evidence of presence. A member who is online on a device with no
push subscription is online, full stop.

**A push is not a Receipt.** It carries `messageId` so the tap can navigate. It advances nothing. The
receipt advances when the conversation is shown, which is a different event with a different
meaning, and the two never meet — see [Message receipts](./message-receipts.md).

**The reasoning behind every decision here** is in
[`docs/adr/0011`](../adr/0011-push-notifications.md), including what the vendor check found, which of
the ticket's premises it corrected, and the four reversals worth naming in advance.