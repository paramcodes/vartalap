# 0050. The composer's shape and copy are chosen here, not inherited

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Composer and media sending spec"
**Closes:** the open item in [0002](0002-messenger-token-layer.md) — *"The composer. Its copy and shape were not sourced at all, and are marked as such rather than invented confidently."*
**Builds on:** [0002](0002-messenger-token-layer.md) (tokens, radii, motion), [0049](0049-drafts-are-device-local.md) (a draft is text)
**Teaches:** [`docs/concepts/composer-and-sending.md`](../concepts/composer-and-sending.md)

## Context

[0002](0002-messenger-token-layer.md) built the token layer from DOM captures of messenger.com and
then listed what it had *not* captured. The composer was on that list, and it was left off
deliberately: a spec that invents a shape and then labels it observed is worse than a spec that says
it does not know. The token-layer ticket therefore said the composer was UNVERIFIED and handed the
problem forward.

This ticket is the forward. **Nothing below was captured.** Every value is a choice, argued from the
token layer we did measure, from the constraints the chat view already imposed, and from what a
keyboard, a screen reader and a virtual keyboard require. Where a choice looks like it might be
Meta's, it is not — it is ours, and it is labelled.

## Decision

### One rounded surface with the attach button inside it and send outside it

```
┌───────────────────────────────────────────────┐
│  ( + )  Message…                              │        ( ➤ )
└───────────────────────────────────────────────┘
```

- **The field surface** is `--radius-2xl` (25.7px from the `--radius: 12.857px` anchor),
  `--surface-composer`, no persistent border. It grows to 160px and then scrolls internally —
  inherited from the [chat view](../concepts/conversation-list-and-chat-view.md#the-composer).
- **The attach button** is a 36px circle at the surface's inline-start, icon only,
  `--text-secondary`. It has no fill and no border until hover.
- **The send button** is a 36px `--accent` circle with a white glyph, outside the surface at the
  inline-end, **always rendered and disabled when there is nothing to send**.

The asymmetry is the decision. Putting send *inside* the field means the control that grows with the
text is the control being pressed; putting it *outside* means the target a member aims at stays the
same size and the same place from one keystroke to a thousand.

### Four copy strings, chosen

| | |
|---|---|
| Visible placeholder | `Message` |
| Accessible name of the field | `Message {display name}` |
| Attach button | `Add photo` |
| Send button | `Send message` |

The accessible name carries the member's display name and the visible placeholder does not. A
placeholder is not a label — it disappears the moment there is text, it fails WCAG 4.1.2 as the only
name, and it cannot disambiguate two textareas with the same job. The real `<label>` is
`.sr-only`; the placeholder is decoration that tells an unsighted-as-yet member what the box is for.

### No emoji button in v1

Emoji arrive by typing, or from the platform keyboard's own emoji key. **Rejected:** a picker that
inserts only Unicode characters. A picker is the doorway to stickers, GIFs and reactions; shipping
the empty half of that doorway teaches people to look for a menu that has nothing in it, and it
costs a popover, a focus trap, and a screen-reader walk through several hundred glyphs for one
feature. The Unicode half can be added on top of the Tier 2 sticker picker, not before it.

### No `autofocus`

**Rejected:** focusing the composer when a conversation opens. On a phone it raises the software
keyboard over the transcript you just scrolled to the bottom of, on every open, including the
opens you performed by tapping a notification. Focus stays where the browser put it; `Escape` from
the transcript moves it to the composer, which is the affordance people actually want and costs one
listener.

### `field-sizing: content` is not used

`field-sizing` is **Baseline as of 2026** and does auto-growing natively, which removes the four-line
`scrollHeight` dance the chat view inherited. **Rejected anyway**, for two reasons. MDN notes that a
`field-sizing: content` textarea "behave[s] much like single-line text controls" — it shrink-wraps
its inline size as well, which puts a shrink-to-fit parent directly back into the path that produced
[0002](0002-messenger-token-layer.md)'s first prototype bug, where a `max-w` on a shrink-to-fit
chain collapsed bubbles to a third of their width. And the fallback path would then need to be
written and tested anyway, because a token layer this repo holds in prose rather than in a test
suite is not somewhere to make the modern path the only path.

## Consequences

- **This ADR is a decision, not evidence.** Anyone who reads it later and wants Messenger's exact
  composer should know what to do: capture it the way [0002](0002-messenger-token-layer.md) did, and
  correct *this file* rather than the other way round. That is the cheapest possible reversal,
  because nothing here is load-bearing on the server.
- **Four tokens are defined that prose already referenced.** `--surface-composer`,
  `--opacity-queued: 0.6`, `--danger`, and an opaque `--ring` were all named by earlier documents
  without being given a value, which is trap 1 in the decision index: a token with no caller does
  not exist. Two of them — `--surface-composer` in both themes — are **UNVERIFIED** and are marked
  as chosen values, because Messenger's own values were never captured.
- **The composer's colours are the first thing that will look wrong**, because they are the only
  part of the shell built from argument rather than from a DOM. That is the honest ordering.

## What would reverse this

**A capture.** One screenshot series of messenger.com's composer in both themes and at three
viewport widths, measured rather than eyeballed, replaces this file's visual claims wholesale. That
is the only reversal worth naming, and it is cheap.

**A native client** would reverse the `enterkeyhint` reasoning and the touch-target sizes, because a
phone app has a native keyboard whose Send key already exists and a native photo picker whose
camera affordance is not a question.
