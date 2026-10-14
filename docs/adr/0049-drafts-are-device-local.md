# 0049. A draft belongs to the browser that received it

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Conversation list and chat view spec"
**Builds on:** [0022](0022-settings-boundary-and-transports.md) (three homes for a setting), [0004](0004-message-durability.md) (send queue, idempotency key)
**Teaches:** [`docs/concepts/conversation-list-and-chat-view.md`](../concepts/conversation-list-and-chat-view.md)

## Context

The ticket asked whether a draft is local, and what happens to it on a second device. The question
is well posed and the answer is not obvious, because [0022](0022-settings-boundary-and-transports.md)
gives a rule for every setting in the product and a draft is the first thing the rule does not cover.

The rule is: *anything needed before first paint is device-local; anything needing the server's
authority is account-scoped; anything scoped to a relationship lives on the membership.* A draft is
not a **setting**. It is content that has not become a Message yet. There is no third home for it and
the rule is silent, which means the decision has to be made on the merits.

The merits are dominated by one property: **a draft is the only thing in vartalap that a member
types into and does not expect to lose.**

## Decision

### A draft is device-local, stored in Dexie, keyed by conversation

It lives beside the send queue. It syncs to no account column, no membership, no server, and **no
second device ever sees it** — including a device that is signed in as the same member right now.

### A draft is cleared when the message enters the send queue, not when it sends

Sending is a `POST` with one response ([0004](0004-message-durability.md)), and it can fail.

- Clear on `Enter`, and a failed send leaves the composer empty with the text in a bubble marked *Not
  sent*. Recoverable, but it reads as a loss.
- **Clear when the text becomes a row in the send queue**, and the composer empties immediately. The
  text is now owned by the queue row, which already carries an idempotency key and survives a
  reload. It cannot be lost by a retry, a reconnect, or a refresh.

The visible behaviour is identical and the difference is invisible until the day a send fails.

### Writes are debounced, plus two writes that are not

**500ms after the last keystroke**, and unconditionally on `visibilitychange → hidden` and on
`pagehide`.

`pagehide` is the one that earns its line. `beforeunload` fires reliably on desktop and **unreliably
on mobile**, where a tab can be discarded without any teardown event at all; `pagehide` is the event
mobile browsers actually deliver. A draft autosave that only runs on the debounce loses the last
half-second of typing to a tab discard, which is exactly the moment a member switches apps.

### Never a `beforeunload` prompt, and never a "you have unsent text" nag

A composer that asks before closing is a composer that gets dismissed without reading, which trains
members to dismiss it.

## Why not account-scoped

**Syncing a draft is a write per keystroke, a conflict resolution problem, and a
last-write-wins data-loss bug.** These are three reasons, and they are ordered by how expensive they
get:

1. **Cost.** A write per keystroke is a write per keystroke against a database chosen for cheap
   storage ([0008](0008-media-pipeline.md) chose R2 on egress, not price, but the posture is the
   same). Debouncing fixes the volume and does not fix the next two.
2. **Conflict.** Two devices with the same draft open. A merge is undefined — what is a paragraph?
   — and the only implementable resolution is last-write-wins, which **silently destroys one
   device's text with no prompt and no undo**.
3. **The failure is the worst kind.** Losing a *sent* message is a queue that flushes and a
   conversation that catches up. Losing *typed text* on a second device is a person rewriting a
   paragraph they already wrote once, with nothing in the interface saying that happened.

Slack and Discord sync drafts across devices. Both also run client software with a persistent local
store and an established sync layer, and both treat a draft as recoverable in a way a first-version
single-operator deployment is not. **The feature is not wrong; the cost is not justified yet.**

## Consequences

- **The composer paints from Dexie with no network round trip**, which is the same shape as theme and
  density ([0022](0022-settings-boundary-and-transports.md)) and the reason a device-local draft is
  the coherent choice: everything this screen needs before it can be read is already on the device.
- **A draft survives a reload and a crash**, because it is a row in IndexedDB and not a React state
  variable.
- **Two devices showing different composers for the same conversation is correct, not a bug**, and
  there is nothing to reconcile. That sentence belongs in the settings screen next to theme, in the
  "on this device" pattern [0022] established.
- **A draft is not a Queued send and the two never merge.** Before `Enter` it is text in an input,
  private to one browser. After `Enter` it is a message with an idempotency key, in the durable send
  queue, retried forever by [0004](0004-message-durability.md)'s rules. The vocabulary keeps them
  apart — `GLOSSARY.md` bans "pending message" for exactly this reason — and a single row that is
  "draft until sent, queued after" would collapse two different durability promises into one
  boolean.
- **A draft is not readable by anyone else, ever.** No member, no admin, no export
  ([0022](0022-settings-boundary-and-transports.md)'s export enumerates what vartalap holds; a
  device-local draft is not in it, and that is not a gap in the export).

## What would reverse this

**A real native client.** The reason this is device-local is that a browser profile is a reasonable
unit of "this device". A phone app has an app container with exactly the same property, and the
second device is still a second device. Sync does not arrive with native; it arrives when the thing
being synced is expensive enough to lose.

**Draft sync as a feature request from actual use** is the honest trigger, and it should be measured
rather than guessed: how often do members switch devices mid-thought. Until that number exists the
cost side of the argument is three unquantified reasons and the benefit side is zero reports.

**If it is built**, the shape is already constrained by this ADR: a `POST`-per-debounced-change
carrying the draft's text and a `client_revision` integer, resolved by rejecting the write whose
revision is behind the stored one — **reject, never overwrite**, so the losing device can *tell* its
member that a draft was displaced instead of silently eating it. The alternative, last-write-wins, is
the bug this ADR declined to ship in the first place.