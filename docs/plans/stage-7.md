# Stage 7 — media, push, search

The operational plan for stage 7. Decisions live in ADRs and concepts; this file holds **sequence,
scope, and acceptance only**.

**State at the time of writing:** stages 1–6 are complete. The durable spine (stage 3), liveness
(stage 4), conversations and membership (stage 5), and the thin desktop/mobile interface (stage 6)
are functional and tested. This stage completes the three remaining core product capabilities
before the stage 8 hardening audit: **message search** (ADR 0009), **push notifications** (ADR 0011),
and the **media pipeline** (ADR 0008, ADR 0052).

---

## The three gates

| Gate | Guarantee | Proved by |
|---|---|---|
| **S1** | Search runs over messages in conversations the caller currently belongs to; raw input is safe via `websearch_to_tsquery('simple')`; short queries (< 3 chars) and punctuation are guarded; results rank and highlight via `ts_headline`. | 7.1 |
| **S2** | Push is an independent consumer of the outbox row; suppressed if the recipient is currently online (Redis presence TTL) or has already received the frame (`delivered_through >= seq`); payload carries `{ conversationId, messageId, senderName }` and never message body; dead endpoints (404/410) are purged. | 7.2 |
| **S3** | The raw upload is never served to any client; presign creates pending media records; worker validates via byte sniff against the image allowlist, applies `.autoOrient()`, strips metadata, and derives 3 variants (`thumb`, `preview`, `full`); sending only references `ready` media. | 7.3 |

---

## Units

### 7.1 — Message search behind one exported function

ADR 0009: Postgres full-text search with stored generated `tsvector` column (`to_tsvector('simple', body)`)
and GIN index.

- **One exported function:** `searchMessages({ userId, query, conversationId?, cursor?, limit? })`.
  Swapping engines later is a one-file change.
- **Cross-conversation and per-conversation:** Cross-conversation joins `member` to restrict to
  conversations the caller is currently in (`left_at IS NULL`); per-conversation adds `conversation_id = $x`.
- **Query parser & guards:** Uses `websearch_to_tsquery('simple', $query)` so syntax errors are structurally
  impossible. Guard against short prefixes (< 3 characters) and punctuation-only inputs.
- **Snippets:** Highlights generated via `ts_headline('simple', ...)`.
- **API route & client surface:** `GET /api/search?q=...&conversationId=...` and search bar integration in `apps/web`.

**Done when:** S1 passes — non-members read nothing; punctuation and short queries do not crash or full-scan;
results match exact words without stemming (`'simple'`); snippets highlight the matched terms.

### 7.2 — Push notifications from the outbox relay

ADR 0011: Push is a second, independent consumer of the outbox row, sharing only the outbox table
with the fan-out transport.

- **Subscription management:** `push_subscriptions` table (`endpoint`, `p256dh`, `auth`, `user_id`).
  Endpoint is treated as a capability URL (never logged or exposed in API errors).
- **Two-layer suppression:**
  1. Presence filter: check `presence:<userId>` in Redis; skip members who are actively connected.
  2. Watermark check: delayed queue cancel if `delivery.delivered_through >= message.seq`.
- **Payload hygiene:** `{ conversationId, messageId, senderName }`. Title is `senderName`, body is
  fixed `"New message"`. The message text never enters the notification shade.
- **Delivery & cleanup:** Web Push via VAPID keys; HTTP 404/410 responses from push services immediately
  delete the subscription row.
- **Client Service Worker:** `apps/web` registers a service worker (`sw.js`) handling `push` and `notificationclick`.

**Done when:** S2 passes — active members receive no push; an offline member's endpoints receive the push;
message body never appears in payload; 404/410 cleans up the subscription row.

### 7.3 — Media pipeline and staged attachments

ADR 0008 & ADR 0052: The raw upload is never served; media is staged before the message exists.

- **Presign endpoint:** `POST /api/media/presign` creates a `pending` media row and returns a signed PUT URL.
- **Worker pipeline (`sharp`):** Byte sniff (magic numbers), allowlist (`image/jpeg`, `image/png`, `image/webp`, `image/gif`),
  decompression bomb limit, `.autoOrient()` before metadata stripping, transcoding to sRGB WebP/JPEG, and emitting
  3 variants: `thumb` (80px), `preview` (480px), `full` (1600px).
- **State transition:** Media row flips to `ready` with derived variant URLs, or `failed`.
- **Send validation:** `send.ts` asserts all referenced attachment media IDs are in `ready` state (0052).
- **Client staging:** Composer attachment tray renders local `File` object URL immediately, uploads in background,
  swaps to `thumb` when ready; send transmits text + ready attachments without blocking unfinished uploads.

**Done when:** S3 passes — raw upload cannot be fetched; non-image upload is rejected by sniff and marked failed;
portrait photo keeps orientation; send refuses unready media IDs; tray never drops unfinished files on send.

---

## Sequence

```
7.1 (Search) ──▶ 7.2 (Push) ──▶ 7.3 (Media) ──▶ Stage 8 (Hardening)
```

## Rules for every unit

- One commit per unit, landing with its tests green.
- Dependencies require ADR justification: `web-push` for VAPID/push, `sharp` for image transcoding per ADR 0008.
- Breaking a gate's guarantee must fail its tests — report actual command output.
- No regression of stage 1–6 guarantees or token alignment.
