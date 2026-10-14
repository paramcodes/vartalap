# 0052. A media message is staged before it exists, and send never waits

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Composer and media sending spec"
**Builds on:** [0004](0004-message-durability.md) (persist before acknowledge), [0008](0008-media-pipeline.md) (upload-then-send, the raw upload is never served)
**Teaches:** [`docs/concepts/composer-and-sending.md`](../concepts/composer-and-sending.md)

## Context

The ticket offered two shapes and named the trade honestly: *"Pick, preview, upload with progress,
then send. Or send immediately and upload in the background? The second feels faster and is much
harder to make honest."*

It also asked the question that decides it: *"What does the bubble show when the upload fails after
the message was already sent?"*

The answer to that question is the argument. **If the message is committed before its bytes, there is
a durable message pointing at media that may never exist** — visible in somebody *else's*
transcript, with no retry affordance available to them, because they did not send it and they
cannot. That is the one failure mode this whole document set is built to rule out: a message a
member believes was sent, in a place they cannot fix it.

## Decision

### One rule, from which every case follows

> **Pressing send sends the text and every attachment that is ready. A tile that is still uploading,
> or that failed, stays in the tray. Nothing is ever removed from the tray by pressing send.**

The alternative formulations are worse:

- **Block send until every upload finishes.** The send button goes grey with no explanation while a
  12MB photo uploads over hotel wifi, which is the dead control
  [0022](0022-settings-boundary-and-transports.md) exists to forbid.
- **Send the text, silently drop the unfinished attachments.** Silent loss is the failure mode the
  entire durable spine was built to exclude.
- **Cancel the unfinished uploads and say so.** The member did not ask to lose them, and they cannot
  tell which of the three files in the tray went missing.

The chosen rule never has a dead button and never drops anything a member did not decide to drop,
and it makes the ordering question below a non-event rather than a case.

### The upload starts when the file is staged, not when send is pressed

Staging is what makes "staged, not instant" feel instant:

1. **Pick** → a tile appears immediately, rendering an object URL of the picked `File`. Zero
   network, zero waiting, no spinner.
2. **In parallel** → presign, then `PUT` the bytes to R2.
3. **Ready** → the tile swaps the local preview for the worker's `thumb`.
4. **Send** → the ordinary optimistic text path, carrying references to whatever is ready.

### No upload percentage, and therefore no `XMLHttpRequest`

The obvious implementation of "upload with progress" is `xhr.upload.onprogress`. **Rejected, on
evidence.** Jake Archibald, from the `fetch` implementation notes: *"Upload and download progress is
unfortunately a missing feature in fetch. If you want progress events today, the best way is to use
XHR."* So XHR is the only source of a percentage — and the percentage would be **bytes handed to the
network stack, not bytes accepted by R2**. On a phone that ratio routinely reads 100% for several
seconds while nothing whatsoever is happening.

**So the UI has no percentage, which means the UI has no use for the only API that produces one.**
The upload is a `fetch` with an `AbortController`, and the whole client keeps one HTTP
implementation. The tile's indicator is an **indeterminate ring**, because that is the only thing
that can be true.

### A failed tile is a composition problem, not a send problem

A `Couldn't upload` tile never becomes `Not sent`. It is a tile that is not ready, so by the rule
above it simply does not go, and the send button stays available for the text. **Nothing is
partially sent**: the all-or-nothing-ness lives in the tray, not in the message.

### After the message exists, a worker failure is the sender's problem alone

If the bytes uploaded, the message committed, and the worker's `sharp` pass then failed: the
recipient sees a neutral tile reading `Photo unavailable`, and **no error styling and no red** —
because it is not their failure and they cannot act on it. The sender, whose message it is, sees
`Couldn't process` plus `Try again`, which re-uploads under the **same media id**.

### Cancellation means two different things and only one is offered

- **Before send:** cancelling a staged file is offered. It aborts the `PUT` *and* deletes the pending
  media record, because a cancel that leaves a record behind has lied about what it cancelled.
- **After send:** there is no cancel. The message is a queued send, and the only acts on a queued
  send are **wait** and **discard** ([0053](0053-nothing-is-retracted.md)). Cancelling an upload the
  message depends on would manufacture a message pointing at media that will never exist.

## Consequences

- **Ordering can genuinely invert, and that is correct.** Send a photo (12MB, poor connection) and
  immediately send "on my way" — the text commits first and takes the lower `seq`, so it arrives
  first. ADR 0005 orders by a server-assigned position and forbids the client interpolating one, and
  there is nothing to fix: both messages sat at the bottom of the transcript as queued sends until
  the server placed them, which is exactly what the interface showed.
- **The tray is above the composer surface, one row, horizontally scrollable.** Adding a tenth
  attachment scrolls the row; it never resizes the composer and never reflows the transcript.
- **A conversation that becomes locked while files are staged discards them and aborts any `PUT`.**
  The aborted upload may leave a pending media record, and that is the one leak this design
  accepts — [0008](0008-media-pipeline.md)'s scheduled purge of unreferenced objects is exactly the
  job that cleans up records nothing ended up pointing at.
- **A draft stores text only.** A `File` is not text and an object URL dies with the document, so
  staged files do not survive a reload while a draft does. Blobs in IndexedDB would make them
  survive; the cost is that a failed upload would then outlive the tab with nobody watching it.

## What would reverse this

**Cross-media upload composition.** If v1 ever accepts files the worker does not transcode —
documents, archives — "the bytes must exist before the message does" stops being the safe rule,
because a stalled `PUT` of a 40MB PDF would hold a message hostage. The rule is a consequence of
**every** attachment being an image the worker must derive, and it is the first thing to revisit the
day that stops being true.

**A progress signal that is actually true.** A byte count from the storage layer rather than the
socket would reverse the no-percentage decision — and no browser exposes one.
