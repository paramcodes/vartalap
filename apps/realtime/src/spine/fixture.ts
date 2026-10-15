/**
 * The minimum needed to have something to send into — and **deliberately not
 * stage 5.**
 *
 * Stage 5 is blocks, leaving and rejoining. This is a direct conversation, two
 * members, and a way to authenticate over HTTP, because that is the smallest set
 * that lets a message exist at all. There is no block helper, no `leave()` and no
 * rejoin helper here, and adding one before stage 5 would be writing that unit's
 * decisions here where nobody decided them.
 *
 * **It lives in `src/` rather than beside a test because four units depend on it.**
 * 3.D pages a transcript, 3.E advances watermarks, 3.F relays the outbox and 3.C
 * sends — all of them need a conversation with a member in it, and four private
 * copies of "insert two users and a conversation" is four places for the fixture
 * to drift from `conversation.kind_direct_key`.
 *
 * Every helper reaches the database through `@vartalap/database`, which a test
 * only ever reaches through `test-harness` — that module re-points the singleton
 * before it is evaluated. This file is not a test, so it imports the real thing
 * and inherits whatever the harness set.
 */
import { eq } from 'drizzle-orm';
import { conversation, db, member, user } from '@vartalap/database';
import {
  conversationId as conversationIdScalar,
  messageId,
  userId as userIdScalar,
  type ConversationId,
  type MessageId,
  type UserId,
} from '@vartalap/protocol';

const HANDLE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A short random token that is legal in a Handle (`^[a-z0-9_]{3,20}$`, ADR 0017). */
function token(length = 8): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map((b) => HANDLE_ALPHABET[b % HANDLE_ALPHABET.length]).join('');
}

/**
 * Mint a **UUIDv7**, which `crypto.randomUUID()` cannot do — it returns a v4, and
 * `messageId` refuses anything whose version nibble is not `7`.
 *
 * The version nibble is position 15 of the canonical form and the variant nibble
 * is position 17; the 48-bit big-endian millisecond timestamp occupies the first
 * six bytes (RFC 9562 §5.7).
 *
 * The random bits after the version nibble are `rand_a` plus `rand_b`, which is
 * where RFC 9562's optional same-millisecond counter lives — and which nothing
 * here uses, because **a message id is never an ordering key** (ADR 0004: its
 * timestamp is the client's clock). Two ids minted in the same millisecond are
 * allowed to be in any order relative to each other; that is the decision, not an
 * oversight here.
 */
export function uuidV7(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const now = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1) {
    bytes[i] = Number((now >> BigInt(8 * (5 - i))) & 0xffn);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A fresh message id, already through the branded schema. */
export function newMessageId(): MessageId {
  return messageId.parse(uuidV7());
}

/**
 * A `user` row, written directly.
 *
 * Bypasses Better Auth on purpose, and the only reason it is safe to do so is
 * that the send path never looks at `account` or a password hash — it reads one
 * `author_id` and nothing else. The `reserve_handle` trigger still fires (it is
 * `BEFORE INSERT` on the table, not in the library), so the handle really is
 * claimed the same way a signup claims it.
 *
 * `user.id` is `gen_random_uuid()`, a **v4**, and that is correct: it is not a
 * message id and must not be forced to look like one.
 */
export async function insertUser(displayName?: string): Promise<UserId> {
  const handle = `spine_${token()}`;
  const [row] = await db
    .insert(user)
    .values({ email: `${handle}@example.test`, username: handle, name: displayName ?? handle })
    .returning({ id: user.id });
  return userIdScalar.parse(row!.id);
}

export interface DirectConversation {
  readonly conversationId: ConversationId;
  /** The members, in the order they were passed, as ids. */
  readonly memberIds: readonly UserId[];
}

/**
 * A direct conversation with its members, created the way ADR 0007 says it has to
 * be: `INSERT … ON CONFLICT DO NOTHING`, then re-select.
 *
 * The read-then-write alternative is the classic race with extra steps, and for a
 * direct conversation the race is the **normal** case rather than an edge — two
 * people messaging each other for the first time, simultaneously. `direct_key` is
 * the two ids sorted and joined by `:` so argument order cannot produce two
 * conversations, and the unique index on it (NULLs distinct, so groups are still
 * unlimited) is the constraint that does the work.
 */
export async function createDirectConversation(
  memberIds: readonly (UserId | string)[],
): Promise<DirectConversation> {
  if (memberIds.length < 2) throw new Error('a direct conversation needs two members');
  const ids = memberIds.map((id) => userIdScalar.parse(id));
  const directKey = [...ids].sort().join(':');

  await db.insert(conversation).values({ kind: 'direct', directKey }).onConflictDoNothing();

  const [row] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.directKey, directKey))
    .limit(1);
  if (row === undefined) throw new Error('the direct conversation did not exist after insert');

  for (const memberId of ids) {
    await db
      .insert(member)
      .values({ conversationId: row.id, userId: memberId, displayName: memberId.slice(0, 8) })
      .onConflictDoNothing();
  }

  return { conversationId: conversationIdScalar.parse(row.id), memberIds: ids };
}

/** Two members and the conversation between them. The common case, named. */
export async function directConversationBetweenTwo(): Promise<{
  conversationId: ConversationId;
  authorId: UserId;
  peerId: UserId;
}> {
  const [authorId, peerId] = await Promise.all([insertUser('Author'), insertUser('Peer')]);
  const direct = await createDirectConversation([authorId, peerId]);
  return { ...direct, authorId, peerId };
}

export interface HttpMember {
  readonly userId: UserId;
  /** `name=value` only — a `Cookie` header wants no attributes. */
  readonly cookie: string;
  readonly headers: Record<string, string>;
}

const PASSWORD = 'correct horse battery staple';

/**
 * Sign a member up **over HTTP** and keep the cookie.
 *
 * `auth.api.signUpEmail` would be shorter and would prove nothing this needs to
 * prove: the server-side API hands back the session TOKEN, while `requireSession`
 * verifies the signed HttpOnly cookie Better Auth sets on the wire. Any test of a
 * protected route has to go through the real boundary, so this does too. See
 * `src/server.test.ts`, which is where this pattern started.
 *
 * ⚠️ **Call this once per test file, not once per test.** Better Auth rate-limits
 * its own HTTP surface, and because the client IP cannot be resolved it falls back
 * to one shared bucket per path — *measured here: three `/sign-up/email` requests,
 * then `429`, and the counter does not recover inside a test run*. A file that
 * signs up per test fails at its tenth test for a reason that has nothing to do
 * with whatever it is testing.
 */
export async function signUpOverHttp(origin: string): Promise<HttpMember> {
  const handle = `spine_${token(10)}`;
  const response = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Spine Tester',
      username: handle,
      email: `${handle}@example.test`,
      password: PASSWORD,
    }),
  });
  if (!response.ok) throw new Error(`sign-up failed: ${response.status} ${await response.text()}`);

  const setCookie = response.headers.get('set-cookie');
  if (setCookie === null) throw new Error('sign-up returned no Set-Cookie');
  const cookie = setCookie.split(';')[0]!;

  const body = (await response.json()) as { user: { id: string } };
  return { userId: userIdScalar.parse(body.user.id), cookie, headers: { cookie } };
}

/**
 * ADR 0056's statement, as text.
 *
 * A SECOND COPY, deliberately, and only here. ADR 0056 forbids a second
 * derivation in production code because two code paths taking two different locks
 * is a silent failure. A test comparing the shipped statement against this one is
 * the opposite case: it is what makes "the send path issues ADR 0056's derivation"
 * a claim about a specific expression rather than a claim about something that
 * looks like it.
 */
export const LOCK_SQL =
  'SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 8530225013392695664))';

/**
 * The part of a `postgres` client this module needs. Structural rather than the
 * `postgres.Sql` type, because `@vartalap/realtime` does not depend on the driver
 * directly — and a test must hand in the `sql` it got from
 * `@vartalap/database/test-harness`, never one of its own.
 */
export interface SqlClientLike {
  options: { debug?: unknown };
}

/** One statement as the driver emitted it: the text, and what was BOUND to it. */
export interface CapturedStatement {
  readonly query: string;
  readonly parameters: readonly unknown[];
}

export interface Captured<T> {
  readonly result: T;
  /** Every statement the client emitted, in order. */
  readonly statements: readonly CapturedStatement[];
}

/**
 * Every statement the database client emitted while `run` was in flight.
 *
 * postgres.js reads `options.debug` at query time on every connection, so this
 * sees statements issued INSIDE a transaction too — which is the whole reason it
 * exists, and the reason gate G1a is a real test rather than a decorative one.
 *
 * Patching the tagged-template entry point does NOT work, and that was measured
 * rather than assumed: inside `begin`, postgres.js hands the callback a scoped
 * queryable that never goes through the root client, so a patch there records
 * `begin` and nothing else. A test that passes while checking nothing is worse
 * than no test, so the interception point matters as much as the assertion.
 *
 * The BOUND parameters come along for the same reason. A lock statement can be
 * present and still take the wrong conversation's key, and only the parameter
 * tells those two cases apart.
 */
export async function captureSql<T>(client: SqlClientLike, run: () => Promise<T>): Promise<Captured<T>> {
  const options = client.options;
  const previous = options.debug;
  const statements: CapturedStatement[] = [];

  options.debug = (_connection: number, query: string, parameters: unknown[]) => {
    statements.push({ query: query.replace(/\s+/g, ' ').trim(), parameters: [...parameters] });
  };
  try {
    const result = await run();
    return { result, statements };
  } finally {
    options.debug = previous;
  }
}

/** Where in `statements` the first query matching `pattern` is. `-1` when absent. */
export function indexOfStatement(statements: readonly CapturedStatement[], pattern: RegExp): number {
  return statements.findIndex((statement) => pattern.test(statement.query));
}

/** The queries alone, for assertions that do not care what was bound to them. */
export function queriesOf(statements: readonly CapturedStatement[]): string[] {
  return statements.map((statement) => statement.query);
}