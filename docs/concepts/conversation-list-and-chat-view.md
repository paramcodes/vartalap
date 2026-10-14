# The conversation list and the chat view

Two screens. Everything the product is for happens on them, and almost nothing about them is layout.

The geometry was settled by the token layer ([ADR 0002](../adr/0002-messenger-token-layer.md)) and
demonstrated in a throwaway prototype. What is left is a long list of small decisions that each look
trivial alone and collectively decide whether the product feels like a chat app or like a web form
with a blue box in it.

Decisions here are in [0045](../adr/0045-conversation-list-orders-by-a-position.md) (what orders the
list), [0046](../adr/0046-mute-is-a-marker-not-a-filter.md) (mute), [0047](../adr/0047-transcript-follows-the-bottom-only-when-at-it.md)
(what happens when a message arrives), [0048](../adr/0048-scroll-anchoring-belongs-to-the-browser.md)
(scroll, and why nothing is virtualized) and [0049](../adr/0049-drafts-are-device-local.md) (drafts).
Vocabulary is in [`GLOSSARY.md`](../../GLOSSARY.md) and is binding.

---

## What this document does not own

**The composer's visual identity.** Its copy, its shape, its attachment affordance, and its media
states belong to [Composer and media sending][#16], which is blocked by this ticket. This document
owns the composer's *behaviour* — auto-grow, the send key, the IME rule, the locked states, the
draft lifecycle, and the banner above it — because those are decisions the chat view cannot be
correct without. Nothing here is inherited from that ticket and nothing there overrides this one.

**Presence green `#31A73B` remains UNVERIFIED** ([ADR 0002](../adr/0002-messenger-token-layer.md)).
It is a plausible Meta value, not an observed one. Every value below marked ⚠️ is sourced the same
way: from the batch's settled decisions rather than from a capture, and it should be checked against
messenger.com before it hardens.

**The `#F0F2F5` wash, the 300–480px width range and `0 1px 2px rgba(0,0,0,.1)`** on the floating
card come from the same batch instruction. [ADR 0002](../adr/0002-messenger-token-layer.md) records
only the 8px corner radius (7.9971px) — the wash, the range and the elevation were settled alongside
it and are inherited here unchanged.

---

# The conversation list

## What orders it

`conversations.last_seq`, descending. One column, one index, no tie-break. Full reasoning in
[0045](../adr/0045-conversation-list-orders-by-a-position.md); the three consequences worth carrying
into the code:

- **An edit cannot reorder the list.** [ADR 0005](../adr/0005-message-ordering.md) already records
  that an edit never changes a `seq`. `last_seq` therefore cannot move for an edit, and this is a
  column property rather than something the UI has to remember.
- **Joining a group cannot reorder the list**, because `last_seq` is on the conversation and not on
  the membership.
- **A queued send does not reorder it.** `last_seq` advances on the server's answer only. A brand-new
  conversation you just sent into appears at the bottom for one `POST` round trip and then moves.
  The client never invents a position to avoid that.

`last_seq` is `0` for a conversation with no messages. `seq` comes from a PostgreSQL sequence and
never returns `0`, so the sentinel is unreachable by any real message — and **IndexedDB does not
index `null`**, which is the whole reason it is `0` and not `NULL`.

## What a row contains

One `<div role="article">` wrapping **one `<a>`**. The row is one destination, so it is one tab stop.
The article carries the Feed pattern's `aria-posinset` / `aria-setsize`; the link carries the
content.

```html
<div role="article" aria-posinset="3" aria-setsize="12"
     aria-labelledby="r3-name r3-preview">
  <a class="row" href="/c/{id}">
    <span class="row-avatar">…</span>
    <span class="row-stack">
      <span id="r3-name" class="row-name">Priya Raman</span>
      <span id="r3-preview" class="row-preview">
        <span class="row-author">Priya: </span>are you around later
      </span>
    </span>
    <time id="r3-time" datetime="2026-10-14T09:41:00Z">
      <span aria-hidden="true">9:41 AM</span>
      <span class="sr-only">Tuesday, 14 October 2026 at 9:41 AM</span>
    </time>
    <span class="row-badge">3</span>
  </a>
</div>
```

### Avatar, presence, and the dot that does not exist

56px circle. The presence dot is 14px at the bottom inline-end with a 3px ring punched in the row's
own background colour, so it reads as a hole rather than a sticker. `--presence-online` renders here,
which is what earns the token ([ADR 0002](../adr/0002-messenger-token-layer.md)'s first trap).

**An offline member gets no dot at all.** Not a grey one. Presence is a 45-second window
([ADR 0006](../adr/0006-presence.md)), so a grey dot cannot honestly say "recently offline" — it can
only say "offline, and here is the fact that I checked", which is a quieter version of last-seen.
[ADR 0006](../adr/0006-presence.md) ruled precise last-seen out of v1 and this is the interface half
of the same decision: **absence is the only honest offline state.** The row just has no dot.

### Name

17px / 600, `--text-primary`, one line, ellipsis at the end. Direct conversations derive the name
from the other member and **store nothing** ([ADR 0007](../adr/0007-conversation-model.md)), so a
rename can never leave a stale header. Groups render `conversations.title`.

### Preview

15px / 400, `--text-secondary`, one line. In a group the author's display name is prefixed in
`--text-tertiary` **outside** the truncating element, so a long message can never push the
attribution out of view. **Truncate the body, never the attribution.**

Align the row's trailing content with `justify-content`, not `text-align` — trap 5 in the decision
index is this exact bug, and a computed `text-align: right` on a flex row holding a text node reads
correct while the glyphs render left.

The four previews the ticket asked for, all decided:

| The last item was | The preview reads |
|---|---|
| Text | The text, ellipsised at the end |
| An **image** | A camera glyph and `Photo` |
| Any **other attachment** | Its **filename, truncated from the start** so the extension survives |
| A **queued send** | The queued text, with the queued state styling — it is the newest thing you did |
| Nothing (no messages) | `No messages yet` |
| While **you have them blocked** | `You blocked this conversation.` — a sentence, never a message |

Truncating a filename from the *start* is the opposite of truncating message text, and it is right in
both cases: a message's meaning is at its beginning and a filename's is at its end.

A deleted message does not exist in v1 (edit/delete is Tier 2). Recorded so it is not relitigated:
when soft delete ships, the preview reads `Message deleted`, and because
[ADR 0005](../adr/0005-message-ordering.md) keeps the `seq` occupied, the row does not move.

### Timestamp

13px, `--text-tertiary`, top-trailing. The rounding rule, which is a real decision and not a
`Intl` default:

| When | Reads |
|---|---|
| Under an hour ago | **Nothing** |
| Today | `9:41 AM` — no "Today" prefix |
| Yesterday | `Yesterday` |
| Earlier this week | `Tuesday` |
| Earlier this year | `14 Oct` |
| Before that | `14/10/2025`, locale-formatted |

Three reasons, each of which is a layout decision as much as a copy one:

- **No "Today" prefix.** The row is 72px tall and the name goes first. "Today" costs eleven
  characters to say something the time already implies.
- **A weekday before a date.** "Tuesday" is faster to recognise than "14 Oct" and carries the same
  amount of confidence.
- **Numeric and unambiguous once a year is old.** `14/10` means two different days on two sides of
  the world, and a conversation list is exactly where both are looking.

Format through `Intl.DateTimeFormat`. Under `prefers-reduced-motion: reduce`, the timestamp does not
animate — it changes several times a minute while you read, and motion on it is the definition of a
distraction.

### Badge

20px minimum, pill, `#0084FF` fill, white label, `--text-xs`, hidden entirely at zero.

**Capped at `99+`.** What the cap hides is the *magnitude*, never the *fact*: the badge shows at any
non-zero count, and the true number is in the row's accessible name ("12 unread messages"). A cap
that also hid the presence of unread would be a lie about the one thing a badge exists to say.

The count is `count(seq > receipt.read_through)` — derived from the receipt, never stored
([ADR 0003](../adr/0003-receipt-watermark.md)).

### Hover and focus

Hover moves the row background **one step toward the foreground** — darker in light, lighter in dark.
One rule, two directions; the rule is what stops dark mode from being an inversion.

Per WCAG 1.4.11, the hover treatment itself does not need 3:1 — the pointer is already the
indicator. **What must not change is the contrast of anything already on the row**: the badge, the
presence ring, the focus ring all keep their measured values. A hover fill picked too close to the
badge blue is the common way this screen fails.

Focus is `focus-visible:ring-2` with an **opaque** `--ring`, offset 2px. Not `ring-ring/50`, which
measures about 2.4:1 on white. The row has no persistent boundary, so the focus ring is the boundary
it has — and WCAG 1.4.11's Understanding document says precisely this case: even where a control is
not required to have a visible boundary, "it will still need to have a sufficiently contrasting
focus indication."

## Mute

Two marks, never one: the unread **badge** stays, and a mute glyph sits beside it at a different
opacity. Muted-and-unread shows both.

**Muting never removes a conversation from the list and never changes its unread count.** Full
reasoning in [0046](../adr/0046-mute-is-a-marker-not-a-filter.md). The one-line version: a
conversation you have not read is not read, and muting it does not make it read. If `muted_at` ever
appears in a list query or an unread computation, that is the bug — and the shape of the bug is a
badge that disagrees with the tab title.

There is no "hide muted conversations" control. [ADR 0006](../adr/0006-presence.md)'s rule about
never rendering a dead switch applies with its mirror image here: **never render a filter that makes
a conversation disappear.** The user cannot tell "muted and hidden" from "notifications are off
globally" from "this account was signed in somewhere else", and the first question becomes "where did
it go", which has no good answer.

## Loading, empty, and cold cache

The list renders from Dexie before any network call, so there is a window where it is empty and the
answer has not arrived. **Never a skeleton that replaces real rows and never a spinner over the
whole list.** Four states, distinguished by what is missing rather than by a curtain:

| | |
|---|---|
| **Cache has rows, network in flight** | Rows render immediately. A **2px `--accent` progress bar on the top edge of the list** shows it is still settling. It covers no row, blocks no scrolling, and is the only loading affordance on this screen. |
| **Cache empty, network in flight** | One line, `--text-tertiary`: `Loading…`. This is the only place a centred placeholder is honest, and only because there are no rows to lie about. |
| **Cache empty, answer arrived empty** | The empty state: one sentence of **instruction**, not a shrug — `No conversations yet. Search for a handle to start one.` — and one primary action. Never `No conversations`. |
| **Cache empty, request failed** | `Can't load conversations.` and `Try again`. **These pixels must differ from the empty state.** Reusing empty-state copy for a failure is how a member deletes real data. |

A skeleton that resolves into an empty state is the most-hated empty state in software, because it
promised rows. For a member who signed up this morning, "No conversations yet" is the expected first
screen, and a skeleton that fills with nothing is a lie told in the first ten seconds.

A conversation the server no longer returns is removed **on the authoritative response, never
optimistically**, animating out over 200ms with the exit easing.

## Dark mode

Its own token set ([ADR 0002](../adr/0002-messenger-token-layer.md)). On this screen the rule is
one line: **hover moves the row background toward the foreground in both themes**, and the outgoing
bubble in the chat view stays `#0084FF` in light and dark alike — most of why dark-mode Messenger
looks like Messenger is that one value not being inverted.

---

# The chat view

Three bands on `100dvh` — **not `100vh`**, because a mobile URL bar makes `vh` taller than the
visible area and the composer ends up under it:

```
grid-template-rows: auto 1fr auto      /* header · transcript · composer */
```

The transcript is the scroller and carries `overscroll-behavior: contain`, so scrolling past its top
does not trigger pull-to-refresh, and `scrollbar-gutter: stable`, so prepending a page cannot shift
the layout sideways by the width of a scrollbar that was not there a moment ago.

## The header

60px.

| | Direct | Group |
|---|---|---|
| Picture | The other member's avatar | A group avatar |
| Primary | Their display name (derived, never stored) | `conversations.title` |
| Secondary | `Active now` or `Offline` | `N members` |
| Cluster | — | Up to 3 overlapping 24px avatars, overflow as `+N` |

**Two presence words and no third.** Presence is a 45-second window
([ADR 0006](../adr/0006-presence.md)), so the header says `Active now` or `Offline` and never
invents an in-between. "Last seen recently", "Away", and "Active 5m ago" are all last-seen wearing a
hat.

**A group gets no aggregate presence.** "3 of 120 active" is a number nobody can act on, and it is an
attendance record for a room with a 500-member ceiling. Presence in a group has no actionable meaning
and each dot is a small claim about a person, so the group header carries the count instead.

**Former members are in the member panel, under their own heading, and not in the cluster.** A former
member is still a member ([`GLOSSARY.md`](../../GLOSSARY.md)); hiding them makes people think they
were deleted.

The header also carries the **mute toggle** (showing the *effective* state,
[ADR 0022](../adr/0022-settings-boundary-and-transports.md)) and, for a direct conversation only,
the **read-receipt sharing toggle**, because that control lives on the conversation.

### The route to a profile is not a route

**There is no `/u/<handle>` route** ([ADR 0021](../adr/0021-profile-surface.md)). So the profile is
**a non-modal popover anchored to the header**, not a navigation, and three things follow that have to
be specified because they are not automatic:

- **It does not trap focus** and the transcript stays scrollable behind it. A modal profile over a
  chat transcript hides the conversation you were reading in order to look at the person.
- **`Esc` closes it and returns focus to the element that opened it.**
- **The browser Back button does not close it**, because nothing was navigated. This is the real cost
  and it is accepted rather than papered over: a profile is a peek, and a peek that pushes a history
  entry is worse than a peek you leave with `Esc`.

The popover carries identity, the member list (with handle search, for groups), and the destructive
conversation actions. **There is no `⋯` menu in the header.** Four things fit in a header; a fifth
becomes a menu, and a menu is where features go to be undiscoverable. Blocking, unblocking and
leaving live in the popover, where the member they concern is one glance away.

## Runs

A **Run** is a maximal sequence of consecutive messages from one author with nothing between them
that separates them. It is what the transcript renders, and it is what a timestamp and a receipt
attach to. Derived, never stored.

State machine and geometry are settled in [ADR 0002](../adr/0002-messenger-token-layer.md): the
"fused" reading at 4px, `single` / `first` / `middle` / `last`, `middle` and `last` identical, logical
longhands only (`border-start-end-radius` / `border-end-end-radius`) so the inline-end mirror is
correct by construction and under `dir="rtl"`. Tail-less bubbles, structurally.

What breaks a run — the ticket asked for four:

| | |
|---|---|
| A different author | **Breaks** |
| A date divider | **Breaks** — settled in ADR 0002 |
| A **5-minute** gap in `created_at` | **Breaks** |
| A reaction | Does not exist in v1. Recorded for Tier 2: a reaction is **not** a Message and gets no `seq` ([ADR 0005](../adr/0005-message-ordering.md)), so it cannot appear in transcript order and attaches to the message it decorates. |
| A **queued send** | **Always its own run, always `single`, always last** |

The 5-minute gap is `created_at`, which [ADR 0005](../adr/0005-message-ordering.md) forbids as a
*sort key* and which is perfectly safe as a *display threshold*. No gap at all is rejected: a run
fusing an hour of alternating replies loses the author, and that is the information the run geometry
exists to carry. A gap keyed on `seq` distance is rejected because `seq` density depends on traffic
elsewhere in the world — using it as a proxy for elapsed time is exactly the substitution ADR 0005
warns against.

A queued send's `position` is `null` and stays `null` until the server assigns it, so it cannot be
compared with a neighbour by author-and-time. That it forms its own run is not a special case; it is
what a null position means.

**In a direct conversation, a run carries no author label.** One person, and the side of the bubble
says who. In a group, the **first** message of each run carries a 28px avatar and a 13px author name
in `--text-tertiary`; the rest carry neither. That is both the right design and the cheap one.

### Timestamps

Below the run, carrying the run's **last** message's time, aligned to the bubble's inline-end —
mirrored with logical properties. Never inside the bubble. **A single-message run gets one.**

The same rounding rule as the list, with one difference: **seconds are never shown.** Absolute date
on hover and on focus.

Two implementation rules that came from a prototype bug, both of which produce *plausible* wrong
output rather than a crash:

- **The metadata guard tests `single | last`, not `last`.** A one-message run is labelled `single`,
  and a guard that tests only `last` drops its timestamp entirely — which is what happened, and it
  is invisible until someone looks for it.
- **Run positions index the full transcript, not the divider-filtered list.** A date divider is a
  rendering artefact inserted between runs; it is not a row. Indexing a filtered list and looking up
  in the unfiltered one shifts every timestamp by the number of dividers above it (trap 10).

## "Seen"

Under the **last outgoing message only**. Never under an incoming one, never under a queued send —
you cannot be seen before you are sent — and never under a failed one.

It is **derived on every render and never stored**, and nothing in the schema says "under the last
outgoing message": a member's own sends never advance their own receipt, so their own watermark can
never satisfy the predicate for their own message ([ADR 0003](../adr/0003-receipt-watermark.md)).

One word at a time, showing the highest state reached:

| | Reads |
|---|---|
| Accepted by the server | *(nothing)* |
| Any one device persisted it | `Sent` |
| Every current member's `shared_through` is past it | `Seen` |

`Seen` is interface copy borrowed from a stranger's product; the domain says Receipt
([`GLOSSARY.md`](../../GLOSSARY.md)). Copy may borrow the word. Nothing in the model, the schema or
the protocol may.

## Five states of a message, and one that is not a message

The ticket's sharpest question: *conflating any two of these is how users end up believing a message
was lost when it was not.* So they are enumerated, and **no two share a source.**

| State | Rendered as | Source |
|---|---|---|
| **Queued send** — persisted, no response yet | Normal outgoing bubble at `--opacity-queued` (60%). **No text.** | Send-queue row `state` |
| **In flight** — `POST` open | Normal bubble, full opacity, no text | Send-queue row `state` |
| **Failed** — a definitive rejection (4xx) | Bubble with a 1px `--danger` inline-end border, plus a retry strip pinned below aligned to the bubble's inline-end: `Not sent`, `Try again`, `Delete` | Send-queue row `state` |
| **Attachment processing** | The bubble, attachment tile showing a progress ring in place of its thumbnail | Media pipeline |
| **Connection lost** | One banner above the composer. Never per-bubble. | The socket |

**Five.** Older history paging in is not a message state — it is a region state, and it gets its own
affordance below.

Two rules that keep them apart:

- **A queued send renders at 60% opacity and says nothing.** Greying it to nothing and hiding it both
  make a message you pressed send on look like one you did not. [ADR 0004](../adr/0004-message-durability.md):
  "a message someone pressed send on is never discarded automatically."
- **Connection loss is one banner, not forty icons.** It is a property of the transport, and putting
  it on each bubble puts forty copies of one fact into the transcript.

### Retry, and what "retry forever" actually means

[ADR 0004](../adr/0004-message-durability.md) says retry forever. That applies to **transport**
failures, where there is no answer and the question is open. A `4xx` is an answer: retrying it
forever is wrong.

- **No response → stays queued**, retries forever with backoff, renders as *queued*.
- **Definitive rejection → leaves the queue**, renders as *failed*, and waits for a person.
  `Try again` reuses **the same idempotency key**, which is exactly what makes it safe — the server
  recognises the repeat rather than creating a second message. It will reject it again, which is
  correct and visible.
- **`Delete` removes it from the queue.** Nobody else does this for you.

## Pagination

Keyset, 50 rows, `seq < cursor ORDER BY seq DESC LIMIT 50`, `OFFSET` never
([ADR 0005](../adr/0005-message-ordering.md)). An `IntersectionObserver` on a 1px sentinel at the top
of the scroller triggers the next page. **One request in flight, ever** — guarded on `busy` *and* on
`hasMore`, because prepending 50 rows can re-fire the sentinel immediately.

The affordance is **a 2px progress bar on the top edge of the scroller** plus **`aria-busy="true"` on
the `role="feed"` container**, and `aria-busy="false"` in a `finally`.

That `finally` is the most important line on this screen. The WAI-ARIA APG Feed pattern requires the
busy flag and warns: *"it is extremely important that `aria-busy` is set to `false` when the operation
is complete or the changes may not become visible to some assistive technology users."* A feed stuck
at `aria-busy="true"` is a transcript a screen reader cannot read at all, and the line that forgets it
is always the one in the error path.

**Never a spinner centred over the transcript.** It occludes the content the member scrolled up to
read, which is the opposite of what loading feedback is for.

## Older history and scroll position

Nothing moves. `overflow-anchor` is at its initial `auto` and nothing here sets it to `none`, so the
browser picks an anchor node deep in the visible region and compensates. Full reasoning, and the two
ways it is silently cancelled, in
[0048](../adr/0048-scroll-anchoring-belongs-to-the-browser.md).

The short version for whoever builds it:

- **Never call `getBoundingClientRect()` after prepending, in the same task.** The spec's suppression
  window ends immediately before a measurement like that, so measuring cancels the compensation. Measure
  before the mutation.
- **Never call `scrollIntoView` on render.** The spec makes the focused element and the active
  find-in-page match *priority candidates* for anchor selection, so both already do the right thing
  and a forced scroll fights them.
- **Every run reserves its height** via `contain-intrinsic-size`, because a run that grows cancels the
  adjustment for that prepend.

## Date dividers

Inserted **between** runs, never inside one. Labels: `Today`, `Yesterday`, a weekday, then
`14 October 2026`.

**There is no sticky date header.** This is a declined requirement and the reason is specific: a
sticky header in a transcript with 5-minute run breaks changes every few seconds while you read, and
an element that changes constantly costs more attention than the information is worth. The
information is not lost — every run already carries its last message's time, which is strictly more
precise than the day a sticky header could show.

What would reverse it: a density setting that hides run timestamps. Then the header is the only time
signal and the trade flips.

## The composer

Behaviour only; visual identity is [Composer and media sending](#16)'s.

### Growing, and its ceiling

`<textarea rows="1">`, auto-grown from `scrollHeight` on input, **maximum 160px**, then it scrolls
internally. Not `contenteditable`: it is IME-correct, screen-reader-correct, and paste-correct without
a dependency.

### Enter sends, Shift+Enter breaks the line — and the IME rule is not optional

**`Enter` sends. `Shift+Enter` inserts a newline.** And the `Enter` that commits an IME composition
**must not send**: check `event.isComposing` on the `keydown`. Without that check every Japanese,
Chinese and Korean member loses the character they just composed, and it is the most-reported bug in
this class of application. `isComposing` is the UI Events property
(`dom-keyboardevent-iscomposing`); the legacy `keyCode === 229` sniff is not a substitute.

Two guards around the send itself: **never send an empty body**, and **never send while a send for
the same body is in flight** — otherwise a held Enter key sends an empty string the moment the
composer clears.

The send button is **always rendered and `disabled` when empty**, because its position must not move
as you type; a control that appears and disappears is a layout shift on the most-tapped control in
the product. Disabled components are exempt from WCAG 1.4.11, but it must not be greyed to the point
of being invisible.

### Locked conversations — a sentence, never a dead input

The send predicate lives in one application function ([ADR 0007](../adr/0007-conversation-model.md)),
and this ticket fixes its **return shape**, because a boolean throws away exactly what the screen
needs to say:

```ts
type CanSend =
  | { ok: true }
  | { ok: false; reason: 'blocked_by_me' | 'blocked_by_them' | 'former_member' }
```

Three named reasons, because two of them say opposite things to the reader. **B blocked A ⟹ A can no
longer send and B's messages are not delivered to A** — one-directional in intent. So:

| Reason | The composer is replaced by | Preview |
|---|---|---|
| `blocked_by_me` | The sentence **`You blocked this conversation.`** and nothing else. No input, no disabled input. | The same sentence. **Never the last message** — showing it while claiming to have blocked them is incoherent, and the sentence leaks nothing about what the other person is doing. |
| `blocked_by_them` | **`You can't send messages to this conversation.`** plus one action: `Leave conversation`, destructive, so it confirms. | Normal. Nothing is hidden from you; nothing was. |
| `former_member` | You left, so you are not a member, so the conversation is not in your list — it is findable by search and reads `You left this conversation`. | — |

No disabled input, no read-only input, no placeholder inviting a message that cannot be sent
([ADR 0022](../adr/0022-settings-boundary-and-transports.md)'s rule about never rendering a dead
control, applied to an input rather than a switch). A placeholder that says "Message…" above a
compose box that cannot send is the most expensive three pixels in the product.

### The draft

Device-local, in Dexie, keyed by conversation, invisible to every other device including your own
second device. Full reasoning in [0049](../adr/0049-drafts-are-device-local.md).

Two rules the implementation must not get wrong:

- **The draft clears when the text becomes a row in the send queue**, not when the send succeeds. The
  composer empties immediately and the text is owned by a durable row with an idempotency key. Clear
  on `Enter` and a failed send leaves an empty composer.
- **Write on a 500ms debounce, and unconditionally on `visibilitychange → hidden` and `pagehide`.**
  `pagehide` is the one that matters: mobile browsers can discard a tab without firing teardown, and
  a debounce-only autosave loses the last half-second of typing exactly when someone switches apps.
  `beforeunload` fires unreliably there and is not used.

A draft and a queued send are different things with different durability promises and never merge
([`GLOSSARY.md`](../../GLOSSARY.md) bans "pending message" for this reason).

### The banner above it

One line, `--text-tertiary`, one action at most. `You're offline. Messages will send when you
reconnect.` It **must not** say a message will arrive — [ADR 0022](../adr/0022-settings-boundary-and-transports.md):
nothing in settings may imply delivery is guaranteed, and web push is best-effort with no receipt.

## Message actions

**v1 has none, and that is the finding rather than an omission.**

Copy comes from the platform's own selection context menu on every platform we target. Reaction, reply,
edit, delete, forward and pin are all Tier 2. A toolbar with one item in it is a hover affordance
invented for its own sake, appearing over every message, on a surface where the message is the point.

Recorded so the Tier 2 ticket does not re-derive it:

- **Gate the reveal on `@media (hover: hover)`**, and reveal on `:focus-within` as well as `:hover`.
- **Under forced colours, reveal on focus only.** Hover does not exist there.
- **The buttons have no persistent boundary**, which is precisely the WCAG 1.4.11 case where "it will
  still need to have a sufficiently contrasting focus indication." The opaque ring is not a global
  setting; on this component it is the entire affordance.
- **Every run carries a real button trigger**, no roving `tabindex` games. The APG Feed pattern makes
  reading-mode users move focus article to article, and `Ctrl+Home` / `Ctrl+End` are the documented
  way in and out.
- **`contain-intrinsic-size` on every run** keeps the cost of that many buttons bounded.

## Announcements

**The transcript is `role="feed"` with `role="article"` runs.** Arriving messages do **not** announce
themselves from inside the feed — a live region over a scroll container that also announces pagination
is unusable.

The one live region on this screen is the **jump-to-latest pill**
([ADR 0047](../adr/0047-transcript-follows-the-bottom-only-when-at-it.md)), announcing "3 new
messages", because that is the fact a member cannot otherwise perceive. Under
`prefers-reduced-motion: reduce` its transition collapses to 1ms and is **not removed** — removing it
takes the pill out of the accessibility tree mid-announcement.

Each article gets `aria-labelledby` (name, then preview) and `aria-setsize` = the number of
conversations the client knows about, with `-1` when even that is unknown. Loaded-count is chosen
over server-total deliberately: a server total is a second number that needs its own reconciliation,
and "I have 12 chats" is what a member means.

## Motion

From [ADR 0002](../adr/0002-messenger-token-layer.md): enter `cubic-bezier(0.14, 1, 0.34, 1)` over
280ms, exit `cubic-bezier(0.45, 0.1, 0.2, 1)` over 200ms. Enter slower than exit.

| | |
|---|---|
| A message arriving at the bottom | Enter, 280ms |
| A row entering the conversation list | Enter, 280ms |
| A row leaving the conversation list | Exit, 200ms |
| The jump-to-latest pill | Enter, 280ms / exit, 200ms |
| The presence dot | Enter 280ms, exit 200ms |
| **The unread badge changing** | **No motion.** A number that springs is a slot machine. A 100ms opacity crossfade is the ceiling. |
| **A timestamp changing** | **No motion.** It changes several times a minute while you read. |
| Older history prepending | No motion. The scroll position simply does not change. |

Under `prefers-reduced-motion: reduce`: **1ms, never `none`.** Transform-based motion is removed;
opacity crossfades are kept at 1ms.

---

# The vocabulary this screen adds

Four terms, added to [`GLOSSARY.md`](../../GLOSSARY.md). All four are the result of this ticket's
questions, and two of them exist to stop a word that is already in the ADR history.

**Conversation activity** — the position of a conversation's most recent message. What orders the
conversation list. *Avoid*: last active, last seen, updated at, recent.

**Muted** — a fact about a Member's relationship with a Conversation: they have asked not to be
notified. It changes what reaches them, never whether the Conversation is shown or whether its unread
count is counted. *Avoid*: archived, hidden, snoozed.

**Run** — a maximal sequence of consecutive messages from one author with nothing between them that
separates them. The unit a transcript renders, and the unit a timestamp and a receipt attach to.
Derived, never stored. *Avoid*: burst, group, cluster, thread. **"Burst" is a deprecated synonym**
already present in [ADR 0002](../adr/0002-messenger-token-layer.md) and read as *run*; two words for
one thing is the defect that glossary entries exist to stop.

**Draft** — text a member has composed but not sent, held by the one browser that received it. Not
part of the Conversation; no member and no other device can know it exists. *Avoid*: pending message,
unsent message, queued send.

---

# Honest gaps

**The chat-shell prototype cannot be re-checked.** It lives on a branch that is not on the remote and
is not in the working tree, so the measurements in
[ADR 0002](../adr/0002-messenger-token-layer.md) — the 41 bubbles at `17.9998px`, the four distinct
corner sets, `#0084FF` in both themes — are correct as recorded and currently unreproducible. The
geometry this document depends on is therefore inherited, not re-verified, and it should be re-measured
before anyone builds the burst component rather than after.

**Presence green `#31A73B` is still inferred**, not observed in any capture. So is the `#F0F2F5` wash
and the floating card's shadow. They are settled for this build; they are not evidence.

**The `#F0F2F5` wash and 300–480px width have not been checked against dark mode.** The card is
specified here in its light form only, and a dark card needs its own token. It is not the outgoing
bubble, and the outgoing bubble's rule does not transfer to it.

**Whether 64px is the right at-bottom tolerance is a judgement, not a measurement.** It was chosen so
that trackpad momentum overshoot still reads as "present". If it is wrong it will be wrong by a small
margin in one direction, which is the cheapest possible failure — the pill appears when it should not,
or the view does not follow when it should.

**`content-visibility` is a performance bound, not a performance measurement.** Whether one
`contain-intrinsic-size` per run is enough for a very long backlog is unknown, and
[ADR 0048](../adr/0048-scroll-anchoring-belongs-to-the-browser.md) names the threshold to measure and
the cheaper escalation if it is passed.

**Sticky date headers were declined**, against the ticket's own suggestion. The reason is recorded
above and the condition that reverses it is named; if a build finds itself wanting the header, the
density setting hiding run timestamps is the thing to look at first.

**Nothing here has been rendered.** Every number in this document is either inherited from a decision,
sourced to a specification, or argued from one. The token-layer ticket's own lesson is that a
document which asserts a headline claim in prose while proving nothing is worse than no document —
and the burst geometry, the presence dot and the card elevation are exactly the three claims that
would not survive a screenshot.

<a id="16"></a>

[Composer and media sending spec]: https://github.com/paramcodes/vartalap/issues/16

*[Composer and media sending spec][#16] — blocked by this ticket. Owns the composer's copy, shape and
media affordance.*