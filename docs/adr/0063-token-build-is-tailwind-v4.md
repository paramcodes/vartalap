# 0063. The token build is Tailwind v4 under Vite

**Status:** Accepted
**Date:** 2026-10-15
**Resolves:** stage-6 unit 6.1 dependency justification (stage rule: new dependencies need an ADR)
**Depends on:** [0002](0002-messenger-token-layer.md), [0062](0062-static-react-spa-and-test-dom.md)

## Context

Unit 6.1 spends ADR 0002's token block through real utilities (`bg-wash`,
`rounded-xl`). Tokens only exist if the build emits them — trap 1 — so the
block needs the compiler it was verified against, integrated with the
framework 0062 chose.

## Decision

`tailwindcss` (v4) and `@tailwindcss/vite` (the framework-native integration,
not the browser build and not a PostCSS chain). The browser build is what the
throwaway prototypes use; the app uses the compiled build, which is what
tree-shakes unreferenced tokens and what makes trap 1 observable.

No webfont dependency: the stack names Inter and falls back (as the
prototypes do). A webfont is bytes on every load for a face the system may
already have; it can arrive when the eye judges it missing, not before.

## What would reverse this

A Tailwind release that changes the `@theme` contract (e.g. a first-class
runtime theme making `@theme inline` safe — the reversal 0002 already names).
