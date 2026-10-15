# 0064. The list navigates with react-router, reads with TanStack Query, and hand-rolls its aside

**Status:** Accepted
**Date:** 2026-10-15
**Resolves:** stage-6 unit 6.2 dependency justification (stage rule: new dependencies need an ADR)
**Depends on:** [0045](0045-conversation-list-orders-by-a-position.md), [0046](0046-mute-is-a-marker-not-a-filter.md), [0055](0055-desktop-layout-is-four-columns.md), [0062](0062-static-react-spa-and-test-dom.md)

## Context

The list needs navigation (list → transcript, and 0055's sub-760px one-pane
routing) and a server-authoritative read with cache states the concept's
four loading rows map onto. The decisions index already names TanStack Query
for server reads — that choice stands and needs no argument here. The router
and the container are open.

## Decision

`react-router` for navigation. It is the smallest router that gives the two
routes 6.2 needs (`/` and `/c/:id`) and the back navigation the narrow layout
needs. No framework-mode router: there is no SSR to integrate with (0062).

`@tanstack/react-query` is installed, not decided here — the index decided it.
Its cache is the list's cache: pending/settled/fetching/error map directly
onto `Loading…` / rows / progress bar / `Can't load conversations`, with no
second store for server-authoritative metadata.

The list container is a hand-rolled `<aside>`, not the shadcn `Sidebar` —
deliberately, and the one place this unit deviates from a stated preference.
0055 says the list "should use it", but the row markup the concept specifies
(article + link feed pattern, 72px rows, avatar stack, trailing time) does
not fit `SidebarMenuButton`'s button shape, and the registry's current
`Sidebar` is Radix-based while the index decides Base UI. Vendoring a
Radix tree (slot, dialog, tooltip, button, separator, input, skeleton) to
house bespoke rows would contradict the Base UI decision to honor a
preference. The trap 0055 warns about — three `SidebarProvider`s, three
`Cmd+B` handlers — is honored structurally instead: exactly one collapsible
region exists, so the failure cannot occur. Sidebar adoption is revisited
when a row design that fits its primitives exists, not before.

`Cmd+B` toggles the list and persists to `localStorage` (0055: pane state is
device-local). No icon-collapse mode: the rail is already icon-sized, so
`collapsible="icon"` would buy nothing — 0055's own reasoning.

## What would reverse this

A row redesign around menu-button primitives, at which point the Sidebar
(with its mobile Sheet and collapse handling) replaces the aside in one
unit. Or a second navigable surface, at which point the two-route router is
re-examined rather than grown by accretion.
