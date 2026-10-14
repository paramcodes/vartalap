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
| **Storage** | Cloudflare R2 — chosen for free **egress**, not price |
| **Deployment** | Single operator, reachable on the internet (PWA + Web Push force HTTPS and a public origin) |

## Documents

| ADR | Decision |
|---|---|
| [0001](adr/0001-self-hosted-better-auth.md) | Self-hosted Better Auth, not Neon Managed — `username()` 404s on Managed |
| [0002](adr/0002-messenger-token-layer.md) | Token layer on plain `@theme`, `--radius: 12.857px` |
| [0003](adr/0003-receipt-watermark.md) | Receipts are a bookmark, not a diary — a per-member watermark |
| [0004](adr/0004-message-durability.md) | Persist before acknowledge; the durable spine |
| [0005](adr/0005-message-ordering.md) | Global `seq`; per-conversation serialisation kills the inversion race |
| [0006](adr/0006-presence.md) | Presence is a Redis TTL, not Centrifugo's built-in presence |
| [0007](adr/0007-conversation-model.md) | One `conversations` table; a NULL doing the uniqueness work |
| [0008](adr/0008-media-pipeline.md) | The raw upload is never served |
| [0009](adr/0009-message-search.md) | Postgres FTS behind one exported function |
| [0010](adr/0010-receipt-mechanics.md) | Two receipt positions, not one plus a boolean |

| Concept | Teaches |
|---|---|
| [message-lifecycle](concepts/message-lifecycle.md) | One message, keystroke to receipt |
| [message-ordering](concepts/message-ordering.md) | What orders a transcript, and the race that doesn't exist |
| [presence-and-typing](concepts/presence-and-typing.md) | Two signals that look like one |
| [conversation-model](concepts/conversation-model.md) | One table, one NULL, one predicate |
| [media-pipeline](concepts/media-pipeline.md) | Where media trust begins |
| [message-search](concepts/message-search.md) | What backs search and what it's bad at |
| [message-receipts](concepts/message-receipts.md) | Reading, delivered, and the two columns |

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