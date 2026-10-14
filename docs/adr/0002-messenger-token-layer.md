# 0002. A `messenger` token block on plain `@theme`, with the radius anchored at 12.857px

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Messenger theme and chat shell"
**Feeds:** every UI spec ticket downstream of the token layer
**Prototype:** branch `prototype/messenger-theme-shell` — `prototype/messenger-shell/index.html`, throwaway

## Context

The map already decided the design system: shadcn/ui on Base UI, a hand-written Messenger token theme, our own identity, Inter, flat blue, no Meta assets. What was undecided was the **shape of the token layer** — whether those values actually compose into something that reads as Messenger, and what the layer has to guarantee before forty components inherit it.

No "Messenger design system" exists to copy. Meta open-sources Astryx, but that is for Meta's internal tools and has no Messenger theme. What does exist is Messenger's real tokens inside Meta's own shipped web CSS under a `--messenger-*` / `--chat-*` namespace, corroborated across independent DOM captures spanning 2024–2026. Those are the visual spec; the *conventions* are the design.

Building the shell to find out produced three findings that a paper decision could not have produced. Each one is a standing constraint on the token layer, not a detail of one component.

## Decision

**The token layer is a single `@theme` block of custom properties, using the radii from Meta's tokens and a radius anchor of `12.857px`, with bubbles rendering their base radius *through* the token rather than through a literal. Variant A — the grouped composition — is the shell.**

### `--radius: 12.857px`, and `--radius-xl` therefore is 18px

```
12.857 × 1.4 = 17.9998px  ==  --chat-bubble-border-radius
12.857 × 0.622 = 7.9971px ==  --messenger-card-corner-radius
```

One number moves every radius in the system, and no component knows the value 18. **Do not round it to 12.86.**

### Plain `@theme`, never `@theme inline`

This is the load-bearing choice and the one most likely to be lost to a well-meaning cleanup. Tailwind v4's `@theme inline` pastes each token's literal value straight into every utility that uses it. The `.dark` overrides then have nothing to override: the values are frozen into the class definitions at build time. Plain `@theme` emits real custom properties on `:root` and makes utilities *reference* them, so an entire theme is re-theming by reassigning variables under a `.dark` scope.

### Bubbles take their base radius from the token; only narrowed corners are inline

A burst run overrides at most two corners. Everything else — all 41 bubbles' base radius — comes from `--radius-xl` in CSS.

### Bubbles use logical longhands

`border-start-end-radius` / `border-end-end-radius`, not physical `top-right` / `bottom-right`. "Inline-end" is then correct by construction for both incoming and outgoing, and correct under `dir="rtl"`, with no side branch anywhere.

### Dark is its own token set, and the outgoing bubble does not change

Meta sets the outgoing bubble to the brand accent in light and dark alike. Verified in a browser: `rgb(0, 132, 255)` in both themes. Most of why dark-mode Messenger looks like Messenger is that one line not being inverted. Any theme work that darkens the outgoing bubble has stopped being Messenger.

### The focus ring is opaque in both themes

shadcn's default `focus-visible:ring-ring/50` measures about 2.4:1 on white, under the 3:1 non-text minimum in WCAG 1.4.11.

## Evidence

The prototype was driven in a real browser across three variants, both themes, both burst readings, both nub values, the deleted case and three card widths. Measured, not inspected:

- **Every bubble radius is `17.9998px`**, from `--radius-xl`, across 41 bubbles.
- **Exactly four distinct corner sets exist** in the transcript — single, first, middle, last — which *is* the state machine, confirmed rather than asserted.
- **The outgoing bubble is `rgb(0, 132, 255)` in light and in dark.**
- No console errors in any state.

### Tailwind v4 tree-shakes unreferenced theme variables

The single most important finding, and the one that nearly shipped as a false claim.

The first draft of the prototype declared the radius trick in a comment and hardcoded `"18px"` from JavaScript. Nothing rendered through `rounded-xl`. **Tailwind v4 silently removed `--radius-xl` from the compiled CSS and `rounded-xl` resolved to `0px`.** The file *looked* correct and asserted the headline claim in prose while proving nothing.

A theme variable with no caller is not a token — it is a comment. Tokens therefore earn their place by being rendered, and any value used only in one hand-written inline style stays a literal until something calls it.

### The fused burst reading, at 4px

Consecutive messages from one sender narrow their inline-end corners; runs are tighter than the gaps between them.

| run state | narrowed |
|---|---|
| `single` | — |
| `first` | start-end |
| `middle` | start-end, end-end |
| `last` | start-end, end-end |

Note that **`middle` and `last` are identical under this reading.** That was surfaced as a question during charting — it reads like a sign the state machine is wrong — and it was checked against a live render before being accepted. The defensible alternative (`nub`: only the run's last bubble narrows its bottom inline-end corner, middle bubbles stay full-radius) is implemented and toggleable in the prototype, as is the 4px-vs-6px value.

### A date divider terminates a run

The same author either side of a divider is two runs, each closing with its own nub. Implemented that way and confirmed visually. A run does not fuse across a divider.

### Four bugs the first render concealed

Each was caught by measuring the rendered result rather than reading the code. They are recorded because the pattern recurs, not because they were clever:

- **A width cap on a shrink-to-fit parent collapses it.** `max-w: 74%` on a bubble whose parent sizes to its own content resolves against a content-sized box, collapsing bubbles to a third of their intended width. The cap belongs on the row, never on the bubble in a shrink-to-fit chain.
- **Run indices indexed the divider-filtered list while lookups used the unfiltered transcript**, shifting every timestamp by the number of dividers above it. This produced *plausible* wrong timestamps rather than a crash, which is why it survived a first pass.
- **Single-message runs carried no timestamp at all**, because the state machine labels a one-message run `single` and the metadata guard tested for `last`.
- **`text-align` does nothing on a flex container whose only child is a text node.** The text is wrapped in an anonymous flex item that shrink-wraps to its own width, so there is no leftover space to distribute — the computed value reads `right` while the glyphs render on the left. The control here is `justify-content`.

A prototype that hides a bug is worse than no prototype, because it converts a question into a false answer. Every one of these survived a code read and died on a screenshot.

## Consequences

- **The UI spec tickets inherit a token layer, not a colour list.** Anything that needs a value the block does not define is adding a token, which means rendering it, which means it gets reviewed.
- **Rounding `--radius` silently breaks the one number everything depends on.** `12.86 × 1.4 = 18.004`. Keep the precision and leave a comment.
- **Two values remain UNVERIFIED and are labelled as such in the artifact**, because inferring them would have made the token block look more complete than the evidence is:
  - **Presence green.** `#31A73B` is Meta's canonical green, but no `--presence-*` token has been found in any capture. It is a plausible value, not an observed one. Worth a visual check against messenger.com before it hardens into anything.
  - **The composer.** Its copy and shape were not sourced at all, and are marked as such rather than invented confidently.
- **The classic blue `#0084FF` is the choice, not the current `#0866FF`.** The current Meta accent is rollout-dependent — the hex moves, the hue does not. Classic blue survives oklch round-tripping cleanly, so it is also the safer anchor for the `oklch` token pipeline the UI specs will need.
- **Motion is part of the token block, not per-component CSS**: `cubic-bezier(0.14, 1, 0.34, 1)` in over 280ms, `cubic-bezier(0.45, 0.1, 0.2, 1)` out over 200ms. Enter slower than exit.
- **Tail-less bubbles are structural, not cosmetic.** There is no tail element and no pseudo-element faking one. Clones that add iMessage-style tails diverge from the target in a way that is obvious once seen and hard to unsee.

## What would reverse this

A real `--presence-*` token, if one surfaces, replaces the inferred green — and only that. Nothing here is contingent on the values being exactly Meta's: the point of the block is that a value can be corrected in one place without touching a component.

The `@theme` vs `@theme inline` choice would only reverse if Tailwind shipped a first-class runtime-theme mechanism that made the inline form safe. Until then it is a correctness requirement, not a preference.

## Domain note

The shell prints **"Seen"**, because Messenger's does. `GLOSSARY.md` bans that word and defines **Receipt** as a member's record of how far they have read — never a property of a message. The split is deliberate and now recorded in the glossary: *Seen* is interface copy borrowed from a stranger's product, and the domain keeps Read and Receipt. Nothing in the model, schema, or protocol may use it.

A receipt is pinned under the last outgoing message, and under no incoming message ever — a receipt belongs to the local user. That distinction is enforced in the prototype and is a schema question for the read-receipts ticket, whose conflicting research reports the map already flagged.