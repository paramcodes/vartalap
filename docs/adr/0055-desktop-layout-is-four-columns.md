# 0055. The desktop layout is four columns, and collapsing one is not a media query

**Status:** Accepted
**Date:** 2026-10-14
**Resolves:** wayfinder map "vartalap — spec and architecture map", ticket "Build the spine first" — desktop layout gap raised after the map closed
**Depends on:** [0002](0002-messenger-token-layer.md), [0022](0022-settings-boundary-and-transports.md), [0050](0050-the-composer-is-chosen-here.md)
**Evidence:** `prototype/messenger-shell/desktop.html`, variants A–D

## Context

Thirty-three ADRs and fourteen concept documents described a product with no layout at
widths above a phone. A grep across all forty-seven documents for `responsive`,
`breakpoint`, `desktop`, `pane` or `sidebar` returns nothing that describes a desktop
layout.

That is not an oversight in the documentation. It is a false premise carried forward.
Ticket #4 asked for the interface "shown at three widths"; it was rendered at 300, 380
and 480px — three widths of the same phone-shaped column — and recorded as the layout
decision. Every ticket after it inherited it, and nothing ever questioned it, because a
three-width mobile prototype looks like evidence of responsiveness.

When it was finally raised — *"can you tell me why it's just mobile version and no
desktop version? how would I know how it would look in desktop"* — the gap was real,
the diagnosis was trivial, and closing it is expensive precisely because it was skipped
rather than decided.

**Verification changed the premise twice, and both times against the assumed answer.**

The first pass concluded that messenger.com has **three regions and no right-hand
pane**, on the strength of Meta's own screen-reader specification for the site, which
enumerates every landmark: a top banner, a left "Conversations" nav, and "Main". That is
good evidence, and it settled several things — that search and settings are global and
live in the banner, that the composer is a single "Type a message" field where Enter
sends and there is **no send button**, and that there is no dark mode on messenger.com
at all.

The second pass was the operator's own screenshot of the old Messenger desktop. It
shows **four columns**: an icon rail, the chat list, the transcript, and a details pane
carrying the profile, actions, and a grid of shared media. A persistent third pane would
have appeared in a specification written to enumerate regions, so the negative finding was
stated too confidently — an accessibility document does not necessarily list a
decorative one.

**A screenshot is better evidence of visual layout than an accessibility specification,
and it won.**

## Decision

**Four columns. `rail · list · transcript · details`, laid out across the full viewport,
with the two outer panes independently collapsible and the transcript fluid.**

| Column | Width | Collapses | Shortcut |
| --- | --- | --- | --- |
| Rail — sections | 64px, or 184px with labels | labels only, never hidden | — |
| List — conversations | 320px | yes, to zero | `Cmd/Ctrl+B` |
| Transcript | fluid, content capped at 760px | never | — |
| Details — conversation | 300px | yes, to zero | — |

Three width regimes, and **the width always wins over the toggle**:

- **≥ 1150px** — all four columns. Below 1150 the details pane is *refused*, not closed:
  the toggle is disabled, and the refusal is stated rather than silently swallowed.
- **760–1149px** — rail, list, transcript.
- **< 760px** — one pane at a time, with a back affordance. The list and the transcript
  are not two panes with one hidden; they are one pane that moved.

**Losing the room for a pane is not the same as deciding to close it.** Narrowing the
window never overwrites the stored preference. The pane comes back when the room does.

**Pane state is device-local.** ADR 0022's rule decides it: a pane preference is a view
preference, not a fact about you, and it is wrong on a different screen. `localStorage`,
never the account.

**`Cmd/Ctrl+B` belongs to the list alone.** Every shadcn `SidebarProvider` installs its
own `Cmd+B`; three sidebars would mean three handlers on one key.

### What this is built from, and what it is not

The reference is the **old** Messenger desktop, which Meta **shut down in December 2025**.
This layout is therefore *inspired by* Messenger, not a match of anything still shipping.
Claiming fidelity to a retired product would be a lie with a date on it.

Excluded on purpose: **Shop**, **Requests** and **Archive** are Meta product surface —
commerce and Meta-specific triage, not chat. **Voice notes** are Tier 2 and out of v1 per
the map. **Favourite chats** sits below the shared-media grid, is drawn dashed and tagged
`v2` so it cannot be mistaken for scope, and when it ships it is **membership-scoped**:
it lives on the conversation, because that is where it expires — when you leave, so does
the favourite.

**Every number above is ours.** Rail 64, list 320, details 300, cap 760, breakpoints 760
and 1150 — none of them was recovered from a source, because no source exists. Facebook
serves messenger.com through Comet, its CSS-in-JS system, behind a login; every archived
capture — 2016, 2018, June 2024, and today — is the logged-out login shell. They are
defaults to be judged by eye, not facts.

## Why

**The details pane is not decoration. It is the answer to a question the research could
not settle.**

Variant A, two panes with the transcript filling the viewport, and variant B, a capped and
centred transcript, were both left open because nobody could verify which one Messenger
uses. At 1920px variant A produces a ~1500px column with messages flung to opposite edges
and a void in the middle: unreadable. A third pane holding the width is what makes the
mid-range readable, which is why the details pane earns its 300px rather than spending it.

**The transcript cap is still needed with the details pane open.** At 1920px the transcript
pane is 1236px wide; the cap holds the content to 760px and centres it. The pane fixes the
mid-range, the cap fixes the top of the range, and neither substitutes for the other.

**The rail is not a sidebar, and neither is the details pane.** shadcn's `Sidebar` supports
`side="right"`, per-instance `--sidebar-width`, and `collapsible="offcanvas" | "icon"`, so
the conversation list is an exact fit and should use it — the unread badge is literally
`SidebarMenuBadge`. But the rail's expanded width is 72px, not `16rem`, so
`collapsible="icon"` buys nothing when the "expanded" state is already icon-sized; and the
details pane never collapses *to icons*, so icon mode is irrelevant to it. Three nested
`SidebarProvider`s would also mean three `Cmd+B` handlers and three mobile Sheets, which is
three ways to get a phone layout wrong. The rail and the details pane are flex columns. The
list is a `Sidebar`.

**And the breakpoint is a decision rather than a CSS detail.** Below 760px the app is not
"two panes, one hidden" — it is one pane that moved, and *back* means something different
there. Routing and state follow from that, which is exactly why it belongs in an ADR
instead of a media query. Retrofitting it after stage 6 would mean rewriting navigation.

## Consequences

- **Dark mode is ours, not fidelity.** Meta's help centre states verbatim that dark mode is
  not available on messenger.com; only the retired desktop *app* had it. ADR 0002 built a
  full dark token set and it stays, but it is an invention. Every dark value is a decision
  to defend, not a measurement.
- **The send button is ours too.** messenger.com has none — Enter sends. ADR 0050 chose one.
  The reference image has one. Both can be true; the split has to be explicit rather than
  accidental.
- **No keyboard shortcuts are documented for Messenger**, so every shortcut here is ours.
  `Cmd+B` is the only one this ADR commits to; more can be added, each deliberately.
- **Layout work now exists that did not before**, which is the cost of the gap and not a
  new burden.
- **These numbers will be wrong.** They are placeholders with a justification, checked by
  eye at 375 / 768 / 1024 / 1440 / 1920, and expected to move.

## What would reverse this

**A transcript cap wide enough that no pane is needed.** If 760px is wrong and 1100px is
right, the details pane stops paying for itself and variant B wins outright — four columns
becomes two.

**Real measurements.** The only way these numbers stop being ours is a logged-in browser
with DevTools: resize the window, read the computed values, record them. That is a
ten-minute job for someone with an account, and it would make this ADR cite a source
instead of admitting it has none. Until then, any future claim that "Messenger does X" about
layout should be treated as unverified unless someone has actually looked.

**A live product to copy.** messenger.com was discontinued on 16 April 2026, and its
successor is `facebook.com/messages`, a different Facebook-branded surface. If vartalap
should match what ships *now* rather than what was good, this ADR is the wrong reference
and the work starts again against the new one.
