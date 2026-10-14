# 0047. The transcript follows the bottom only for a member already at it

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Conversation list and chat view spec"
**Builds on:** [0002](0002-messenger-token-layer.md) (motion tokens), [0010](0010-receipt-mechanics.md) (receipts advance on open), [0005](0005-message-ordering.md) (keyset paging)
**Teaches:** [`docs/concepts/conversation-list-and-chat-view.md`](../concepts/conversation-list-and-chat-view.md)

## Context

The ticket called this the decision that "separates chat apps that feel good from ones that feel
hostile", and offered three options: jump, hold, or queue. It is worth being precise about which
one is hostile, because the common answer is to jump and most people think the hostile thing is
holding position.

It is not. **Jumping is hostile in exactly one case — when the member had scrolled away to read
something — and it is the default in every implementation**, because "scroll to bottom on new
message" is the first thing anyone writes. Holding position is hostile in exactly one case too, when
a member is at the bottom and nothing moves.

There is no single answer. There are three states of one predicate, and the predicate is where all
the care goes.

## Decision

### One predicate: within 64px of the bottom edge

Not zero. **Zero is a bug that reads as "the app is broken"**, because momentum scrolling on a
trackpad ends a few pixels off the bottom, messages stop following, and the member concludes the
socket is dead. 64px is roughly one comfortable line-height plus slack: far enough that a trackpad's
resting overshoot still counts as "at the bottom", close enough that a member who has deliberately
scrolled up is not treated as present.

### Three behaviours, decided by the predicate

| | |
|---|---|
| **At bottom** | New messages scroll into view. Enter easing, 280ms, `cubic-bezier(0.14, 1, 0.34, 1)` — slower than the exit, per [0002](0002-messenger-token-layer.md). |
| **Scrolled away** | **Nothing moves.** No scroll, no growth, no reflow of what is on screen. A jump-to-latest **pill** appears above the composer carrying the count of messages that arrived while away. |
| **You sent it** | Scroll to the bottom, always. You caused the change and your composer has to come back to where it started. |

The third case is the only override, and it exists because the composer must reset. A member who
scrolled up, typed, and sent has to end up at the bottom or the next message they read is not the
one they just sent.

### The affordance is a 32px pill, not a full-width bar

A bar spanning the transcript is a **banner**, and banners are read as errors. It also collides with
the offline banner, which lives in the same place and is a genuine one. The pill is a control:
bottom-centre, 32px, `--messenger-card-corner-radius` at 8px, the same elevation and wash as the
floating card, and it counts.

### Prepending older history holds the view — and the browser does that for us

When older messages are prepended above the viewport, the visible content must not move. The
mechanism is the W3C's, not ours; see [0048](0048-scroll-anchoring-belongs-to-the-browser.md) for why
we do not hand-roll it, and for the two ways it is silently cancelled.

## What was rejected, and why

**Queueing arriving messages** — holding them above the bottom and inserting them all at once when
the member returns — sounds gentle and is worse. The member scrolls back to a position and finds
fifteen messages have been silently withheld; they cannot tell whether they were not sent, not
delivered, or held back on purpose. **The transcript is a transcript.** What it shows is what exists.

**A full-width "N new messages" bar.** As above: banner semantics, and it competes with the one
banner on this screen that is actually an error.

**Auto-scrolling when the window regains focus.** A member who switches to another tab for ten
seconds comes back to the bottom of a conversation they were reading in the middle of. The predicate
is the only thing that moves the view.

## Consequences

- **The predicate is a number with a unit and a name.** `AT_BOTTOM_TOLERANCE_PX = 64`, in one module,
  imported by the message-list, the pill, and the receipt logic. Three components reading a
  scroll offset for three slightly different purposes is how they end up disagreeing about whether
  the member is present.
- **Receipts do not depend on the scroll position.** [0010](0010-receipt-mechanics.md) settles that
  opening a conversation advances the receipt to the end immediately, regardless of scroll. The
  predicate governs the *view*, never the *receipt*. A member who opens a conversation and
  immediately scrolls up has still read it, and the unread count clearing is not a lie.
- **The pill is the only affordance that appears without being asked for**, and it is `aria-live`:
  a member using a screen reader must hear "3 new messages" without hunting for it. The transcript
  itself is `role="feed"` and does not announce arrivals — see the concept document.
- **Under `prefers-reduced-motion: reduce` the transition collapses to 1ms and is not removed.** Not
  `none`, not `display: none`: removing a transition from an element that is about to change is fine,
  but removing it from the pill while the pill appears takes it out of the accessibility tree
  mid-announcement, and `aria-live` on an element that was never rendered announces nothing.

## What would reverse this

**Reading position as an explicit, restorable thing** — "resume where you left off" across devices
— is the feature that would genuinely change this decision, because it would make scroll position a
stored fact about a member rather than a property of a viewport. That needs a server-authoritative
position per (conversation, member), which is a `receipt`-shaped row with a different meaning, and
it is not v1. It is also not a small addition: it is a second watermark and a second set of
questions about what "where you left off" means when history was deleted underneath you.

**A transcript that is genuinely read out of order** — a search result you have jumped into the
middle of — is the other case. Arriving messages near a jump target should not move you off it, and
the mechanism for that is the same pill: the predicate is false, so nothing moves. The design already
has the answer; only the entry point is new.