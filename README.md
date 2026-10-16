# vartalap (वार्तालाप)

A resilient, durable real-time messenger built with a proven database-backed spine and an optimistic client interface.

![vartalap live demonstration](media/demo.gif)

> **Live Recording:** Watch the full HD video recording: [media/demo.mp4](media/demo.mp4).

---

## Highlights

- **The Durable Spine:** Strict monotonic message sequencing (`seq`) serialised by `pg_advisory_xact_lock` within conversations. Zero inverted ordering under load.
- **Optimistic Send Pipeline:** Local Dexie IndexedDB commit (`position: null`) with UUIDv7 idempotency keys before any network call.
- **One Receive Path:** Live WebSocket frames, historical catch-up pages, and own-message echoes converge through a single deterministic write path.
- **Derived Watermarks & Presence:** Monotonic delivery and receipt watermarks (`read_through` and `shared_through`); "Seen" is derived per render and never persisted. Liveness backed by Redis connection TTLs.
- **Full Stage 1–8 Implementation:** Identity, Conversations, Permissions, Thin UI, Media Pipeline, Outbox Web Push, Trigram Message Search, and Gate 1 Hardening (security headers, token-bucket rate limiting, GDPR erasure, and on-demand JSON export).

---

## Visual Tour & Screenshots

| 01. Authentication | 02. Welcome & Direct Messaging |
|:---:|:---:|
| ![Auth Screen](media/screenshots/01-auth-screen.png) | ![Welcome Screen](media/screenshots/02-welcome-screen.png) |
| *Sign In / Sign Up with immutable handle reservations* | *Collapsible navigation rail & direct chat initialization* |

| 03. Active Conversation | 04. Chat Transcript & Bubble Bursts |
|:---:|:---:|
| ![Chat Opened](media/screenshots/03-chat-opened.png) | ![Chat Transcript](media/screenshots/04-chat-transcript.png) |
| *Header avatar with presence indicator & input composer* | *Monotonic sequencing, fused bubble corners, timestamps* |

| 05. Conversation Details Pane | 06. Account & System Settings |
|:---:|:---:|
| ![Details Pane](media/screenshots/05-details-pane.png) | ![Settings View](media/screenshots/06-settings-light.png) |
| *Participant roster, mute states, and watermark disclosures* | *Profile handles, device themes, and privacy toggles* |

| 07. Dark Mode Settings | 08. Dark Mode Transcript |
|:---:|:---:|
| ![Settings Dark](media/screenshots/07-settings-dark.png) | ![Dark Mode Chat](media/screenshots/08-chat-dark-mode.png) |
| *High-contrast accessibility tokens in dark palette* | *Immersive dark messenger transcript view* |

| 09. Focused / Collapsed View |
|:---:|
| ![Focused View](media/screenshots/09-focused-chat.png) |
| *Focus mode with collapsed conversation list and rail* |

---

## Architecture & Completed Stages

All stages 1 through 8 are implemented, hardened, and verified with **429 passing tests**:

```
Stage 1 (Groundwork) ──▶ Stage 2 (Identity) ──▶ Stage 3 (Durable Spine) ──▶ Stage 4 (Reading & Liveness)
         │
         ▼
Stage 5 (Conversations) ──▶ Stage 6 (Thin UI) ──▶ Stage 7 (Media/Push/Search) ──▶ Stage 8 (Gate 1 Hardening)
```

### Stage Summary

| Stage | Scope | Key Guarantees & Features | Status |
|:---|:---|:---|:---:|
| **1 — Groundwork** | Monorepo structure, Neon/PGlite Postgres schema, Drizzle ORM, Zod protocol schemas. | Base schema (`user`, `conversation`, `member`, `message`, `outbox`, `receipt`, `delivery`, `media`, `push_subscription`). | **Complete** |
| **2 — Identity** | Self-hosted Better Auth, handle reservations. | Immutable lowercase handles `^[a-z0-9_]{3,20}$`, session cookies without caching. | **Complete** |
| **3 — The Durable Spine** | Message ordering, optimistic client persistence, single receive write path. | Global `seq` with `pg_advisory_xact_lock`, Dexie IndexedDB client queue, outbox relay with `FOR UPDATE SKIP LOCKED`. | **Complete** |
| **4 — Reading & Liveness** | Monotonic watermarks, presence, and typing indications. | Derived "Seen" indicator, Redis TTL connection liveness (45s), 2s throttled ephemeral typing frames. | **Complete** |
| **5 — Conversations** | Direct pairs, group conversations, blocking, and leaving/rejoining. | `direct_key` uniqueness, unified `canSend` predicate, receipt retention upon rejoin. | **Complete** |
| **6 — Thin Interface** | React 19 SPA, Tailwind CSS v4 design tokens, transcript, composer. | Burst grouping state machine, keyboard shortcuts (Enter / Shift+Enter / IME guards), client theme storage. | **Complete** |
| **7 — Media, Push, Search** | R2 presigned uploads, Web Push outbox relay, full-text search. | Server-side byte sniffing (no raw serving), watermark-suppressed push payloads, `'simple'` dictionary tsvector search. | **Complete** |
| **8 — Hardening (Gate 1)** | Security headers, rate limiting, erasure, export, health checks. | Strict-Transport-Security, Permissions-Policy, COOP/CORP, Redis token bucket (send 30/m, auth 10/m), tombstoning `DELETE /api/me`, `GET /api/me/export`, `/health`. | **Complete** |

---

## Core Technical Guarantees

- **No Inverted Messages:** Commit order equals sequence order (`seq`) inside any conversation via `pg_advisory_xact_lock(hashtext('vartalap:conversation:' || conversation_id::uuid::text))`.
- **Persist-Before-Acknowledge:** Every outgoing message is assigned a UUIDv7, written to the local client store with `position: null`, and acknowledged only after durable storage. Retries reuse the same idempotency key.
- **Monotonic Watermarks:** Advances use SQL `GREATEST()`; a device clock moving backwards or out-of-order network arrival cannot regress delivery or receipt positions.
- **Privacy Freeze:** Disabling read receipt sharing freezes `shared_through` in place while `read_through` continues to advance forward, preventing private reading history leaks.

---

## Quickstart

### Prerequisites

- [Bun](https://bun.sh/) (>= 1.4.0)
- [Redis](https://redis.io/) (running on `localhost:6379`)
- [Chromium](https://www.chromium.org/) and [FFmpeg](https://ffmpeg.org/) (for end-to-end driving and media capture)

### Setup & Migrations

```bash
# Install workspace dependencies
bun install

# Boot PGlite and run all migrations
bun run db:setup
```

### Run the Application

```bash
# Terminal 1: Start local database
bun run db:local

# Terminal 2: Start realtime service (port 3000)
bun run realtime

# Terminal 3: Start web app (port 5173)
bun run dev
```

Visit [http://localhost:5173](http://localhost:5173) in your browser.

---

## Automated Verification & Test Suite

Run the full test suite across all packages and apps:

```bash
bun test
```

Typecheck the entire workspace:

```bash
bun run typecheck
```

Run the end-to-end driver that drives the application, exercises user journeys, and captures media:

```bash
bun run e2e:drive
```

---

## License

MIT
