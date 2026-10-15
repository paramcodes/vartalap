# 0062. The interface is a static React SPA behind a same-origin proxy, proved with happy-dom

**Status:** Accepted
**Date:** 2026-10-15
**Resolves:** `docs/plans/stage-6.md` unit 6.0 — framework, shell, and the test DOM
**Depends on:** [0001](0001-self-hosted-better-auth.md) (same-origin cookie), [0002](0002-messenger-token-layer.md) (tokens, spent in 6.1), [0040](0040-security-headers.md) (nonce must survive the framework), [0054](0054-build-the-spine-first.md) (thin surface on a proven spine), [0055](0055-desktop-layout-is-four-columns.md) (four columns, routing follows), [0061](0061-the-client-data-layer.md) (Dexie owns message state)
**Evidence:** Bun guide "Using Testing Library with Bun" (happy-dom + RTL under `bun test`); `packages/auth/src/auth.ts:195` (same-origin default); `apps/realtime/src/server.ts:99` (same-origin assumption)

## Context

Three choices must be made together because each constrains the others: the UI
framework, the component-test DOM, and how `apps/web` serves versus renders.
The constraints are already on the record and point in one direction:

- The Better Auth cookie assumes same-origin (`auth.ts` sets `sameSite: 'lax'`;
  `server.ts` says a split origin needs `sameSite: 'none'` + `secure`).
- Dexie is client-only. The transcript renders from the Dexie table via
  `liveQuery`, never from component state (0061). Anything server-rendered must
  carve out every Dexie touch as client-only or it hydrates a lie.
- The app is authenticated with no public surface and no SEO. There is nothing
  for a crawler to read: onboarding ends at an empty conversation list.
- `apps/web` runs under Node (decisions index). The design system is shadcn/ui
  on Base UI with Inter and `#0084FF` — a React ecosystem.
- The hardening backlog states the framework is not pinned, and 0040 states the
  header module must not depend on one while whichever framework lands must be
  able to read a request-scoped nonce — the single most likely breakage.

The prototypes answered tokens and layout with throwaway HTML. They chose no
framework and are not a starting point (`prototype/README.md`).

## Decision

**`apps/web` is a static React 19 single-page app built with Vite, served from
one origin that proxies `/api/*` to the realtime service. Component tests run
under `bun test` with happy-dom and React Testing Library. No router in 6.0.**

### Framework: React 19 + Vite, no SSR

React because the decided design system (shadcn/ui on Base UI) is React-native;
no second ecosystem is evaluated once the system is fixed. Vite because it is a
bundler, not a framework: no router, no server components, no hydration model
to carve Dexie out of. SSR is rejected, not deferred — it buys nothing (no SEO,
no public surface) and costs a client-only boundary around every store touch
plus a hydration-mismatch class the static build never has.

### Serve: static `dist` + a tiny Node server that owns headers and the proxy

One origin serves the built assets and proxies `/api/*` (and `/__csp`) to the
realtime service, preserving `credentials: 'include'` on relative URLs and the
`lax` cookie with it. Split origins are rejected: they force `sameSite: 'none'`
+ `secure`, CORS, and a CSRF re-review for zero benefit. In dev, Vite's server
proxy does the same job.

The Node server mints the CSP nonce per document request and injects it into
the served HTML. Server owns both halves (mint and inject), so the 0040 failure
— middleware mints, renderer reads, mismatch renders a blank page — cannot
occur. Document responses are `Cache-Control: private`; hashed assets stay
edge-cacheable. CSP ships report-only in 6.0 and flips to enforcing per 0040's
one-week rule once the reports are read.

No router ships in 6.0. The shell has two states (signed out / signed in) and
no navigation. Routing arrives in 6.2 with the list, when list-to-transcript
navigation — and 0055's sub-760px one-pane routing — first needs it, with its
own dependency justification.

### Test DOM: happy-dom + React Testing Library, under `bun test`

happy-dom is the smallest DOM that renders components headlessly, and it is the
path Bun documents for Testing Library. jsdom is more complete and heavier;
nothing in stage 6 needs the completeness (no layout measurement — the eye
judges, the tests pin structure). Browser-driven component tests (Playwright)
are rejected: they need a browser in CI to assert what a DOM query already
pins, and the plan excludes visual regression explicitly.

Scope rule from the plan stands: a component test asserts what a state renders
as, never what the state means. Meaning stays pinned in the data layer (stages
3–5). One shell test in 6.0 proves the harness; list/transcript/composer
assertions arrive with their units.

## Consequences

- **Dexie never runs on the server.** There is no server render to guard, no
  `typeof window` branch, no hydration fallback. `liveQuery` components mount
  client-side always.
- **Same-origin is structural.** The shell fetches `/api/me` relatively; an
  absolute cross-origin URL silently drops the cookie (auth concept trap 7) and
  now has nowhere to come from.
- **`bun test` grows one preload** (`setup-dom.ts` before `fake-indexeddb.ts`).
  Non-component tests are unaffected — they gain inert `window` globals.
- **New dependencies in this unit:** `react`, `react-dom`, `vite`,
  `@vitejs/plugin-react`, `happy-dom`, `@testing-library/react`. Each exists
  for exactly one of the three decisions above. Anything beyond this (router,
  query client, component library) argues its case in its own unit.
- **Tailwind v4 `@source` globs are 6.1's problem**, budgeted there per the
  plan — workspace library code emits zero CSS until the globs are hand-written.

## What would reverse this

**A public surface that needs a crawler.** If the product grows a marketing
page, invite preview, or any unauthenticated URL whose content matters to a
search engine, the SSR rejection is revisited for those routes — behind the
same proxy, with the transcript still client-only.

**A second client platform's test harness.** If a native client forces shared
component-conformance tests, the happy-dom choice is re-examined against
whatever runs those. Until then it is the smallest thing that renders.
