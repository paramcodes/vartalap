# vartalap (वार्तालाप)

A resilient, durable real-time messenger built with a proven database-backed spine and an optimistic client interface.

![vartalap live demonstration](media/demo.gif)

> **Live Video:** Watch the full HD demonstration walkthrough: [media/demo.mp4](media/demo.mp4).

---

## Architecture & System Design

vartalap decouples message persistence from network fan-out. Every message is guaranteed strict monotonic ordering via database-level serialization locks, committed locally before network transit, and broadcast via an asynchronous transactional outbox relay.

![System Design Architecture](media/system-design.png)

### System Component Architecture

```mermaid
graph TB
    subgraph ClientTier["1. Client Tier (Offline-First SPA)"]
        UI["React 19 Messenger Shell<br/>• 4-Column Layout & Burst States<br/>• Light / Dark Adaptive Tokens"]
        Store["Dexie.js IndexedDB Store<br/>• Optimistic Local Rows (seq: null)<br/>• liveQuery() Subscription"]
        Queue["Send Queue & Retry Ladder<br/>• UUIDv7 Idempotency Keys<br/>• Exponential Backoff & Jitter"]
        SW["Service Worker (sw.js)<br/>• Web Push Notification Receiver"]
        UI <--> Store
        Queue --> Store
    end

    subgraph GatewayTier["2. Edge & Security Gateway"]
        Proxy["Edge Reverse Proxy<br/>• Security Headers (HSTS, nosniff, COOP)<br/>• Same-Origin Routing (/api/*)"]
        RateLimit["Token-Bucket Rate Limiter<br/>• Auth: 10/min (Closed)<br/>• Send: 30/min · Search: 60/min"]
        Auth["Better Auth Identity<br/>• HttpOnly Session Cookies<br/>• Immutable Handle Reservations"]
        Proxy --> RateLimit
        RateLimit --> Auth
    end

    subgraph ServiceTier["3. Application & Realtime Services"]
        SendHandler["Message Send Handler<br/>• pg_advisory_xact_lock<br/>• Global Monotonic seq<br/>• Atomic Outbox Frame Emission"]
        Watermarks["Watermark Engine<br/>• Monotonic GREATEST() Upsert<br/>• Shared-Through Privacy Freeze<br/>• On-the-Fly 'Seen' Derivation"]
        CatchUp["Catch-Up & Keyset Paging<br/>• Keyset Queries (Zero OFFSET)<br/>• COUNT(*) Net Reconciliation"]
        Presence["Presence & Typing<br/>• Connection Liveness (45s TTL)<br/>• Ephemeral Typing Indicators"]
        MediaSearch["Media & Search Services<br/>• Server-Side Magic-Byte Sniffer<br/>• GIN tsvector Full-Text Search"]
    end

    subgraph WorkerTier["4. Asynchronous Relays & Workers"]
        OutboxRelay["Transactional Outbox Relay<br/>• FOR UPDATE SKIP LOCKED<br/>• Monotonic Frame Fan-out"]
        PushWorker["Web Push Dispatcher<br/>• Presence & Watermark Suppression<br/>• Non-leaking Safe Payloads"]
        PurgeWorker["Outbox Purge Worker<br/>• Immediate Published Purge<br/>• 24h Failed Retain Window"]
    end

    subgraph StorageTier["5. Storage & Distributed State"]
        Postgres[("PostgreSQL (Neon / PGlite)<br/>• user & handle_reservation<br/>• conversation & member<br/>• message (global seq)<br/>• outbox & receipts")]
        Redis[("Redis Cluster / In-Memory<br/>• Presence (45s TTL)<br/>• Rate Limit Token Buckets<br/>• Cluster Pub/Sub")]
        R2[("Cloudflare R2 Object Storage<br/>• Encrypted Media Variants<br/>• Raw Uploads Never Served")]
    end

    Queue -->|HTTP POST /messages| Proxy
    Store -->|HTTP GET /catch-up| Proxy
    UI -->|HTTP POST /receipt/advance| Proxy
    RateLimit -.-> Redis
    Auth --> SendHandler
    Auth --> Watermarks
    Auth --> CatchUp
    Auth --> Presence
    Auth --> MediaSearch

    SendHandler --> Postgres
    Watermarks --> Postgres
    CatchUp --> Postgres
    Presence -.-> Redis
    MediaSearch --> Postgres
    MediaSearch --> R2

    Postgres --> OutboxRelay
    OutboxRelay --> Postgres
    OutboxRelay --> PushWorker
    PurgeWorker --> Postgres

    OutboxRelay -.->|WebSocket Frames| Store
    PushWorker -.->|Web Push| SW
```

### End-to-End Transaction & Relay Flow

```mermaid
sequenceDiagram
    autonumber
    actor Alice as Alice (Sender)
    participant UI as React 19 / Dexie
    participant API as Realtime Gateway
    participant DB as PostgreSQL
    participant Redis as Redis Liveness
    participant Relay as Outbox Relay
    actor Bob as Bob (Receiver)

    Note over Alice,UI: 1. Optimistic Local Write
    Alice->>UI: Types message & presses Enter
    UI->>UI: Enqueue with UUIDv7 (seq: null) in IndexedDB
    UI->>Alice: Instantly render in transcript (queued)

    Note over UI,DB: 2. Durable Spine Serialization
    UI->>API: POST /api/conversations/:id/messages (with session cookie)
    API->>API: Verify session & check Redis rate limits
    API->>DB: BEGIN TX: pg_advisory_xact_lock(conversation_id)
    DB-->>DB: Assign next global seq, INSERT message, INSERT outbox frame
    API->>DB: COMMIT TX
    API-->>UI: 200 OK { seq, createdAt, deduplicated: false }
    UI->>UI: Update row with assigned seq (state: committed)

    Note over DB,Bob: 3. Outbox Relay & Fan-out
    loop Polling Loop (ADR 0057)
        Relay->>DB: SELECT ... FOR UPDATE SKIP LOCKED
        DB-->>Relay: Claim batch of published frames
        Relay->>Bob: Deliver message.created frame over WebSocket
        Relay->>DB: Mark outbox row as published_at = now()
    end

    Note over Bob,UI: 4. Reading & Watermark Invariant
    Bob->>API: POST /receipt/advance { readThrough, sharedThrough }
    API->>DB: Monotonic update using GREATEST()
    DB-->>API: Persisted watermarks
    API-->>UI: Broadcast delivery/receipt watermarks
    UI->>Alice: Derive and render "Seen" under last outgoing bubble
```

---

## Core Capabilities & Features

### 🚀 Durable Message Pipeline
- **Strict Monotonic Ordering:** Inside every conversation, commit order equals sequence order (`seq`). Race conditions and clock drift cannot invert message delivery thanks to transaction-scoped advisory locks (`pg_advisory_xact_lock`).
- **Persist-Before-Acknowledge:** Every message mints a client-side UUIDv7 idempotency key. Messages are written to local Dexie IndexedDB storage first (`position: null`) and sent with automatic jittered exponential backoff on retry.
- **Single Deterministic Receive Path:** Incoming WebSocket frames, catch-up pagination queries, and local own-message echoes pass through the exact same ingest handler, preventing duplicates or out-of-order race conditions.

### 👁️ Presence, Liveness & Receipts
- **Derived "Seen" Indicator:** "Seen" state is computed per render rather than stored as a mutable database column. It appears if and only if all active peers have acknowledged receipt past the message's sequence number.
- **Privacy-Preserving Freeze:** Disabling read receipts freezes `shared_through` while allowing `read_through` to advance privately, preventing reading history leaks.
- **Connection Liveness on Redis:** User presence is backed by a 45-second Redis connection TTL refreshed on socket heartbeat—never relying on fragile client polling timers.

### 🛡️ Enterprise Hardening (Gate 1)
- **Security Headers:** Enforces strict security baselines across all HTTP responses: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, and `Cross-Origin-Opener-Policy: same-origin`.
- **Redis Token-Bucket Rate Limiter:** Protects against abuse with granular limits: Auth endpoints (10/min, fails closed), Send endpoints (30/min, fails open), Search queries (60/min), and Upload presigning (20/hr).
- **GDPR Compliance (Erasure & Export):** `DELETE /api/me` anonymizes user accounts into permanent tombstones (`tombstone-<id>@deleted.invalid`), reserving handles forever while preserving conversation transcript integrity. `GET /api/me/export` provides full on-demand JSON export of profile and authored content.

### 🖼️ Media & Full-Text Search
- **Magic-Byte Sniffing Pipeline:** Uploaded media undergoes server-side magic number byte sniffing (PNG, JPEG, GIF, WebP). Raw uploads are stored encrypted in Cloudflare R2 and never served directly to clients.
- **Server-Side Full-Text Search:** High-performance message search powered by PostgreSQL `'simple'` dictionary `tsvector` generated columns, GIN indexes, and 3-character trigram guards.

### 🎨 Fluid Responsive UI
- **Design Tokens & Theme Switcher:** Fully responsive 4-column layout (Rail, Conversation List, Transcript, and Details Pane) styled with Tailwind CSS v4 tokens, supporting System, Light, and Dark mode palettes.
- **Bubble Bursts:** Smart message burst algorithm fuses bubble corners (4px radius) for consecutive messages from the same sender within 20-minute windows.
- **Collapsible Panes:** Distraction-free focus mode with collapsible sidebars and full mobile viewport responsiveness (<760px auto-switching).

---

## Visual Tour

| 01. Authentication | 02. Welcome & Direct Messaging |
|:---:|:---:|
| ![Auth Screen](media/screenshots/01-auth-screen.png) | ![Welcome Screen](media/screenshots/02-welcome-screen.png) |
| *Sign In & Sign Up with immutable handle reservations* | *Navigation rail & direct chat initialization* |

| 03. Active Conversation | 04. Chat Transcript & Bubble Bursts |
|:---:|:---:|
| ![Chat Opened](media/screenshots/03-chat-opened.png) | ![Chat Transcript](media/screenshots/04-chat-transcript.png) |
| *Presence indicators, conversation header, and composer* | *Monotonic sequencing, fused bubble corners, timestamps* |

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

## Performance & Operational Characteristics

| Metric | Measured Value | Implementation Guarantee |
|:---|:---:|:---|
| **Local Message Enqueue** | `< 1ms` | Synchronous write to client Dexie IndexedDB before network dispatch |
| **Commit Ordering Overhead** | `~0.3ms` | Lightweight `pg_advisory_xact_lock` hash serialization |
| **Presence Heartbeat Check** | `< 2ms` | Redis single-key `MGET` / `SETEX` with 45s TTL |
| **Outbox Relay Concurrency** | Non-blocking | Multi-worker parallel processing via `FOR UPDATE SKIP LOCKED` |
| **Watermark Updates** | `O(1)` | Monotonic database upsert via `GREATEST(stored, reported)` |
| **Test Suite Verification** | **429 Passed** | 44 test files covering protocol, auth, database, realtime, and UI |

---

## Monorepo Structure

```
vartalap/
├── apps/
│   ├── web/               # React 19 SPA, Tailwind CSS v4, Dexie IndexedDB data layer
│   └── realtime/          # Bun HTTP router, WebSocket fan-out, spine endpoints, outbox relay
├── packages/
│   ├── database/          # Drizzle ORM schema, migrations, connection pool, test harness
│   ├── protocol/          # Shared Zod schemas, wire frames, error envelopes, scalar types
│   └── auth/              # Self-hosted Better Auth with PostgreSQL adapter & handle triggers
├── docs/
│   ├── adr/               # Architecture Decision Records (ADRs 0001–0065)
│   └── concepts/          # Deep-dive concept documents (durability, ordering, receipts)
├── media/                 # Screenshots, live GIF demonstration, and architecture diagrams
└── scripts/
    ├── db-local.ts        # Zero-docker PGlite Postgres server with pg_trgm & pgcrypto
    └── e2e-drive.ts       # Headless Chromium end-to-end automation driver
```

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) (>= 1.4.0)
- [Redis](https://redis.io/) (running locally on port `6379`)
- [Chromium](https://www.chromium.org/) & [FFmpeg](https://ffmpeg.org/) *(optional, for running e2e test recording)*

### Quickstart

1. **Clone and install dependencies:**
   ```bash
   git clone https://github.com/paramcodes/vartalap.git
   cd vartalap
   bun install
   ```

2. **Initialize local database & run migrations:**
   ```bash
   bun run db:setup
   ```

3. **Start the development services:**
   ```bash
   # Terminal 1: Local Postgres (PGlite on port 5433)
   bun run db:local

   # Terminal 2: Realtime API service (port 3000)
   bun run realtime

   # Terminal 3: Web frontend (Vite dev on port 5173)
   bun run dev
   ```

4. Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## Development & Testing

### Running the Test Suite

Run all 429 unit and integration tests across every monorepo package:

```bash
bun test
```

### Static Typechecking

Verify TypeScript across all applications and packages:

```bash
bun run typecheck
```

### Automated E2E Verification & Screen Recording

Launch the full headless browser orchestration driver to simulate real user interactions, verify features, and record output:

```bash
bun run e2e:drive
```

---

## Contributing

1. Check open issues and consult [`docs/adr/`](docs/adr/) before proposing structural changes.
2. Ensure every new feature comes with automated tests.
3. Verify that `bun test` and `bun run typecheck` pass before submitting pull requests.
4. Follow Conventional Commits (`feat:`, `fix:`, `docs:`, etc.) with subject lines under 72 characters.

---

## License

[MIT](LICENSE)
