# Prototypes

**Throwaway.** These files exist to answer a question and be deleted. None of this
ships. Nothing here is a component, a source of truth, or a starting point for `apps/`.

When a prototype settles a question, the answer goes into an ADR in `docs/adr/`. The
prototype is the evidence; the ADR is the decision. A decision that exists only as a
prototype has not been made.

## Running them

```sh
bun run proto        # http://localhost:4173
```

Or open any file directly. Prefer the server: `desktop.html` keeps its pane state in
`localStorage`, which Chromium refuses for `file://` origins — the write throws, the
code swallows it, and persistence silently stops working while the UI looks fine.

## What's here

| File | Question it answered |
| --- | --- |
| [`index.html`](messenger-shell/index.html) | What are the tokens? Annotated. |
| [`desktop.html`](messenger-shell/desktop.html) | What is the desktop layout? Four variants, A–D. |
| [`chat-view.html`](messenger-shell/chat-view.html) | What does a bubble look like? Corners, ticks, dividers. |
| [`composer.html`](messenger-shell/composer.html) | What happens while you type? IME, Enter, tray. |
| [`settings.html`](messenger-shell/settings.html) | Which settings scopes exist? Account / membership / device. |

`desktop.html` is the current reference for layout. `?variant=A|B|C|D` selects one;
the width presets across the top (375 / 768 / 1024 / 1440 / 1920) drive the frame.

## The token block is duplicated on purpose

Every file inlines ADR 0002's `@theme` block. This is not carelessness — the Tailwind
browser build **cannot** `@import` it, and that was verified rather than assumed:

```
<style type="text/tailwindcss">@import url("./tokens.css");</style>
  → every bg-*/text-* utility silently resolves to nothing, no console error
```

So the duplication is forced by the toolchain. What is not forced is the corruption
that usually comes with it, and that is what this script is for:

```sh
bun run check:tokens
```

It extracts the `@theme` and `.dark` blocks from every `prototype/**/*.html` and
fails if they are not byte-identical. Comments and whitespace included — a reindented
`rgba(0,0,0,0.06)` counts as drift.

**If a token must change:** edit `messenger-shell/index.html`, then copy the block
verbatim into the other five. Do not hand-merge, and do not change a value to make a
layout work — these values are ADR 0002 and several were verified by measurement
(`--radius: 12.857px` produces a 17.9998px bubble, not 18).

Run `check:tokens` in CI before this directory grows another copy.

## Rules

- Copy, don't import. A prototype that shares a stylesheet is no longer a prototype.
- Verify in a browser before believing it. Every layout bug found in this directory
  was found by measuring, not by looking — including a shrink-to-fit wrapper that
  made `max-w-[78%]` resolve against a 126px box and wrapped every two-word message.
- If a finding matters, it becomes an ADR in the same session.
