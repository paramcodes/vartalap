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
| **Desktop layout** | Four columns — rail · list · transcript · details — [ADR 0055](adr/0055-desktop-layout-is-four-columns.md). Every number in it is ours |
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
| [0007-conversation-model](adr/0007-conversation-model.md) | One `conversation` table, and a NULL that does the uniqueness work |
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
| [0055-desktop-layout-is-four-columns](adr/0055-desktop-layout-is-four-columns.md) | Desktop is four columns, and collapsing a pane is a decision rather than a media query |
| [0056-conversation-serialisation-lock](adr/0056-conversation-serialisation-lock.md) | The send lock is `hashtextextended($1::uuid::text, 8530225013392695664)` in SQL — the `::uuid::text` cast is what stops a client sending `A1B2…` and taking a different lock from the same conversation |
| [0057-the-outbox-relay-is-a-poller](adr/0057-the-outbox-relay-is-a-poller.md) | The relay polls in batches of 100 with `SKIP LOCKED`, and its guarantee is **at-least-once on purpose** — correctness rests on the client upserting on the client id, so duplicates are free and a dropped frame is not |
| [0058-receipt-sharing-is-a-transport-signal](adr/0058-receipt-sharing-is-a-transport-signal.md) | `shared_through` is the mechanism and `sharing` is a signal about a permission; reading the boolean as the mechanism is how a privacy control becomes a disclosure button |
| [0059-the-send-endpoint](adr/0059-the-send-endpoint.md) | `POST /api/conversations/{id}/messages`, four fields decide "the same content", and the error envelope carries `retryable` |
| [0060-stored-state-is-narrow-and-derived-state-is-wide](adr/0060-stored-state-is-narrow-and-derived-state-is-wide.md) | A client row stores three states and derives five; `sent` is `seq !== null` and `delivered`/`read` are per-member watermarks, so no message row ever grows a read flag |

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

| Plan | Holds |
|---|---|
| [stage-3](plans/stage-3.md) | The durable spine — four gates (G1 ordering, G2 monotonic watermarks, G3 one receive path, G4 `COUNT(*)` reconciliation) and the units that prove them. **G1b needs real concurrency and has never run**; a plan that calls the ordering guarantee proven before it does is wrong |

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
11. **Three shadcn `SidebarProvider`s means three `Cmd+B` handlers and three mobile Sheets.** Only the conversation list is a Sidebar; the rail and the details pane are flex columns. See [ADR 0055](adr/0055-desktop-layout-is-four-columns.md).
12. **`bun run check:tokens` exists because the Tailwind browser build cannot `@import` an `@theme`.** The token block must be inlined in each prototype, so it is duplicated five times and the script is the only thing keeping the copies identical. A prototype that quietly disagrees about a token renders wrong with no error anywhere.
13. **The tables are singular.** `message`, `conversation`, `member`, `receipt`, `delivery` — never `messages` or `conversations`. Prose written before the migration landed says `messages.seq` and `INSERT INTO conversations`, and that SQL does not run. The migration is canonical.
14. **`Seen` is over `shared_through`, never over `read_through`.** ADR 0003 originally computed it over `receipt[m].read_through`; [0010](adr/0010-receipt-mechanics.md) replaced one position with two and moved it, and 0003 has been corrected in place. Building it off `read_through` broadcasts the gap a member spent hiding — the exact failure 0010 exists to prevent.
15. **A watermark invariant has to name two columns in the same row.** ADR 0004 wrote `read_through >= delivered_through`, which compares a `receipt` column against a `delivery` column and enforces nothing — silently, because both columns exist and both are monotonic. The invariant is `read_through >= shared_through`, and 0004 now says so. The trap is the *shape* of the mistake, not the typo.
16. **`message` has two timestamps and the send path must supply both.** `client_created_at` is `NOT NULL` with no default and comes from the client (display only, never a sort key); `created_at` is `DEFAULT now()`, which is `transaction_timestamp()`. An insert supplying only `created_at` violates the `NOT NULL` and fails the transaction that also writes the outbox row.
17. **Better Auth's rate limiter buckets by client IP, and a test server has none.** `bun test` binds loopback, so `auth`'s limiter falls back to a shared bucket and allows **exactly three sign-ups per run** before answering `429` for the rest of it. Measured, not configured. A test file that signs up per test dies partway through on a limit that has nothing to do with what it is testing — sign up once, then isolate per test some other way.
18. **Advisory-lock keys are case-sensitive and that is the whole hazard.** ADR [0056](adr/0056-conversation-serialisation-lock.md) derives the key in SQL from `conversation_id::text`. Hashing the raw request string instead yields **four different keys for one conversation** depending only on letter case, and two concurrent sends then take different locks and ADR 0005's race is back with no error anywhere. The `::uuid::text` cast is a correctness property, not a cast.

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
- **Every layout number in ADR 0055** — rail 64, list 320, details 300, transcript cap 760, breakpoints 760 and 1150. None was recovered from a source; Facebook serves messenger.com through Comet behind a login and every archived capture is the logged-out shell. They are defaults to be judged by eye.
- **Whether messenger.com currently has a details pane** — contradicted twice in one session. Meta's screen-reader landmark spec says three regions and no right pane; the operator's screenshot of the old desktop app shows four. Both are real evidence of different things, and neither describes what ships today.
- **The terminal / retryable split by status code** — `400`/`413`/`422` terminal and `401`/`408`/`425`/`429` retryable is reasoning, not observation. The server's actual status codes do not exist yet. [composer-and-sending](concepts/composer-and-sending.md) records that if they come out differently its table changes, and [message-lifecycle](concepts/message-lifecycle.md#when-a-send-fails) changes with it.