import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  bigint,
  bigserial,
} from 'drizzle-orm/pg-core';

/**
 * Postgres `tsvector`. Drizzle 0.38 has no built-in for it, and `text()` is not a
 * substitute: a `text` column holding a tsvector has no default GIN operator class,
 * so `USING gin (search_vector)` fails outright on a fresh database. That is not a
 * warning — the index creation errors, and the migration does not apply.
 *
 * Caught by running packages/database/drizzle/0001_init.sql rather than reading it.
 */
const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * The vartalap schema. Every odd-looking choice here is an ADR, and the comment
 * says which one. If you change something and cannot name the decision behind it,
 * you are about to reintroduce a bug somebody already paid for.
 *
 * The full list of traps lives in `docs/decisions-index.md`.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH — the auth layer keeps only what belongs to it. `user` is OURS.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ADR 0016: `user` is our table in our database. The auth library keeps a Credential
 * (`account`) and a Session (`session`); it does not own identity. There is no
 * synchronisation code because there is nothing to synchronise — presence is derived
 * from a Redis TTL and read state from a receipt, so neither mirrors a column here.
 *
 * Column names follow the library's contract (`username`, `display_username`); the
 * GLOSSARY governs how we talk, not what the column is called.
 */
export const user = pgTable(
  'user',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    username: text('username').notNull(),
    displayUsername: text('display_username'),

    // ── Better Auth's declared user fields ─────────────────────────────────────
    // Both exist because Better Auth 1.7.x validates the schema on every request
    // and reports `missing-column` for any declared field that is absent — auth is
    // down with a 500 until it matches.
    //
    // `name` is the ACCOUNT display name, the one a member sees before they have a
    // per-conversation one. `member.display_name` is the override inside a
    // Conversation (ADR 0016).
    name: text('name').notNull(),
    // Dead. Avatars are Media through ADR 0008's pipeline. Nothing may write this.
    image: text('image'),

    /** Avatar is Media through the same pipeline as an attachment (ADR 0008). */
    avatarMediaId: uuid('avatar_media_id'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // ADR 0001 + 0016: normalisation happens INSIDE the auth plugin, so a write that
    // bypasses it (we write with Drizzle) never normalises. This index is the safety
    // net that catches exactly that bypass — it costs nothing and catches every
    // bypassing writer. Do not remove it thinking `username` is already unique.
    // ADR 0017: `COLLATE "C"` is load-bearing, not decoration. An unqualified
    // `lower()` computes under whatever locale the database was created with, and
    // `lower('İ')` is `i` under a non-C locale but `İ` under C — so Postgres and
    // JavaScript's toLowerCase disagree about the same string. That disagreement is
    // a handle that is "already taken" for someone who just typed it, or two rows
    // that the index fails to catch. The local PGlite database is already `C`, so
    // this only shows up on Neon, which is exactly why it needs pinning here.
    uniqueIndex('user_username_lower_key').on(sql`lower(${t.username} COLLATE "C")`),
    // The read path signs in with `WHERE username = $1`, and an expression index on
    // lower() cannot serve that — it would need the session to know the input is
    // already normalised. This plain unique index is what makes it a lookup.
    // `auth-and-identity.md` calls for it; it was missing until the sign-in path
    // needed it.
    uniqueIndex('user_username_unique').on(t.username),
    // A Handle is a Handle, not an email. An account may have both; the ticket's
    // verification found there is NO username-only signup, so email is mandatory.
    uniqueIndex('user_email_key').on(t.email),
  ],
);

/**
 * ADR 0016: a Handle is claimed ONCE and never changes (`immutableUsername`), because
 * the auth plugin has no history table — releasing one frees it immediately and an
 * abandoned `@alice` silently re-points to a stranger, which looks like nothing at all
 * in a transcript because the messages say "Alice".
 *
 * Rows here are retained FOREVER, even after account erasure (ADR 0041), because
 * tombstoning the user must not make their handle claimable by a stranger.
 */
export const handleReservation = pgTable(
  'handle_reservation',
  {
    handle: text('handle').primaryKey(),
    // Nullable, because a RELEASED handle has no owner: the trigger that writes the
    // release fires BEFORE DELETE and the user is mid-deletion. NOT NULL here is what
    // made the documented trigger insert impossible.
    userId: uuid('user_id'),
    /** 'released' (deletion), or 'reserved' (held back deliberately). */
    reason: text('reason').notNull().default('released'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('handle_reservation_user_idx').on(t.userId)],
);

export const account = pgTable('account', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  scope: text('scope'),
  password: text('password'),
  // Better Auth 1.7.x declares these and validates their existence on every
  // request. Nullability is ours, not its: a PASSWORD account never has an OAuth
  // token expiry, and Better Auth does not write these for that case. Declaring
  // them NOT NULL without a default is exactly the `unexpected-required-column`
  // failure its own validator warns about — every sign-up would break.
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** ADR 0018: a socket is a 60-second lease. Revocation is a row delete plus a disconnect. */
export const session = pgTable(
  'session',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    // ADR 0022 device scope. Core `listSessions` already returns every non-expired
    // session with ipAddress and userAgent, so these two are the only additions
    // needed to name a device and mark it trusted. `updateSession` writes only
    // custom fields and rejects core ones, which is what makes them a safe place
    // to hang device state.
    deviceLabel: text('device_label'),
    deviceTrusted: boolean('device_trusted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('session_user_idx').on(t.userId), uniqueIndex('session_token_key').on(t.token)],
);

export const verification = pgTable(
  'verification',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (t) => [index('verification_identifier_idx').on(t.identifier)],
);

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERSATIONS — one table. A NULL does the uniqueness work. (ADR 0007)
// ═══════════════════════════════════════════════════════════════════════════════

export const conversationKind = pgEnum('conversation_kind', ['direct', 'group']);

/**
 * Direct and Group conversations are rows in ONE table, because every read path —
 * list, badge, preview, drafts, read state, socket subscription, push — is written
 * once against a single shape.
 *
 * `directKey` is the two user ids sorted and joined by `:`. **Postgres treats NULLs
 * as distinct in a unique index by default**, so ONE unique index gives both halves of
 * the rule: non-null keys collide (exactly one conversation per direct pair) and NULLs
 * never do (unlimited groups). No partial index, no application check, no race.
 *
 * DO NOT replace this with a partial unique index on `member`. A partial index is
 * usable only when the planner can prove the query implies its predicate, and
 * parameterized query clauses do not work with one. The failure is silent: the
 * constraint still holds, the read path stops using the index, and a hot query goes
 * slow for reasons nobody can trace back to this file.
 *
 * `lastSeq` defaults to 0 and is NEVER NULL — IndexedDB does not index `null`, so a
 * conversation that has never had a message would sort unpredictably in Dexie.
 */
export const conversation = pgTable(
  'conversation',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: conversationKind('kind').notNull(),
    directKey: text('direct_key'),
    /** Groups only. Direct conversations DERIVE their title from the other member. */
    title: text('title'),
    lastSeq: bigint('last_seq', { mode: 'number' }).notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('conversation_direct_key_key').on(t.directKey),
    index('conversation_last_seq_idx').on(t.lastSeq),
    // A direct conversation HAS a key; a group does not. Belt to the uniqueness index.
    check(
      'conversation_kind_direct_key',
      sql`(${t.kind} = 'direct' AND ${t.directKey} IS NOT NULL) OR (${t.kind} = 'group' AND ${t.directKey} IS NULL)`,
    ),
  ],
);

/**
 * A Member. Retained with `leftAt` — a Former member REMAINS one. Nothing they sent
 * is deleted and no membership is erased. Deleting the row would destroy the record
 * that they once had access, which is exactly the thing the glossary protects.
 *
 * A rejoining member INHERITS their receipt, because a stale receipt is true and a
 * zeroed one is a lie.
 */
export const member = pgTable(
  'member',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id),
    displayName: text('display_name').notNull(),
    avatarMediaId: uuid('avatar_media_id'),
    /** Non-null means Former member. Still a row; still holds a receipt. */
    leftAt: timestamp('left_at', { withTimezone: true }),
    /** ADR 0046: mute is a MARKER, not a filter. It never enters a list query. */
    mutedAt: timestamp('muted_at', { withTimezone: true }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('member_user_idx').on(t.userId),
    // A rejoin clears the marker rather than inserting a second row.
    uniqueIndex('member_active_key')
      .on(t.conversationId, t.userId)
      .where(sql`${t.leftAt} IS NULL`),
  ],
);

/** ADR 0007: blocks are asymmetric. A is blocked_by_them ⇒ A cannot SEND. */
export const block = pgTable(
  'block',
  {
    blockerId: uuid('blocker_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    index('block_blocked_idx').on(t.blockedId),
    check('block_not_self', sql`${t.blockerId} <> ${t.blockedId}`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGES — the durable spine. (ADR 0004, 0005)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ADR 0005: `seq` is the PRIMARY KEY and it is GLOBAL.
 *
 * Why the bigint is the PK rather than the UUID: an 8-byte key already in insertion
 * order means a keyset page scans the index without touching the heap. The dedupe
 * constraint is identical either way — `UNIQUE (id)` dedupes exactly as well as a
 * primary key — so this is purely index behaviour.
 *
 * Why global rather than per-conversation: per-conversation positions do not compare
 * across conversations, so there is no global cursor and reconnect becomes one query
 * per conversation. One column serving both jobs cannot disagree with itself.
 *
 * WHY THE SERIAL MATTERS: sequences allocate at INSERT, rows become visible at COMMIT.
 * Two inserts into the SAME conversation can therefore invert — and that is the only
 * case where it matters, because a client paging conversation B backwards never
 * encounters conversation A's seq. The send path MUST take
 * `pg_advisory_xact_lock(hashtextextended($1::uuid::text, 8530225013392695664))`
 * before inserting. It is one line carrying the entire guarantee; do not "simplify" it
 * away. See ADR 0005 for the guarantee and ADR 0056 for the derivation — including why
 * the `::uuid::text` cast is not optional. See ADR 0054.
 *
 * `body` carries a stored generated tsvector with the 'simple' configuration — NOT
 * 'english', which drops stop words and stems, so `rats` becomes `rat`. Search wants
 * exact names. See ADR 0009. NOTE: this is why end-to-end encryption and message
 * search are in direct conflict — a tsvector cannot be built from ciphertext.
 */
export const message = pgTable(
  'message',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    /**
     * The client-generated UUIDv7: identity AND idempotency key, one value for both.
     * Server-assigned position is `seq`; this is never used for order.
     */
    id: uuid('id').notNull(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    authorId: uuid('author_id').notNull().references(() => user.id),
    body: text('body').notNull().default(''),
    /**
     * 'simple', not 'english' — ADR 0009. 'english' drops stop words (its vector has
     * no `a`, `on` or `it`) and stems, so `rats` becomes `rat`. Search wants exact
     * names and exact words.
     *
     * This is also why E2EE and message search are in direct conflict: a tsvector
     * cannot be built from ciphertext.
     */
    searchVector: tsvector('search_vector').generatedAlwaysAs(sql`to_tsvector('simple', "body")`),
    /** Client clock. Display only. NEVER a sort key — clocks drift and users set them. */
    clientCreatedAt: timestamp('client_created_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('message_id_key').on(t.id),
    index('message_conversation_seq_idx').on(t.conversationId, t.seq),
    // ADR 0009: GIN on the vector for ranked multi-word queries.
    index('message_search_vector_idx').using('gin', t.searchVector),
    // ADR 0009: trigrams for short prefixes, guarded at 3 characters by the caller —
    // a 1-2 char pattern yields no trigrams and degenerates to a full index scan.
    index('message_body_trgm_idx').using('gin', sql`${t.body} gin_trgm_ops`),
  ],
);

/** ADR: Attachment is a property of a Message, not a thing in its own right. */
export const messageAttachment = pgTable(
  'message_attachment',
  {
    messageSeq: bigint('message_seq', { mode: 'number' })
      .notNull()
      .references(() => message.seq, { onDelete: 'cascade' }),
    mediaId: uuid('media_id').notNull(),
    position: integer('position').notNull(),
  },
  (t) => [primaryKey({ columns: [t.messageSeq, t.position] })],
);

/**
 * The transactional outbox — ADR 0004. Written in the SAME transaction as the message
 * insert, because the alternative ("commit, then call the broker") has a failure mode
 * with no recovery: the message exists, the transaction succeeded, the broadcast
 * failed, and nobody ever hears about it.
 *
 * `publishedAt` null means not yet relayed. H-18 purges published rows and retains
 * failed ones for 24h.
 *
 * `attempts` and `lastError` exist because that rule is otherwise INEXPRESSIBLE. With
 * only `published_at`, a row the relay has tried five times and row it has never
 * touched are both "unpublished", so "failed" and "never attempted" are the same
 * value and the retention window cannot distinguish a transient broker outage from a
 * permanently undeliverable payload. Stage 3 added both columns for that reason, and
 * H-18 is now writable.
 *
 * WHY THE FOREIGN KEY IS `no action` AND NOT `cascade`: a hard delete of a `message`
 * row that cascades here deletes an undelivered send. The message is gone, so nothing
 * ever broadcasts it, and the transcript simply has a hole where it was — the exact
 * failure ADR 0004 forbids for watermarks. `NO ACTION` errors instead of deleting, so
 * the delete is refused while a row is outstanding. It differs from `RESTRICT` only in
 * deferrability, and the non-deferrable form is the one that fails at the statement
 * rather than at `COMMIT`.
 */
export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /**
     * The message this publishes. Carries `seq`, which is why ordering comes first.
     *
     * `onDelete: 'no action'` is WRITTEN rather than omitted: Drizzle's default is
     * already `no action`, and this column was `cascade` once. Spelling it out is what
     * stops the next reader from "tidying" it back.
     */
    messageSeq: bigint('message_seq', { mode: 'number' })
      .notNull()
      .references(() => message.seq, { onDelete: 'no action' }),
    conversationId: uuid('conversation_id').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** Relay attempts so far. `0` means the relay has never touched this row. */
    attempts: integer('attempts').notNull().default(0),
    /** The sink's error text from the most recent failure. NULL until one happens. */
    lastError: text('last_error'),
  },
  (t) => [
    // The relay's hot path is "unpublished rows, oldest first" (ADR 0057). The same
    // partial index serves the 24h purge, which is also "unpublished rows, oldest
    // first" with a `created_at` cutoff — so the purge needs no index of its own.
    index('outbox_unpublished_idx').on(t.createdAt).where(sql`${t.publishedAt} IS NULL`),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════
// READING — a bookmark, not a diary. (ADR 0003, 0010)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ADR 0010: TWO positions, not one plus a boolean.
 *
 * `readThrough` advances always — it is your own truth about your own reading, and it
 * drives YOUR unread count. `sharedThrough` advances ONLY while `sharing` is on, and
 * "Seen" is computed over it.
 *
 * Why one boolean is not enough: `readThrough` keeps advancing while sharing is off (it
 * must, or the unread count breaks), so turning sharing back on broadcasts a position
 * that REVEALS the entire gap the member spent hiding. Broadcasting nothing reveals it
 * on the next advance anyway. A boolean cannot express "frozen where it was when I
 * turned this off" — that needs a second stored value.
 *
 * Turn sharing off and `sharedThrough` freezes; turn it back on and it resumes from
 * the frozen value, so the sender sees forward progress that merely lags.
 *
 * ── WHICH OF THE TWO IS THE MECHANISM (ADR 0058) ────────────────────────────
 *
 * `shared_through` is the mechanism: it is the stored value other people read, and it
 * is the only thing `Seen` is computed over. `sharing` is a SIGNAL ABOUT A PERMISSION:
 * the server may advance `shared_through` only while it is true, and turning it false
 * changes nothing by itself. Sharing off does not clear or hold back `read_through` —
 * `read_through` advances regardless, or the member's unread badge breaks. It holds
 * back `shared_through`, and only because the server was told not to move it.
 *
 * Which endpoint carries the flag is a separate question, settled by ADR 0059 and 0022:
 * this column is not on the receipt-advance body. The distinction this comment exists to
 * prevent is mechanism-versus-signal, and it is orthogonal to the transport.
 *
 * The failure this framing exists to prevent: reading `sharing` as the mechanism, so
 * that turning it off freezes nothing on the server, and re-enabling syncs
 * `shared_through` straight to `read_through` — broadcasting the whole hidden gap.
 * `sharing` is not state about a position. It is a message about a permission, and
 * `shared_through` is the state.
 *
 * NEITHER this table nor `delivery` MAY carry a foreign key to `message`. They point at
 * a POSITION, not a row. An FK with ON DELETE CASCADE would make deleting a message
 * delete the thing pointing at it and un-see everything behind it.
 *
 * `read_through >= shared_through` holds at all times — nobody reads what did not
 * arrive — and there is deliberately NO `CHECK` constraint saying so. ADR 0010 line 68:
 * the invariant is about *how* a row is written, not what a single row contains. The
 * mechanism is `GREATEST` in the upsert, and a constraint would turn the correct write
 * order into a hard requirement on every future writer for no gain: any row satisfying
 * it is already correct, and any row violating it is a bug the upsert cannot produce.
 * The shipped schema carried `receipt_shared_le_read`; stage 3 dropped it.
 */
export const receipt = pgTable(
  'receipt',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id),
    readThrough: bigint('read_through', { mode: 'number' }).notNull().default(0),
    sharedThrough: bigint('shared_through', { mode: 'number' }).notNull().default(0),
    sharing: boolean('sharing').notNull().default(true),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    // NO `check('receipt_shared_le_read', ...)`. See the comment above. Adding it back
    // is a refactor that silently re-derails the documented mechanism.
    // The "Seen" predicate scans members whose receipt can gate it.
    index('receipt_shared_through_idx').on(t.conversationId, t.sharedThrough),
  ],
);

/**
 * ADR 0004: delivery is the fact that a frame ARRIVED — separate from read, which is
 * opening a conversation. It lives in its own table rather than as a column on
 * `receipt` because the glossary defines a Receipt as how far someone has READ, and
 * overloading that table would quietly corrupt a definition.
 *
 * Any ONE device acknowledging advances it. "Every device has it" is unfixable by
 * construction — a powered-off device may never acknowledge.
 */
export const delivery = pgTable(
  'delivery',
  {
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversation.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').notNull().references(() => user.id),
    deliveredThrough: bigint('delivered_through', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.userId] }),
    index('delivery_through_idx').on(t.conversationId, t.deliveredThrough),
  ],
);

// ═══════════════════════════════════════════════════════════════════════════════
// MEDIA — the raw upload is never served. (ADR 0008)
// ═══════════════════════════════════════════════════════════════════════════════

export const mediaState = pgEnum('media_state', ['pending', 'ready', 'failed']);

/**
 * ADR 0008: the raw upload is NEVER served to anyone. The worker sniffs the bytes,
 * accepts only an allowlist of image types, and derives these three variants. An
 * uploaded HTML file has no URL.
 *
 * Three FIXED COLUMNS rather than a JSON variants document: the count is decided at
 * design time and never varies per image, so a document buys flexibility nobody will
 * use and costs a lookup on every read. Resizing on read is ruled out — it turns a
 * busy conversation into a bandwidth bill, which is the same reason R2 was chosen.
 *
 * No FK to message: attachments reference media, and media outlives its message
 * deliberately. Removal is a scheduled purge of unreferenced objects, never a cascade.
 */
export const media = pgTable('media', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').notNull().references(() => user.id),
  state: mediaState('state').notNull().default('pending'),
  /** SNIFFED server-side. Never the declared type, never the signed one. */
  sniffedMime: text('sniffed_mime'),
  byteSize: integer('byte_size'),
  width: integer('width'),
  height: integer('height'),
  /** The untrusted original. Stored, never served. */
  rawKey: text('raw_key').notNull(),
  thumbKey: text('thumb_key'),
  previewKey: text('preview_key'),
  fullKey: text('full_key'),
  /** A terminal failure is what gives the UI a retry affordance. */
  failureReason: text('failure_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  readyAt: timestamp('ready_at', { withTimezone: true }),
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUSH — triggered by the outbox, never by the transport. (ADR 0011)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Keyed on `endpoint`, because an endpoint IS a capability URL and therefore a
 * credential. Cleanup is push-service-driven — there is deliberately NO inactivity
 * sweeper, because a sweeper races the vendor's own expiry and logs you out of
 * notifications you still have.
 */
export const pushSubscription = pgTable(
  'push_subscription',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('push_subscription_endpoint_key').on(t.endpoint), index('push_user_idx').on(t.userId)],
);

// ═══════════════════════════════════════════════════════════════════════════════
// RELATIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const userRelations = relations(user, ({ many }) => ({
  memberships: many(member),
  messages: many(message),
}));

export const conversationRelations = relations(conversation, ({ many, one }) => ({
  members: many(member),
  messages: many(message),
  lastMessage: one(message, { fields: [conversation.lastSeq], references: [message.seq] }),
}));

export const memberRelations = relations(member, ({ one }) => ({
  conversation: one(conversation, { fields: [member.conversationId], references: [conversation.id] }),
  user: one(user, { fields: [member.userId], references: [user.id] }),
}));

export const messageRelations = relations(message, ({ one, many }) => ({
  conversation: one(conversation, { fields: [message.conversationId], references: [conversation.id] }),
  author: one(user, { fields: [message.authorId], references: [user.id] }),
  attachments: many(messageAttachment),
}));

export const receiptRelations = relations(receipt, ({ one }) => ({
  conversation: one(conversation, { fields: [receipt.conversationId], references: [conversation.id] }),
  user: one(user, { fields: [receipt.userId], references: [user.id] }),
}));

export const deliveryRelations = relations(delivery, ({ one }) => ({
  conversation: one(conversation, { fields: [delivery.conversationId], references: [conversation.id] }),
  user: one(user, { fields: [delivery.userId], references: [user.id] }),
}));

/**
 * Inferred row types, suffixed `Row`.
 *
 * `@vartalap/protocol` exports wire types called `Conversation`, `Member`,
 * `Message`, `Receipt` and `Delivery` — the same names these tables have. A wire
 * type and a row are different things with different fields: the wire `Message`
 * has `seq` as a decimal STRING because a Postgres bigint does not survive JSON,
 * and `createdAt` as an ISO string because there is no Date on the wire. A file
 * that imports both packages — and every file in `apps/realtime/src/spine/` is
 * one, because the spine reads rows and writes frames — had an ambiguous
 * `Message` on its first line.
 *
 * The suffix is Drizzle's own convention for this and it is deliberate: a
 * namespace import would make every future file remember to disambiguate, and
 * forgetting is silent. The protocol keeps the bare name because a wire type
 * named `Message` IS the contract; a database type that quietly shares it is the
 * accident. Anything reading a row should name it `<Thing>Row` whether or not
 * `@vartalap/protocol` happens to be imported alongside it.
 */
export type UserRow = typeof user.$inferSelect;
export type ConversationRow = typeof conversation.$inferSelect;
export type MemberRow = typeof member.$inferSelect;
export type MessageRow = typeof message.$inferSelect;
export type ReceiptRow = typeof receipt.$inferSelect;
export type DeliveryRow = typeof delivery.$inferSelect;
export type MediaRow = typeof media.$inferSelect;