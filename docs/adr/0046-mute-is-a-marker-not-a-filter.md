# 0046. A muted conversation stays in the list, with its unread count intact

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Conversation list and chat view spec"
**Builds on:** [0022](0022-settings-boundary-and-transports.md) (`muted_at` on the membership, effective notification state), [0003](0003-receipt-watermark.md)
**Teaches:** [`docs/concepts/conversation-list-and-chat-view.md`](../concepts/conversation-list-and-chat-view.md)

## Context

The ticket asked how archived, muted and pinned compose on the list, treating the three as three
kinds of overlay. Two of them are not in v1 at all — see
[0045](0045-conversation-list-orders-by-a-position.md), which declines pin and archive with reasons.
That leaves one real state, and it is real because [0022](0022-settings-boundary-and-transports.md)
settled `muted_at` on the membership.

What [0022] settled is the *notification* side: effective state is `notify_on_message AND muted_at
IS NULL`, and "the UI shows the effective state". It says nothing about the **list** — whether a muted
conversation is still there, and whether its unread badge still counts.

Both questions have an obvious answer and both obvious answers are wrong in the same way.

## Decision

### Muting changes what reaches a member. It never changes what they see.

**A muted conversation stays in the list, in its place, with its unread count and its position
unchanged.** Muting is a fact about a *relationship* ([0022](0022-settings-boundary-and-transports.md)),
not a filter over a list.

### The unread badge is read state, and muting is not reading

A conversation you have not read is not read, and muting it does not make it read. **The unread count
is derived from the receipt and the transcript, and neither of them knows that `muted_at` is set.**

If muting suppressed the badge, muting would become a way to *look* as though you had read a
conversation you did not read — and it would do it silently, to the one person who cannot check.

### The mute marker is a separate glyph beside the badge, not in place of it

Muted-and-unread renders **both**: the count badge, and a mute glyph. Two marks, two jobs, at two
different opacities so they are not read as one. Collapsing them into a single muted badge is the
obvious compact answer and it destroys the distinction the reader needs.

### There is no "hide muted conversations" control, in v1 or as a rendering

One list. No per-device filter, no search-within-list, no second surface. The reason is not that a
filter is hard — it is that a filter creates a question ("where did Priya go?") that has to be
answerable forever, and the honest answer is always "a setting you forgot about on this device".

## Why not the Messenger behaviour

Messenger lets you hide muted conversations, and that is a reasonable design for a product with a
hundred thousand conversations and a search box good enough to find anything. vartalap is not that
product, and the filter carries three costs that a marker does not:

1. **It is device-local state a user cannot see.** `muted_at` is on the membership and syncs; the
   filter is a device preference and does not. The same account renders two different lists, and the
   difference is invisible until someone is confused by it.
2. **It interacts with [0022]'s effective-state rule in a way that produces a lie.** A conversation
   that is hidden *and* muted looks identical to one that is hidden because notifications are off
   globally. The settings screen must show effective state, and the list cannot help it.
3. **The failure mode is missing data.** A muted conversation you cannot find is indistinguishable
   from one that does not exist, and the unread count you were trying to avoid looking at is the only
   evidence it was ever there.

## Consequences

- **`muted_at` is read on the notification path and nowhere else.** A cache index, a list query, or
  an unread computation that filters on `muted_at` is a bug, and the shape of the bug is a badge
  that disagrees with the tab title.
- **Muting is reversible with no reconciliation.** Nothing was hidden, nothing was re-shown, nothing
  was renumbered.
- **The mute glyph is a real token with a real caller.** [0002](0002-messenger-token-layer.md)'s
  first trap applies: a `--mute-glyph` that nothing renders is a comment, not a token. The glyph
  renders on every muted row and in the header control, which is what earns it.
- **A muted conversation still receives read receipts** when the member opens it, because opening it
  reads it ([0003](0003-receipt-watermark.md)), which clears the badge and leaves the mute glyph
  alone. The two controls are independent, which is exactly what a member who muted a chat at work
  and read it anyway expects.
- **Declining the filter is cheap to reverse and expensive to have shipped.** Adding one later is a
  `localStorage` key and a predicate. Removing one after launch is a support burden.

## What would reverse this

**A member with enough conversations that the list stops being scannable.** That is a measurable
condition, not a feeling: the point at which people start using search instead of scrolling. When it
arrives, the honest version is a **search-first list**, not a hidden-muted toggle — the same reason
[0021](0021-profile-surface.md) declines a discovery policy until a directory exists. A filter is a
way of pretending the list is smaller; a good search bar admits it is not.

**Per-conversation mute moving off the membership** would also reopen this. [0022](0022-settings-boundary-and-transports.md)
puts it on the membership because it is a fact about a relationship, and this ADR depends on that:
the mute is a property of *this member in this conversation*, which is why a muted conversation is
still a conversation.