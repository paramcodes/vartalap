# 0048. Scroll anchoring belongs to the browser, which is why v1 does not virtualize

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Conversation list and chat view spec"
**Builds on:** [0005](0005-message-ordering.md) (keyset paging, 50 rows), [0002](0002-messenger-token-layer.md)
**Teaches:** [`docs/concepts/conversation-list-and-chat-view.md`](../concepts/conversation-list-and-chat-view.md)

## Context

The ticket asked what happens to scroll position when older messages are prepended above the
viewport. Everyone answers this by writing code: measure `scrollHeight` before, render, measure
after, subtract. It is the reflex, and here it is the wrong reflex — because **the browser already
does it**, by default, to a specification, and the hand-rolled version fights it.

The CSS Scroll Anchoring Module Level 1 is a W3C Working Draft (11 November 2020), and its whole
purpose is this exact problem:

> Changes in DOM elements above the visible region of a scrolling box can result in the page moving
> while the user is in the middle of consuming the content. This spec proposes a mechanism to mitigate
> this jarring user experience by keeping track of a position of an anchor node and adjusting the
> scroll offset accordingly.

`overflow-anchor` computes to `auto` initially and is not inherited. The anchor node is chosen deep
in the visible region, deeper nodes preferred, and when it moves the browser queues a scroll
adjustment for the end of the current task's suppression window.

So the decision is not "how do we preserve scroll position". It is **"when do we take it away from
the browser"** — and the answer is: never, in v1.

## Decision

### We do not hand-roll scroll preservation, and we do not virtualize the transcript in v1

`overflow-anchor` stays at its initial `auto`. Nothing in the transcript container sets it to `none`.
Older pages are prepended into the live DOM, and the browser holds the view.

**These two decisions are one decision.** Scroll anchoring compensates for content inserted above the
viewport by watching a real DOM node — the anchor node. **A virtualizer unmounts the nodes the
transcript is made of**, including whatever the browser had chosen as the anchor, and the mechanism
has nothing to watch. The moment the transcript is windowed, scroll preservation becomes our code
again, with the double-correction risk that invites.

### `content-visibility: auto` with `contain-intrinsic-size` bounds the cost instead

Every **run** gets `content-visibility: auto` and a `contain-intrinsic-size` matching one message's
height. Off-screen runs skip layout, paint and compositing while remaining in flow and in the DOM.

That gives the performance win of windowing without the correctness loss: the anchor node survives,
find-in-page still works, and the `role="feed"` contract's `aria-posinset`/`aria-setsize` stay
truthful because positions are not renumbered as content is recycled.

Baseline: `content-visibility` is in Chrome, Safari 18+, and Firefox 125+. Where it is unsupported
the transcript is simply a longer DOM, which is the behaviour we had anyway.

### The two ways this is silently cancelled, both specified

Both come from the module's own text and neither produces an error.

**1. Calling `getBoundingClientRect()` in the same task as the prepend.** The suppression window
"ends at the end of the current iteration of the HTML Processing Model event loop, **or immediately
before the next operation whose result or side effects would differ as a result of a change in the
scroll position (for example, an invocation of `getBoundingClientRect()`)**, whichever comes sooner."

Which means: the natural implementation — "I need to know where we are so I can load more, and here
is the new page" — measures the scroll position, prepends, and the measurement itself cancels the
compensation. The transcript jumps, and the bug reads as a scroll bug with nothing in the console.

**The rule: measure before the mutation, never after it in the same task.**

**2. An anchored element whose box changes.** The suppression triggers list changes to `margin`,
`padding`, `width`, `height`, `min-*`, `max-*`, `position` and `transform` on any element on the path
from the anchor node to the scroll container. So a run that grows — an image whose dimensions arrive
late, a composer's `max-height` changing — cancels the adjustment for that prepend.

**The rule: every run reserves its height before its content is known.** `contain-intrinsic-size`
already does this, which is the second reason it is on every run and not an optimisation.

### `aria-busy` is the pagination affordance, and forgetting to unset it hides the transcript

The WAI-ARIA Authoring Practices Guide's Feed pattern requires `aria-busy="true"` on the `feed`
container while articles are added or removed, and warns in as many words:

> it is extremely important that `aria-busy` is set to `false` when the operation is complete or the
> changes may not become visible to some assistive technology users.

A `role="feed"` stuck at `aria-busy="true"` is a transcript a screen reader cannot read at all. This
is the worst failure mode on the screen, it is one line, and the line that forgets it is usually the
one in the error path.

## Consequences

- **Prepending a page cannot scroll the view, by default, with no code.** The mechanism the browser
  provides is the correct one, and the risk is entirely in disabling it.
- **There is no windowing library in v1**, and that is a dependency decision as much as a UI one. The
  library would also have to solve `aria-posinset`, find-in-page, and anchor survival — three things
  it does worse than the platform.
- **`aria-busy` is set in a `finally`, not in the success path.** The failure that costs the most
  accessibility is the one that happens when the request fails.
- **A member using find-in-page gets the anchor for free**, because the spec makes the active
  find-in-page match a *priority candidate* for anchor selection. Focusing a message has the same
  status. Both mean **never call `scrollIntoView` on render** — it fights a mechanism that is already
  doing the right thing.
- **A long transcript is bounded but not windowed**, and the bound is one `contain-intrinsic-size`
  per run. If that turns out to be insufficient the escalation is still not a windowing library: it
  is evicting message rows from Dexie for closed conversations, which is a storage decision.

## What would reverse this

**A transcript long enough that `content-visibility` is not enough** — thousands of runs loaded in
one conversation, which needs roughly 50 pages of a very busy group. The threshold is measurable, and
the first thing to measure is total rendered nodes, not message count.

If it is reached, the reversal is **not** "add a virtualizer and reimplement scroll preservation".
The two reversals are independent, and the cheap one comes first: keep the anchor node by pinning a
single sentinel element near the viewport (`overflow-anchor: none` on the runs, letting a live
sentinel be the anchor) is still cheaper and still less code than a windowing library, and it
survives unmounting.

**Turning anchoring off is a legitimate response to one thing**: a member who has scrolled up and is
reading, on a transcript where the anchor is inside a run that keeps reflowing because of an image
still loading. That is a bug in the image, and `contain-intrinsic-size` is the fix. If anchoring ever
needs disabling *globally* to work around it, the reflow is the problem and the workarounds will
pile up.