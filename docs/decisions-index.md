# Decision index

Every load-bearing decision vartalap has made, in one place, with a pointer to the file that holds
the detail. Read this before re-litigating anything — most of it was expensive to establish.

A decision lives in **exactly one place** — its ADR or concept document. This file points; it does not
restate. Where it adds a line, it adds the *consequence* or the *trap*, not a summary that could
drift.

## Shape

| | |
|---|---|
| **Datastore** | Neon Postgres (serverless). Drizzle + Postgres.js driver |
| **Realtime** | self-hosted Centrifugo over Redis, fed by a Postgres transactional outbox |
| **Auth** | self-hosted Better Auth on Neon, `username()` plugin verified end to end |
| **Monorepo** | Bun workspaces; Node for `apps/web`, Bun for `apps/realtime` |
| **Client cache** | Dexie owns message state. TanStack Query for server-authoritative reads only |
| **Design system** | shadcn/ui on Base UI, hand-written Messenger token theme, Inter, classic blue `#0084FF` |
| **Build order** | Spine before surface — see [roadmap](concepts/roadmap.md) |
| **Hardening** | 27 items, two gates; Gate 1 ≈ 10–11 days, four of them one restore rehearsal |
| **Storage** | Cloudflare R2 — chosen for free **egress**, not price |
| **Deployment** | Single operator. Origin public (PWA + Web Push force HTTPS + a public hostname); **door invite-only** — proposed, not decided ([H-19](concepts/hardening-backlog.md)) |

## Documents

| ADR | Decision |
|---|---|
| [0001-self-hosted-better-auth](adr/0001-self-hosted-better-auth.md) | Self-hosted Better Auth, not Neon Managed Better Auth |
| [0002-messenger-token-layer](adr/0002-messenger-token-layer.md) | A `messenger` token block on plain `@theme`, with the radius anchored at 12.857px |
| [0003-receipt-watermark](adr/0003-receipt-watermark.md) | Receipts are a bookmark, not a diary — a per-member watermark, not a log |
| [0004-message-durability](adr/0004-message-durability.md) | Persist before acknowledge: the durable spine of the message lifecycle |
| [0005-message-ordering](adr/0005-message-ordering.md) | A global `seq` orders messages, and per-conversation serialisation makes the commit-inversion r |
| [0006-presence](adr/0006-presence.md) | Presence lives in a Redis TTL, not in Centrifugo's built-in presence |
| [0007-conversation-model](adr/0007-conversation-model.md) | One `conversations` table, and a NULL that does the uniqueness work |
| [0008-media-pipeline](adr/0008-media-pipeline.md) | Never serve the raw upload — sniff, allowlist, and serve only derived variants |
| [0009-message-search](adr/0009-message-search.md) | Message search is Postgres full-text, behind one exported function |
| [0010-receipt-mechanics](adr/0010-receipt-mechanics.md) | A receipt has two positions: the one you own, and the one everyone else sees |
| [0011-push-notifications](adr/0011-push-notifications.md) | Push is our own sender, triggered by the outbox — never the transport's job |
| [0016-identity-is-one-table](adr/0016-identity-is-one-table.md) | Identity is one table, a handle is claimed once, and a handle signs you in |
| [0017-handle-alphabet](adr/0017-handle-alphabet.md) | The handle alphabet is `[a-z0-9_]`, and the uniqueness index pins its collation |
| [0018-socket-is-a-lease](adr/0018-socket-is-a-lease.md) | A socket is a sixty-second lease, and revocation is a row delete plus a disconnect |
| [0021-profile-surface](adr/0021-profile-surface.md) | The profile renders what cannot be edited, and says so |
| [0022-settings-boundary-and-transports](adr/0022-settings-boundary-and-transports.md) | Three homes for a setting, two transports for a change, and three switches that must not exist |
| [0023-handle-claim-and-reservation-SUPERSEDED](adr/0023-handle-claim-and-reservation-SUPERSEDED.md) | A handle is claimed through us, and every handle a user has held stays theirs |
| [0024-settings-boundary-and-transports-RENUMBERED](adr/0024-settings-boundary-and-transports-RENUMBERED.md) | Three homes for a setting, two transports for a change, three switches that must not exist |
| [0040-security-headers](adr/0040-security-headers.md) | The application emits its own security headers, and the CSP is the only one that matters |
| [0041-erasure-is-a-tombstone](adr/0041-erasure-is-a-tombstone.md) | Erasure anonymises the user row to a tombstone and cascades nothing |
| [0042-backups](adr/0042-backups.md) | The backup is ours — a nightly `pg_dump` into R2 — and it does not exist until a restore has be |
| [0043-rate-limits](adr/0043-rate-limits.md) | Rate limits are a Redis token bucket keyed on identity, with the numbers written down |
| [0044-cost-ceilings](adr/0044-cost-ceilings.md) | There is no dollar cap anywhere on this stack; the ceilings are five integers and two lifecycle |
| [0045-conversation-list-orders-by-a-position](adr/0045-conversation-list-orders-by-a-position.md) | The conversation list orders by a position, and `0` is not a position |
| [0046-mute-is-a-marker-not-a-filter](adr/0046-mute-is-a-marker-not-a-filter.md) | A muted conversation stays in the list, with its unread count intact |
| [0047-transcript-follows-the-bottom-only-when-at-it](adr/0047-transcript-follows-the-bottom-only-when-at-it.md) | The transcript follows the bottom only for a member already at it |
| [0048-scroll-anchoring-belongs-to-the-browser](adr/0048-scroll-anchoring-belongs-to-the-browser.md) | Scroll anchoring belongs to the browser, which is why v1 does not virtualize |
| [0049-drafts-are-device-local](adr/0049-drafts-are-device-local.md) | A draft belongs to the browser that received it |
| [0050-the-composer-is-chosen-here](adr/0050-the-composer-is-chosen-here.md) | The composer's shape and copy are chosen here, not inherited |
| [0051-enter-to-send-needs-three-guards](adr/0051-enter-to-send-needs-three-guards.md) | Enter-to-send needs three guards, and `isComposing` is the weakest of them |
| [0052-media-is-staged-before-the-message-exists](adr/0052-media-is-staged-before-the-message-exists.md) | A media message is staged before it exists, and send never waits |
| [0053-nothing-is-retracted](adr/0053-nothing-is-retracted.md) | Nothing is retracted: a queued send can be waited for or discarded, never changed |
| [0054-build-the-spine-first](adr/0054-build-the-spine-first.md) | Build the durable spine before any surface |

| Concept | Teaches |
|---|---|
| [auth-and-identity](concepts/auth-and-identity.md) | Auth, onboarding and identity |
| [composer-and-sending](concepts/composer-and-sending.md) | The composer, and what sending actually does |
| [conversation-list-and-chat-view](concepts/conversation-list-and-chat-view.md) | The conversation list and the chat view |
| [conversation-model](concepts/conversation-model.md) | The conversation model |
| [hardening-backlog](concepts/hardening-backlog.md) | The hardening backlog |
| [media-pipeline](concepts/media-pipeline.md) | The media pipeline |
| [message-lifecycle](concepts/message-lifecycle.md) | The message lifecycle |
| [message-ordering](concepts/message-ordering.md) | Message ordering and pagination |
| [message-receipts](concepts/message-receipts.md) | Reading, delivered, and receipts |
| [message-search](concepts/message-search.md) | Message search |
| [presence-and-typing](concepts/presence-and-typing.md) | Presence and typing |
| [profile-and-settings](concepts/profile-and-settings.md) | Profile and settings |
| [push-notifications](concepts/push-notifications.md) | Push notifications |
| [roadmap](concepts/roadmap.md) | The roadmap |

## Traps that will bite whoever builds this

These are the expensive ones. Each cost a wrong first implementation.

1. **A theme token with no caller does not exist.** Tailwind v4 tree-shakes unreferenced theme
   variables; `rounded-xl` resolved to `0px` while the code hardcoded `"18px"`. Tokens earn their
   place by being rendered.
2. **`@theme inline` freezes every token at build time** and leaves `.dark` nothing to override.
3. **An advisory lock is one line carrying a whole guarantee** — `pg_advisory_xact_lock` in ADR 0005.
   The `COUNT(*)` reconciliation underneath it is the independent net. Do not "simplify" the lock away.
4. **Span-versus-count anomaly detection is unsound.** Rollback burns sequence values, so 100/101/102/**105**
   is normal. Reconcile against `COUNT(*)` instead.
5. **`text-align` does nothing on a flex container holding only a text node** — the anonymous flex item
   shrink-wraps, so there is no space to distribute.
6. **EXIF orientation is stripped by `sharp` by default.** Portrait photos render sideways with no error.
   `.autoOrient()` first; never call `keepMetadata()` (it preserves GPS).
7. **`nosniff` is not an XSS defence.** It prevents the browser *correcting* a type. The defence is
   never serving the raw upload.
8. **`ON DELETE NO ACTION` does not delete referencing rows.** It errors, like `RESTRICT`; they differ
   only in deferrability.
9. **Neon Free has no scheduled backups** — 6h PITR only. And **no dollar spend cap**, only per-project
   resource quotas that hard-stop.
10. **Run indices index the divider-filtered list.** Run-position lookups must use full-transcript indices.

## Vocabulary rules

`GLOSSARY.md` is binding. The words that get misused:

- **Message** is authored content and nothing else. Transcript and Receipt are separate nouns. "Event" is banned.
- **Read** means shown. A Receipt is a member's record, never a property of a message.
- **Seen** is interface copy only — Messenger's word, not ours. It appears in no schema, no protocol, no model.
- **Conversation**, not chat/thread/DM/room. **Member**, not participant/owner/admin. **Handle**, not username.
- **Outbox** is the server's; **send queue** is the browser's. Never the reverse.
- **Queued send**, not "pending message".

## Unverified, and still unverified

Do not let these harden into fact without a check.

- **Presence green `#31A73B`** — Meta's canonical green, but no `--presence-*` token has been observed
  in any capture. Inferred. Worth a visual check against messenger.com.
- **The composer** — copy and shape were never sourced; the token-layer ticket marked them unsourced.
- **Messenger's group "Seen"** — recorded as *all members* on the operator's account. No primary source exists.
- **"Orders of magnitude" traffic claims for typing and receipts** — retracted. No primary source publishes any ratio.
- **Short-prefix FTS degradation** — real mechanic, zero documentation. Engineering judgment, not cited.