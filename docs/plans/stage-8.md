# Stage 8 — hardening, Gate 1

The operational plan for stage 8. Decisions live in ADRs and concepts; this file holds **sequence,
scope, and acceptance only**.

**State at the time of writing:** stages 1–7 are complete and committed. All primary features
(durable spine, presence, conversations, UI, search, push, media) exist and pass tests. Stage 8
implements the builder obligations for **Gate 1 ("before a second user exists")** per
[`docs/concepts/hardening-backlog.md`](../concepts/hardening-backlog.md) and ADRs 0040–0044.

---

## The five gates

| Gate | Guarantee | Proved by |
|---|---|---|
| **H1** | Security headers emitted on all HTTP responses: HSTS (no preload), nosniff, DENY XFO, no-referrer, deny-all Permissions-Policy, COOP same-origin; media responses include CORP same-site. | 8.0 |
| **H2** | Redis token-bucket rate limiter enforces the documented numbers: send 30/min, auth 10/min, search 60/min, presign 20/hr. Auth fails closed; send, search, upload fail open. | 8.1 |
| **H3** | Account erasure (`DELETE /api/me`) tombstones the user row, reserves the handle forever, deletes sessions/credentials, and cascades nothing to messages or receipts. | 8.2 |
| **H4** | On-demand export (`GET /api/me/export`) returns user profile, memberships, authored messages, and receipts in one JSON payload. | 8.3 |
| **H5** | `/health` checks Postgres and Redis, answering 200 or 503 without revealing infrastructure; outbox purge clears published rows and retains failed rows for 24 hours. | 8.4 |

---

## Units

### 8.0 — Security headers
ADR 0040: The application emits its own security headers. Applied to every response in `http.ts`:
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
`Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`,
`Cross-Origin-Opener-Policy: same-origin`, and `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

### 8.1 — Redis rate limiter
ADR 0043: Token-bucket rate limiter. Keyed on user ID for send (30/min), search (60/min), and
presign (20/hr); keyed on IP for auth (10/min). Emits `RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset`, and `Retry-After` on 429. Auth fails closed; other endpoints fail open.

### 8.2 — Account erasure & tombstoning
ADR 0041: `DELETE /api/me` anonymises the user row to a tombstone: `name` to `'Deleted user'`,
`email` to `tombstone-<id>@deleted.invalid`, username reserved, sessions and credentials deleted.
Messages, receipts, and watermarks survive intact.

### 8.3 — Data export
ADR 0022: `GET /api/me/export` returns complete account archive: profile metadata, conversation
memberships, all messages authored by the caller, and receipt positions.

### 8.4 — Health checks, outbox purge, and structured logging
H-15, H-16, H-18: `/health` dependency check (Neon `SELECT 1`, Redis `PING`), outbox purge function,
and structured JSON logging with redaction.

---

## Sequence — **complete**

```
8.0 ✅ ──▶ 8.1 ✅ ──▶ 8.2 ✅ ──▶ 8.3 ✅ ──▶ 8.4 ✅ ──▶ Gate 1 Complete
```
