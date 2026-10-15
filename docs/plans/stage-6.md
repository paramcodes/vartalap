# Stage 6 — a thin interface

The operational plan for stage 6. Decisions live in ADRs and concepts; this file holds **sequence,
scope, and acceptance only**.

**State at the time of writing:** stages 1–5 are committed. Everything underneath exists: the
durable spine (stage 3), liveness logic (stage 4), conversations with blocks and leaving
(stage 5), and a client data layer with answers for every state the interface must render
(queued, in flight, failed, sent, delivered, read, typing, presence). Nothing renders. This
stage is the first thing a member ever sees, and it is deliberately thin: **no media, no push,
no search** — the transcript, the list, the composer, and settings, over what exists.

---

## The four gates

| Gate | Guarantee | Proved by |
|---|---|---|
| **T1** | The list orders by position (`0` is not a position), mute never filters, unread is derived and never stored. | 6.2 |
| **T2** | The transcript renders from the Dexie table and nothing else; an own-echo converges; `Seen` sits under the last outgoing message and nowhere else. | 6.3 |
| **T3** | Enter sends iff all three guards pass; drafts never leave the device; a failed send renders with retry that reuses the key. | 6.4 |
| **T4** | Every setting persists to the home 0022 names for it, travels the transport 0022 names for it, and the three forbidden switches do not exist. | 6.5 |

### Verification, decided here because it constrains 6.0

UI gates cannot be proved by the data-layer tests alone — something has to render. Two layers:

- **Component tests with a DOM** for state-to-pixels: list ordering, burst classes, Seen
  placement, composer guards, failed rendering. This needs a DOM library the repo does not
  have, which is a dependency decision 6.0 makes alongside the framework one (same ADR,
  same reasoning: the smallest thing that renders components headlessly).
- **The data layer stays the proof for behavior.** Nothing in stage 6 re-proves what stages
  3–5 proved. A component test asserts what a state renders as, never what the state means —
  the meaning is already pinned underneath.

What is NOT built: visual regression, screenshots-as-assertions, or a desktop-app shell. The
eye judges; the tests pin structure.

---

## Units

### 6.0 — Framework, shell, and the test DOM

One ADR, three choices that must be made together because each constrains the others: the UI
framework, the component-test DOM, and how `apps/web` serves (static, proxied API) versus
renders. Constraints already on the record: PWA + Web Push force HTTPS and a public hostname;
the Better Auth cookie assumes same-origin (`server.ts` says so); Dexie is client-only, which
is an argument about SSR whether or not the ADR names a framework; the decisions index says
Node for `apps/web` and names shadcn/ui on Base UI with Inter and `#0084FF`.

Out of scope for the ADR: everything visual. It decides how the interface is built and proved,
not what it looks like.

**Done when:** the ADR exists, a shell boots behind the auth gate, talks to the realtime
service, and one component test renders through the chosen DOM.

### 6.1 — The token layer

ADR 0002, exactly as written: the `messenger` token block on plain `@theme`, radius anchored
at 12.857px. Plus the trap the roadmap names: Tailwind v4 emits zero CSS for workspace
library code until `@source` globs are written by hand — budgeted here, at the start, not
discovered at the end. `bun run check:tokens` keeps the prototype copies identical; this unit
decides whether the prototypes' inlined blocks converge onto the real theme or stay
duplicated, and records the decision rather than drifting into it.

**Done when:** every token 0002 names renders from the theme (trap 1: a token with no caller
does not exist), `.dark` overrides what it must (trap 2: no `@theme inline` freeze), and the
check script covers the new arrangement.

### 6.2 — The conversation list

One `Sidebar` and nothing else is one (trap 11); rail and details pane are flex columns per
ADR 0055. Orders by position with `0` excluded (0045); mute is a marker that leaves the row
in place with its unread intact (0046); unread derived, never stored; direct titles derived
from peers, never from a stored title that does not exist; `permission` (including block
reasons) gates the row's affordances.

**Done when:** T1 passes — including the trap-shaped cases: a muted conversation with unread
still listed, a zero-position conversation sorted as positionless, a blocked pair's row
rendering the locked affordance.

### 6.3 — The transcript

Renders from the Dexie table via `liveQuery`, never component state (gate G3's rendering
rule). The burst state machine inherited: fused at 4px, `middle` and `last` identical, date
divider terminating a run, CSS logical longhands. Follows the bottom only when already at it
(0047); no virtualization, scroll anchoring belongs to the browser (0048). `Seen` under the
last outgoing message only, computed over `shared_through` (trap 14); `Sent` from delivery.

**Done when:** T2 passes — own-echo converges visibly, a position never moves a rendered row
except by snapping into place, `Seen` appears exactly once and in the right place.

### 6.4 — The composer

The shape and copy from 0050 (chosen here, not inherited); three enter-to-send guards with
`isComposing` the weakest (0051); drafts device-local, cleared in the same transaction as
the optimistic row (0049); the send flow through the data layer's queue/flush with backoff;
queued at 60% opacity with no text, in-flight full opacity with no text, failed with the
danger border and the retry strip that reuses the key.

**Done when:** T3 passes — each guard independently blocks, drafts survive reload on this
device and exist on no other, a 409 renders `Not sent` with `Try again` / `Delete`, and
retry reuses the idempotency key.

### 6.5 — Settings and profile

Three homes, two transports (0022); the profile renders what cannot be edited and says so
(0021); the sharing toggle rides the settings transport, never the receipt advance (0058,
0059); the three switches that must not exist do not exist — asserted, not assumed.

**Done when:** T4 passes — every setting round-trips through its home and transport, and a
test fails if any forbidden switch is added.

---

## Sequence

```
6.0 ──▶ 6.1 ──▶ 6.2 ──▶ 6.3 ──▶ 6.4 ──▶ 6.5 ──▶ stage 7
```

Strictly sequential: tokens before the components that spend them, list before transcript
(the transcript is reached through the list), composer after transcript (it sends into one),
settings last (it touches everything and must not reshape anything).

## Rules for every unit

- One commit per unit, and the commit lands with its tests green.
- New dependencies need an ADR saying why — 6.0's framework ADR is the first instance, not
  an exception. The bias is still deletion: shadcn/ui on Base UI is decided, and anything
  beyond it argues its case.
- A gate is proved by breaking it. Delete the ordering, drop a guard, store an unread count,
  add a forbidden switch — and watch the test fail. Report the real output.
- Stage 6 builds surface on a proven spine. If a unit discovers the spine cannot support
  what the interface needs, stop: that is a stage-3 defect wearing a stage-6 symptom, and
  it gets a stage-3 fix, not a stage-6 workaround.
