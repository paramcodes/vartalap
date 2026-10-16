# The composer, and what sending actually does

The one screen that is used on every single message. Everything in vartalap that is clever is
invisible here, and that is the design target: the optimistic write, the durable send queue, the
idempotency key and the server-assigned position all exist so that **this screen never waits**.

Read after [the message lifecycle](./message-lifecycle.md), which specifies the send path this
screen begins, and [the chat view](./conversation-list-and-chat-view.md), which owns the bands above
and below this one.

Decisions are in [0050](../adr/0050-the-composer-is-chosen-here.md) (the shape and copy are **chosen
here**, not inherited), [0051](../adr/0051-enter-to-send-needs-three-guards.md) (the IME rule),
[0052](../adr/0052-media-is-staged-before-the-message-exists.md) (staging, and why there is no upload
percentage), and [0053](../adr/0053-nothing-is-retracted.md) (wait and discard).

Vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md) and is binding. **Draft**, **Queued send**,
**Send queue**, **Staged file**, **Media** and **Attachment** are six different things and this screen
holds all six at once.

---

## What this document owns, and what it does not

**It owns** the composer's shape, its copy, its accessible names, what every control does, the
five things that can be true of a message the member just sent, and the whole media path from
"picked a file" to "the bytes are in someone else's transcript".

**It inherits without re-opening** the auto-grow ceiling, the Enter/Shift+Enter contract, the draft
lifecycle, the locked-conversation sentences, and the connection banner — all of which belong to
[the chat view](./conversation-list-and-chat-view.md#the-composer). Where this document contradicts
one of them, it says so and says why.

**It does not own** the socket, the outbox, the receipt, or anything on the server. It never
specifies that the message arrives.

> **Everything visual in this document was chosen, not observed.**
> [ADR 0002](../adr/0002-messenger-token-layer.md) marked the composer UNVERIFIED because its copy
> and shape were never sourced, and handed the problem forward. [ADR 0050](../adr/0050-the-composer-is-chosen-here.md)
> closes that item by choosing, and every value below should be read as an argument rather than as a
> measurement. Nothing here has been rendered.

---

# Part one — the surface

## The shape

```
┌───────────────────────────────────────────────┐
│  ( + )  Message…                              │        ( ➤ )
└───────────────────────────────────────────────┘
```

One rounded surface at `--radius-2xl`, holding the attach button at its inline-start and the field
beside it; the send button **outside** at the inline-end.

**The asymmetry is the decision.** Send inside the surface means the control being pressed grows with
the text being sent. Send outside means the target a member aims at is the same size in the same
place from the first keystroke to the two-thousandth.

Three tokens define it, and all three are **UNVERIFIED — chosen values**, since Messenger's were
never captured:

| token | light | dark | used by |
|---|---|---|---|
| `--surface-composer` | `#FFFFFF` | a grey one step off the app background | the field surface |
| `--accent` | `#0084FF` | **unchanged** | the send button |
| `--danger` | a red | one step lighter | a failed tile, and the failed-row border the chat view already specified |

The dark value of `--surface-composer` is the load-bearing one. A field surface that is the same
colour as the page is not a field. And the send button does **not** change between themes, for the
same reason the outgoing bubble does not
([ADR 0002](../adr/0002-messenger-token-layer.md)): that one value not being inverted is most of why
dark-mode vartalap looks like vartalap.

## Growing, and its ceiling

`<textarea rows="1">`, auto-grown from `scrollHeight`, **maximum 160px**, then it scrolls internally.
Inherited. Not `contenteditable`: it is IME-correct, screen-reader-correct and paste-correct without
a dependency.

Three rules the implementation must not get wrong:

- **`overflow-y` is always `auto`, never `hidden`.** Hiding the overflow to hide the scrollbar also
  hides the caret once the cap is reached, and a textarea whose caret has left is a textarea that
  looks frozen.
- **After the height write, the caret must still be visible.** Setting `height = 'auto'` then
  `height = scrollHeight` resets the internal scroll position, so a member typing past the cap can
  watch their cursor vanish below the fold. Restore the scroll so the caret line is in view.
- **The scrollbar is thin and low-contrast.** It appears on exactly one line of every conversation
  ever typed and is not worth a layout shift.

`field-sizing: content` would do all of this natively and is **Baseline as of 2026**. Declined, for
reasons in [0050](../adr/0050-the-composer-is-chosen-here.md#field-sizing-content-is-not-used) that
come down to one specific trap: it makes the textarea shrink-wrap its inline size too, which puts
the shrink-to-fit-parent collapse from
[ADR 0002](../adr/0002-messenger-token-layer.md)'s first prototype back into the path.

## The keyboard contract

**Enter sends. Shift+Enter breaks the line.** Inherited, and correct: it is what every messenger user
already has in their fingers.

`enterkeyhint="send"` relabels the key on a virtual keyboard, and the same handler sends.

> **The ticket's premise here is false, and the conclusion survives anyway.** It said *"On a phone
> there is no enter key at all, so the send affordance has to exist independently of the keyboard."*
> There **is** an enter key on a virtual keyboard, and in a `<textarea>` its default action is to
> insert a newline. The affordance still has to exist independently — but the real reason is sharper
> and has nothing to do with phones, below.

### The IME rule is three belts

```ts
let composing = false;
onCompositionStart = () => { composing = true; };
onCompositionEnd   = () => { queueMicrotask(() => { composing = false; }); };

onKeyDown = (e: KeyboardEvent) => {
  if (e.key !== 'Enter') return;
  if (composing) return;        // belt 1 — the flag we own
  if (e.isComposing) return;    // belt 2 — the property
  if (e.keyCode === 229) return;// belt 3 — deprecated, and what Safari honours
  send();
};
```

Full reasoning, and the WebKit bug timeline that forces belt 1 and belt 3, is
[0051](../adr/0051-enter-to-send-needs-three-guards.md). The one-line version:

**`event.isComposing` alone does nothing on Safari today.** Safari fires `compositionend` before the
`keydown` that committed the composition, so the property is already `false` when the handler runs.
The correct ordering shipped in WebKit in April 2026 and was **reverted the whole way in June** —
*"We've been getting too many regression reports. Disabling this behavior everywhere."* — and a bug
filed on 2026-09-16 establishes that **macOS Web Apps, which is what a PWA is, never got the
corrected order at all**, even with the Feature Flag enabled. [The chat view document says the
opposite](./conversation-list-and-chat-view.md#enter-sends-shiftenter-breaks-the-line--and-the-ime-rule-is-not-optional)
and is overridden.

The `keyCode === 229` check that document calls a "legacy sniff… not a substitute" is the belt that
works. It is deprecated and it stays.

### The auto-grow does **not** wait for composition

The composer resizes on every `input`, including inputs with `isComposing === true`. This points the
other way from the send guard and for a related reason: deferring the resize leaves the candidate
window anchored to a caret whose box has moved, and a host that resizes mid-composition without
updating its caret geometry is a documented way to get the candidate window to jump
([WebView2Feedback #5675](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5675)).

**Never programmatically scroll the transcript while a composition is active**, for the same reason:
the scroll moves the caret rectangle, and the caret rectangle is what the candidate window is
positioned against.

### Two guards around the send itself

**Never send an empty body**, and **never send while a send for the same body is in flight** —
otherwise a held Enter key sends an empty string the moment the composer clears.

### What actually makes this accessible

Not Enter-to-send. **Enter-to-send is unreachable for many screen-reader users**, because assistive
technology in browse mode consumes Enter to activate controls and it never reaches the page. That is
not a problem to be solved by a keyboard shortcut; it is a problem to be solved by a **button that
is always rendered, always in the tab order, and always the same size.**

So:

- **The send button is always rendered and `disabled` when there is nothing to send.** Its position
  never moves as you type. A control that appears and disappears is a layout shift on the most-tapped
  control in the product, and disabled components are exempt from WCAG 1.4.11 — but it must not be
  greyed to the point of being invisible.
- **It is a real `<button>`, after the transcript in DOM order,** so it is the last tab stop before
  the browser's chrome, and nothing about it requires a pointer.
- **36px painted, 44px hit area**, via padding. WCAG 2.5.8 (AA, WCAG 2.2) requires 24×24; 44 is the
  platform convention and costs nothing visually.
- **`Escape` from the transcript focuses the composer.** One listener, and it is the affordance
  people actually reach for. It yields to the profile popover, which closes on `Escape` and returns
  focus to whatever opened it.
- **No `autofocus`.** See [0050](../adr/0050-the-composer-is-chosen-here.md#no-autofocus).
- **The field has a real `<label class="sr-only">` reading `Message {display name}`**, and the
  visible `Message` is a placeholder, which is decoration. A placeholder is not a label: it vanishes
  the moment there is text, fails 4.1.2 as the only name, and cannot say *whom* you are writing to.

### And one setting

**Settings → Chat → "Press Enter to send"**, device-local, **default on**. With it off, Enter inserts
a newline and `Ctrl`/`Cmd`+Enter sends; `enterkeyhint` flips to `enter`.

It is **not** an accessibility mitigation — the reasoning above is why. It is a preference, and the
rejected alternative is deciding unconditionally for newline, which breaks the muscle memory of
every messenger user on the product's most-used surface. One boolean, stored beside the theme, under
[ADR 0022](../adr/0022-settings-boundary-and-transports.md)'s "needed before first paint is
device-local" rule. Add it to that ADR's device-local table when it lands.

## Focus, and the ring

The field surface has **no persistent border**, so the focus ring is the boundary it has — which is
precisely the case WCAG 1.4.11's Understanding document calls out: even where a control is not
required to have a visible boundary, *"it will still need to have a sufficiently contrasting focus
indication."*

`focus-visible:ring-2`, **opaque** `--ring`, offset 2px. **Not `ring-ring/50`**, which measures about
2.4:1 on white — the same finding
[ADR 0002](../adr/0002-messenger-token-layer.md) made for every other control in the shell.

---

# Part two — sending

## The whole path in one table

| step | what | where |
|---|---|---|
| 1 | `canSend()` is consulted | client |
| 2 | One **UUIDv7** is minted — identity *and* idempotency key | client |
| 3 | The row is written to Dexie with `position: null`, `state: 'queued'` | client, **before any network call** |
| 4 | The draft is cleared, **in the same transaction** | client |
| 5 | The composer empties, focus stays in the field, the transcript follows the bottom if it was there | client |
| 6 | The `POST` is issued | network |
| 7 | `200` → `state: 'sent'`, `position` set, the row snaps into place | server then client |

Steps 3–5 are one Dexie transaction. Nothing between them is allowed to await anything, because
**anything that awaits is a thing the member waits for**, and the member's perception of this screen
is that pressing send does nothing to the interface.

Steps 6 onward are [the message lifecycle](./message-lifecycle.md)'s problem. This document only
decides what the member sees while it runs.

## The five things that can be true, and the one that is not a message

The ticket asked for five and warned that *"a message that failed and a message that is still queued
look identical if you only have a spinner — and one of those is a lie."* Confirmed. The shape is
**five sources, four renderings, one indicator** — and connection loss is the sixth row, which is not
a state of a message at all.

| state | what it means | rendered as | source |
|---|---|---|---|
| **Queued send** | stored, no request in flight, no answer | outgoing bubble at `--opacity-queued` (60%). **No text.** | `state` |
| **In flight** | `POST` open | the same bubble, full opacity, **no text** | `state` |
| **Sent** | committed, position assigned | the bubble, no text. `Sent` appears once a device acks | `state` + `delivery` |
| **Delivered / read** | a member has it / has read it | `Sent` → `Seen`, under the last outgoing message only | `delivery` + `receipt` |
| **Failed** | a definitive rejection | 1px `--danger` inline-end border + a retry strip pinned below, aligned to the bubble's inline-end: **`Not sent`**, **`Try again`**, **`Delete`** | `state` |
| **Connection lost** | *not a message state* | **one banner above the composer**, never per-bubble | the socket |

Two rules keep them apart, and both are inherited:

- **A queued send says nothing.** No spinner, no clock, no "Sending…". It is at 60% opacity and that
  is the whole report, because [ADR 0004](../adr/0004-message-durability.md) guarantees it is not
  lost and the member has nothing to do.
- **Connection loss is one banner, not forty icons.** It is a property of the transport, and the
  banner's copy must not promise arrival: **`You're offline. Messages will send when you
  reconnect.`**

And the state is rendered **from the Dexie table, never from component state** — a second tab's
successful send updates this tab's row through `liveQuery` with no coordination, and a copy held in
memory is a ghost message whose position has already moved.

### The banner is driven by the socket, never by `navigator.onLine`

`navigator.onLine` reports whether the OS believes it has a network interface. It is false on a
captive portal and true on a hotel wifi with no route to anything. It is a link-layer fact being
asked a reachability question, and the answer is wrong in both directions.

**Nothing on the send path waits for the socket anyway.** The queue flushes on its own `POST` and its
own backoff timer; a send can and does succeed while the socket is down. The banner is a report, not
a gate.

## Failure, and the one number that is never shown

| outcome | retryable? | what the row does |
|---|---|---|
| `2xx` | — | becomes `sent` |
| network error, timeout, `5xx` | yes | back off, stay queued. **Ambiguous** — the message may have landed, and the idempotency key is what makes retrying it safe |
| `408`, `425`, `429` | yes | back off, stay queued. Honour `Retry-After` when the server sends one, and **reset the backoff** — the server has answered |
| `401` | yes | back off, stay queued. Re-authentication re-flushes the queue |
| **`409`** | **no** | terminal. `Not sent` |
| **`400`, `413`, `422`** | **no** | **terminal.** `Not sent`, and the strip names the reason |

> **Applied to [the message lifecycle](./message-lifecycle.md#when-a-send-fails).** That document
> grouped `429` and pre-execution `4xx` together as *"never executed; key not consumed → stays
> pending, retries with backoff"*, on Stripe's rule. **"The key was not consumed" and "the request can
> never succeed" are independent facts**, and Stripe's rule is about the first. A validation rejection
> will be rejected identically on every retry, forever; retrying it burns a queue slot to arrive at the
> same answer. The test is: *could retrying these identical bytes plausibly produce a different status?*
> If not, it is terminal. **Its table now carries this split.** This document keeps the reasoning.

### Backoff

`1s → 2s → 5s → 10s → 30s → 60s`, capped, with **±20% jitter**. The jitter is not decoration: two
devices coming back onto the same connection at the same instant would otherwise retry in lockstep
and re-create the thundering herd the cap exists to prevent. Reset on any `2xx`, and on any `429`
that carries a `Retry-After`.

### How long before a long-queued message surfaces as failed?

**Never.**

There is no timeout anywhere that converts a queued send into a failed one, and there must not be.
A message that has been waiting two days has not failed — **it has not been answered**, which is a
different thing, and rendering it as an error states something the system does not know. The only
terminal state is a definitive rejection the server actually sent.

> **Rejected:** a "queued for more than N hours, marking as failed" sweep. It is the tidiest-looking
> option and the worst: it converts an open question into a confident lie, and it does so to a member
> who is, at that moment, most likely to be looking at the message and wondering where it went.

Retry is therefore **both**: automatic for anything retryable, forever; and manual — `Try again` on a
failed row, which **reuses the same idempotency key**, which is precisely what makes it safe. The
server recognises the repeat rather than creating a second message. It will reject it again if it was
a genuine `409`, which is correct and visible.

**There is no retry control in the composer.** The composer does not know there are failures, and a
retry button that is only sometimes meaningful is a dead control the rest of the time.

## Wait and discard

The only two acts on a queued send. **No edit, no recall, no unsend** — before or after the server
commits. Full argument in
[0053](../adr/0053-nothing-is-retracted.md); the short version is that the message's UUIDv7 *is* its
idempotency key, so editing a queued send proposes binding one key to two payloads, which is the
client bug the `409` exists to catch, manufactured by the product itself.

**`Delete` removes the row and nobody else does it for you.** A member who wants to change their mind
does it in the draft, which has never touched the network.

## Locked conversations

Inherited verbatim, because it is the chat view's decision and it is the right one:

| reason | the composer is replaced by |
|---|---|
| `blocked_by_me` | **`You blocked this conversation.`** and nothing else. No input, not a disabled one. |
| `blocked_by_them` | **`You can't send messages to this conversation.`** + one destructive action, `Leave conversation` |
| `former_member` | not a member, so not in your list; findable by search, reads `You left this conversation` |

No disabled input, no read-only input, no placeholder inviting a message that cannot be sent.

**One line this ticket adds:** a conversation that becomes locked while files are staged
**discards the staged files and aborts any `PUT` in flight**. The upload may leave a pending media
record, and that is the one leak this design accepts —
[ADR 0008](../adr/0008-media-pipeline.md)'s scheduled purge of unreferenced objects exists for
exactly that.

## The draft

Device-local, in Dexie, keyed by conversation, invisible to every other device including your own
second one. [ADR 0049](../adr/0049-drafts-are-device-local.md) in full.

The four rules this screen owns:

- **The draft clears when the text becomes a queued send**, not when the send succeeds. One Dexie
  transaction clears the draft, writes the message row and writes its attachment rows together. A
  failed send therefore leaves an empty composer and the text in a visible bubble marked `Not sent`.
- **500ms debounce**, plus an unconditional write on `visibilitychange → hidden` and on `pagehide`.
  `beforeunload` fires unreliably on mobile and is not used. Never a "you have unsent text" prompt.
- **A draft is text only.** Staged files are not drafted, because a `File` is not text and an object
  URL dies with the document. On a reload, a staged photo is gone and the typed caption survived.
  That asymmetry is deliberate and is *not* announced — see [0052](../adr/0052-media-is-staged-before-the-message-exists.md).
- **The composer reserves its collapsed height**, so a draft arriving from IndexedDB does not reflow
  the transcript above it.

---

# Part three — media

## Pick, and what the member sees immediately

Picking a file is **instant**: a tile appears in the tray rendered from an object URL of the `File`.
No network, no spinner, no wait. The upload starts at the same moment in the background, so "staged,
then send" never feels like two steps the member is waiting on separately.

```
┌────┬────┬────┬────┐
│ ▢  │ ▢  │ ◴  │    │     ← tray, above the surface, one row, scrolls sideways
└────┴────┴────┴────┘
┌───────────────────────────────────────────────┐
│  ( + )  Message…                              │        ( ➤ )
└───────────────────────────────────────────────┘
```

| state | the tile |
|---|---|
| picked, client-side optimisation running | local preview at `--opacity-queued`, no indicator |
| bytes uploading | local preview + a **2px indeterminate ring**, trailing edge. **No percentage.** |
| bytes stored, worker deriving variants | `thumb` + the same ring |
| ready | `thumb`, no ring |
| **failed** | `--surface-2`, `--danger` glyph, **`Couldn't upload`**; tap for **`Try again`** / **`Remove`** |

## The rule everything else follows from

> **Pressing send sends the text and every attachment that is ready. A tile that is still uploading,
> or that failed, stays in the tray. Nothing is ever removed from the tray by pressing send.**

So the send button is enabled whenever `(text.trim() !== '') || (≥1 ready attachment)`, and:

- **a big photo uploading never greys out the send button** — you send the caption and the photo
  follows when it lands;
- **a failed tile is a composition problem, not a send problem** — it never becomes `Not sent`;
- **nothing is ever partially dropped**, because the all-or-nothing-ness lives in the tray where the
  member can see it, rather than in a message where they cannot.

The alternatives and why each is worse are in
[0052](../adr/0052-media-is-staged-before-the-message-exists.md).

## Why there is no percentage

`fetch` has no upload progress. The only source of one is `XMLHttpRequest.upload.onprogress`, and it
reports **bytes handed to the network stack, not bytes accepted by R2** — on a phone that reads 100%
for several seconds while nothing is happening.

**A bar that sits at 100% and does not move is worse than no bar**, because it is a confident
statement the system cannot support. So the indicator is indeterminate, and once it is indeterminate
there is no reason to have an `XMLHttpRequest` in the codebase at all: the upload is a `fetch` with
an `AbortController`, and cancellation is `abort()`.

## Cancellation

**Before send, cancelling a staged file is offered.** It aborts the `PUT` *and* deletes the pending
media record — a cancel that leaves a record behind has lied about what it cancelled.

**After send, there is no cancel.** The message is a queued send and its only acts are wait and
discard. Cancelling an upload the message depends on would manufacture a message pointing at media
that will never exist.

## What a recipient sees when the worker fails, later

If the bytes uploaded, the message committed, and the `sharp` pass then failed:

| | |
|---|---|
| **Recipient** | a neutral tile reading **`Photo unavailable`**. **No red, no error styling** — it is not their failure and they cannot act on it. |
| **Sender** | **`Couldn't process`** and **`Try again`**, which re-uploads under the **same media id**. |

The asymmetry is the decision. A red error on everyone's screen makes one member's upload problem
everybody's alarm.

## Ordering, and when a message can arrive out of order

**It can, and that is correct.** Send a photo on a slow connection and immediately send "on my way":
the text commits first, takes the lower `seq`, and arrives first. Ordering is by a server-assigned
position ([ADR 0005](../adr/0005-message-ordering.md)) and the client may never interpolate one from
client time — so there is nothing to fix, and nothing to communicate.

The interface is already truthful about it: both messages sat at the bottom of the transcript as
queued sends until the server placed them, which is exactly what it showed.

## Picking

| | |
|---|---|
| `accept="image/*"` | matches what the pipeline promises. A **filter, not a validation** — [ADR 0008](../adr/0008-media-pipeline.md)'s worker is the authority, and it runs regardless of what a client declared |
| `multiple` | yes; one pick can stage several |
| **paste** | yes. `paste` → `clipboardData.files` is the fastest path on desktop and mobile alike |
| **drag and drop** | yes, onto the composer surface |
| **`capture`** | **no.** It forces the camera and removes the gallery. One picker, both choices |
| **maximum** | **10 attachments**, one row, horizontally scrollable so a tenth never resizes the composer |

Client-side downscale and re-encode happens before upload ([ADR 0008](../adr/0008-media-pipeline.md)),
and it **never** skips server-side validation. The line to hold: *"we already optimised it
client-side"* is a reason the client did some work, and nothing else.

**This document deliberately sets no optimisation numbers** — no target long edge, no quality, no
format. Those belong with the media pipeline and are not observable from this screen; the only thing
the composer observes is the tile swapping from a local preview to a `thumb`.

---

# Part four — accessibility

| | |
|---|---|
| **Field label** | real `<label class="sr-only">` reading `Message {display name}`. The visible `Message` is a placeholder and is not the name |
| **Send button** | real `<button>`, always rendered, `disabled` when unsendable, 36px painted / 44px hit |
| **Attach button** | real `<button>` named `Add photo`, 36/44 |
| **Focus ring** | `focus-visible:ring-2`, **opaque** `--ring`, offset 2px. Never `ring-ring/50` |
| **Tray** | `role="list"`, each tile's state **in its accessible name** (`"photo.jpg, uploading"`), so a screen reader user can audit the tray at leisure |
| **Tray announcements** | **one** `aria-live="polite"`, `aria-atomic="true"`, whose text is set on each transition: `Uploading photo.jpg` → `photo.jpg uploaded` → `photo.jpg couldn't upload`. One region, not five — a `role="status"` per tile produces five announcements for one upload |
| **Removal** | named per tile, `Remove {filename}` |
| **No live region in the transcript** | inherited: a live region over a scroller that also announces pagination is unusable |
| **Motion** | tiles entering `cubic-bezier(0.14, 1, 0.34, 1)` over 280ms, leaving `cubic-bezier(0.45, 0.1, 0.2, 1)` over 200ms. Under `prefers-reduced-motion: reduce` these collapse to **1ms, never `none`** — removing them takes an element out of the accessibility tree mid-announcement |
| **The unread badge changing** | no motion, inherited. Not this screen, but the same rule |

## Copy, in full

Everything on this surface, so nothing has to be invented in the middle of a build.

| where | copy |
|---|---|
| visible placeholder | `Message` |
| field's accessible name | `Message {display name}` |
| attach button | `Add photo` |
| send button | `Send message` |
| tile in tray | `Remove {filename}` |
| tile uploading | *(no label; the ring is the indicator, the state is in the accessible name)* |
| tile failed | `Couldn't upload` → `Try again` / `Remove` |
| connection banner | *inherited* — `You're offline. Messages will send when you reconnect.` |
| failed message row | *inherited* — `Not sent`, `Try again`, `Delete` |
| image unavailable, recipient | `Photo unavailable` |
| image failed, sender | `Couldn't process`, `Try again` |
| `blocked_by_me` | *inherited* — `You blocked this conversation.` |
| `blocked_by_them` | *inherited* — `You can't send messages to this conversation.` + `Leave conversation` |

**Never on this surface:** `Sending…`, a spinner over the transcript, `Your message was sent`,
`Delivery failed`. The first is a spinner over the composer's most important control, the second
promises something nobody can promise ([ADR 0004](../adr/0004-message-durability.md): a committed
message is a message that *exists*, which is not the same as one that arrived), and the third is not
a thing v1 can detect.

---

# Part five — boundaries

## Tier 2, recorded so it is not re-derived

Nothing here is designed. These are the constraints a later ticket inherits:

- **Edit** may change neither a message's `seq` nor its identity ([ADR 0005](../adr/0005-message-ordering.md)),
  and it applies to a committed message — not to a queued send, which shares a screen with it and
  nothing else ([0053](../adr/0053-nothing-is-retracted.md)).
- **Replies** are Messages with a reference, and they take a `seq` like any other message. Their
  composer state — which message you are replying to — is **not** part of this draft: a draft belongs
  to a Conversation and a reply belongs to a Message, and merging them produces the two-things-one-
  boolean that [`GLOSSARY.md`](../../GLOSSARY.md) bans.
- **Mentions** would put a member picker above the composer, and it inherits the constraint this
  surface already has: a popover anchored to the composer must not be positioned against the
  **layout** viewport, because the software keyboard shrinks the **visual** one.
- **Reactions and forwarding** are not Messages and take no `seq`.
- **A voice note is a recording control inside the composer surface**, and inherits every rule here:
  it records locally and uploads as an attachment, so it is never a control that pretends to be
  available while offline.

## Things this screen implies and does not decide

- **Whether a member may unblock mid-compose**, and what happens to a half-written draft when they
  do. The blocked states replace the composer, which means the draft has nowhere to render.
- **Whether the tray survives a conversation switch.** Today a staged file is bound to the composer
  it was staged in, and switching conversations with files in the tray is the open question.
- **The client's image optimisation numbers.** Deliberately unset; see above.
- **Whether `Try again` on a failed media tile reuses the media id or mints a new one.** The
  concept assumes reuse, because an unreferenced old record is exactly what the purge exists to
  clean, but the server contract has not been written.

---

# Honest gaps

**Nothing here has been rendered.** No prototype, no screenshot, no measurement. The shape, the copy,
the four token values and every pixel of spacing in this document are arguments. This is the one
surface in vartalap that has had no visual work at all, and the token-layer ticket's own lesson
applies with full force: a document which asserts a claim in prose while proving nothing is worse
than no document. If exactly one thing in this ticket should be checked before anyone builds, it is
that the composer looks like a chat app.

**The Safari composition finding is one week old and the bug is in motion.** It is sourced to WebKit
directly, but 311717 was closed as fixed in April, reverted in June, re-flagged as misleading on
2026-10-07, and its replacement bug was still unfiled when this was written. The specified defence
is a belt that works in **every** ordering, which is precisely why it is three belts — but the
underlying claim will need re-checking, and it should be checked on a **PWA**, not in a Safari tab.

**`field-sizing`'s Baseline status was read from MDN on 2026-10-14 and not tested.** The decision to
avoid it does not depend on that reading; the decision to *revisit* it does.

**Every number here is a judgement.** 160px, 80×80 tiles, 10 attachments, 36/44px targets, and the
backoff ladder are engineering judgement. None is a measurement, and none is sourced to another
product — the `1s/2s/5s/10s/30s/60s` ladder in particular is a shape that feels right rather than a
shape derived from anything.

**The `400`/`413`/`422` terminal split is new** and was a correction to a table in
[the message lifecycle](./message-lifecycle.md#when-a-send-fails) that has now been applied there.
What is still missing is the server's actual status codes, which do not exist yet. If they come out
differently, this table changes and the lifecycle table changes with it.

**There is no automated test that can verify the IME guard.** The ordering is a property of Safari's
event loop; a headless suite will pass with all three belts deleted. The only verification is manual,
with a Japanese IME, in Safari, in an installed PWA. Anyone who finds this boring should re-read
[0051](../adr/0051-enter-to-send-needs-three-guards.md) and then go and test it anyway.
