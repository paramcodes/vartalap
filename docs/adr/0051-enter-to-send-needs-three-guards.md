# 0051. Enter-to-send needs three guards, and `isComposing` is the weakest of them

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Composer and media sending spec"
**Overrides:** [`docs/concepts/conversation-list-and-chat-view.md`](../concepts/conversation-list-and-chat-view.md) — *"check `event.isComposing` on the `keydown` … the legacy `keyCode === 229` sniff is not a substitute."*
**Teaches:** [`docs/concepts/composer-and-sending.md`](../concepts/composer-and-sending.md#the-ime-rule-is-three-belts)

## Context

The chat view settled the keyboard contract as **Enter sends, Shift+Enter breaks the line**, and
settled the IME rule with one sentence: check `event.isComposing` on the `keydown`, and treat the
legacy `keyCode === 229` sniff as inferior.

**That sentence is wrong, and it is wrong in the direction that costs the most users the most.** On
2026-10-14 a check against WebKit's own bug tracker produced this timeline:

| When | What |
|---|---|
| 2016-11-21 | [WebKit 165004](https://bugs.webkit.org/show_bug.cgi?id=165004) filed: *"The event order of keydown/keyup events and composition events are wrong on macOS."* |
| 2018-04-22 | On that same bug: *"The Enter key that accepts the IME input will be sent with `isComposing === false`, because Safari is sending events out of order… This makes comparing `keyCode === 229` the only reliable way to detect whether IME is being used or not, even though modern APIs are available, because they are giving the wrong results."* |
| 2026-04-16 | [WebKit 311717](https://bugs.webkit.org/show_bug.cgi?id=311717) lands: *"turn on correct composition event ordering by default."* 165004 is closed as a duplicate. |
| 2026-06-15 | [WebKit 317127](https://bugs.webkit.org/show_bug.cgi?id=317127) lands: **"Disable InputMethodUsesCorrectKeyEventOrder"** — *"We've been getting too many regression reports. Disabling this behavior everywhere."* |
| 2026-09-16 | [WebKit 324380](https://bugs.webkit.org/show_bug.cgi?id=324380) (NEW): even with Safari 26's manual Feature Flag enabled, **macOS Web Apps — a PWA added to the Dock — keep the legacy ordering.** *"the Enter keydown is exposed to page script with `isComposing === false`."* |
| 2026-10-07 | On 311717, to avoid the misconception: *"This was reverted by 317127 … It must be reopened immediately to avoid the misconception that it has been fixed."* |

Two things make this the sharpest finding of the ticket rather than a footnote.

First, **the fix was reverted, and the re-flagging is a week old.** Safari fires `compositionend`
before `keydown` today, by default, everywhere. The one configuration with the correct ordering is a
Feature Flag in `Safari → Settings → Advanced`, which no user enables.

Second, **vartalap is a web-first PWA.** WebKit 324380 is a bug filed specifically about the
configuration we ship. The surface where the ordering is wrong is the surface we are building.

MDN reflects this: `KeyboardEvent.isComposing` carries the **Limited availability** flag, and
[mdn/browser-compat-data#29998](https://github.com/mdn/browser-compat-data/issues/29998) is an open
complaint, filed 2026-07-08, that Safari's "full support" flag is misleading for exactly this reason.

## Decision

**The guard is three belts, and no one of them is sufficient.**

```ts
// A flag we own, not one the browser reports.
let composing = false;

onCompositionStart = () => { composing = true; };
onCompositionEnd   = () => { queueMicrotask(() => { composing = false; }); };

onKeyDown = (e: KeyboardEvent) => {
  if (e.key !== 'Enter') return;
  // Belt 1 — the flag we own. The microtask is what survives Safari's ordering.
  if (composing) return;
  // Belt 2 — the property, for any browser that gets it right.
  if (e.isComposing) return;
  // Belt 3 — the "legacy sniff" the chat view document rejected.
  if (e.keyCode === 229) return;
  send();
};
```

Each belt covers a different browser's failure:

- **Belt 1 is the fix.** Square found this in 2018 and fixed it by deferring the clear out of
  `compositionend` by one microtask, so Safari's late `keydown` still sees `composing === true`.
  It works in every browser, and it works in the ones that order events correctly too.
- **Belt 2 is free.** It is what the spec says and it is right in Chrome and Firefox.
- **Belt 3 is what Safari honours.** `keyCode` is deprecated; it is kept here anyway, because a
  deprecated property that suppresses a send is cheaper than the bug. It is the belt that works when
  belt 1 somehow has not been wired up yet.

The chat view document's claim is **reversed**, not softened: `isComposing` alone does nothing on
Safari today, and `keyCode === 229` is not a substitute for it so much as the only thing Safari
honours.

## Consequences

- **The cost is five lines and one boolean.** That is the whole price of not sending half a
  Japanese, Chinese or Korean word to someone.
- **Nobody may "simplify" this to the one-liner.** The obvious cleanup is to delete the flag because
  `isComposing` is the modern property and the microtask looks clever. Deleting it reintroduces a
  data-loss bug on the one platform where it is hardest to notice — it only shows up when a person
  with a CJK input method presses Enter to pick a candidate, and nothing crashes.
- **There is no test that catches this** in a headless suite, because the ordering is a property of
  Safari's event loop. The only verification is manual, with a Japanese IME, in Safari, on a PWA.
  That is worth stating plainly rather than implying a green CI run means anything here.
- **The same flag governs the auto-grow.** The composer resizes on every `input`, including ones with
  `isComposing === true`. That is a second decision recorded in the concept document, and it points
  the other way: deferring the resize during composition leaves the candidate window anchored to a
  caret whose box we have moved, and stale caret geometry during a resize is a documented failure.

## What would reverse this

**A WebKit bug going green with no Feature Flag and no exceptions**, including 324380. The day Safari
fires the spec'd order in a macOS Web App by default, belt 1 stops earning its place and the other
two still do. Until then it is three lines of belt against a bug tracker that has been reopened,
closed, reverted and re-flagged inside the last six months.

**A `beforeinput` rewrite** would be a better long-term answer — it is the event that has to be
prevented, and it is cancelable — but it is a larger rewrite of the input path for the same
protection, on a surface that is paid for on every message sent.
