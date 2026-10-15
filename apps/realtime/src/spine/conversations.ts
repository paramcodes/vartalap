/**
 * Creating conversations — gate C1, and the group ceiling.
 *
 * Two routes share this file because they share everything that matters: handle
 * resolution, member seeding with the member's own name, watermark seeding so a
 * new conversation never has a member with no watermark, and idempotency under
 * the creation race. What differs is one column — `direct_key` present or NULL —
 * and one number, the 500-member ceiling that only groups can hit.
 *
 * ── the race, and why it is a constraint rather than a lock ─────────────────
 *
 * Two people messaging each other for the first time simultaneously is the
 * NORMAL case, not an edge. The answer is not the advisory lock (that
 * serialises writes to one conversation; here there is no conversation yet to
 * serialize on) but the unique index: `INSERT … ON CONFLICT DO NOTHING`, then
 * re-select. Both racers converge on the one row the constraint allowed. Every
 * seeding write below is likewise `ON CONFLICT DO NOTHING`, so the loser
 * re-seeds harmlessly instead of failing.
 *
 * ── display names come from the user row ───────────────────────────────────
 *
 * `member.display_name` is `NOT NULL`, and its value is the member's `user.name`
 * at creation. Not a request field: a name supplied by the creator for somebody
 * else is a nickname feature wearing a creation field's clothes, and nicknames
 * are not v1. (The request schema used to carry an optional `displayName`; it
 * had no consumers and was removed rather than silently ignored.)
 *
 * ── direct rows never carry a title ──────────────────────────────────────────
 *
 * ADR 0007: a direct conversation derives its title from the other member, so
 * a stored one can only go stale. The direct path writes `title: NULL`
 * explicitly rather than omitting it, and the test reads the row back — a
 * column that is null by accident and null by design look identical until
 * someone writes to it.
 */
import { eq, inArray } from 'drizzle-orm';
import { db, conversation, delivery, member, receipt, user } from '@vartalap/database';
import {
  conversation as conversationSchema,
  MAX_GROUP_MEMBERS,
  normalizeHandle,
  seqFromBigInt,
  type Conversation,
} from '@vartalap/protocol';

export interface ResolvedMember {
  readonly id: string;
  readonly name: string;
}

/** What creation can answer. A refusal writes nothing at all. */
export type CreateConversationOutcome =
  | { readonly kind: 'created'; readonly conversation: Conversation }
  | { readonly kind: 'unknownHandle'; readonly handle: string }
  | { readonly kind: 'cannotTalkToSelf' }
  | { readonly kind: 'tooManyMembers'; readonly members: number };

/**
 * Handles in, user rows out. One query for the whole list — a creation naming
 * fifty members does not do fifty lookups. Normalised before lookup, because
 * handles are lowercase by construction (the `username()` plugin) and a
 * mixed-case request names the same member.
 */
async function resolveHandles(handles: readonly string[]): Promise<{
  readonly resolved: ResolvedMember[];
  readonly missing: string | null;
}> {
  const normalized = [...new Set(handles.map(normalizeHandle))];
  if (normalized.length === 0) return { resolved: [], missing: null };
  const rows = await db
    .select({ id: user.id, username: user.username, name: user.name })
    .from(user)
    .where(inArray(user.username, normalized));
  const byUsername = new Map(rows.map((row) => [row.username, row]));
  for (const handle of normalized) {
    if (!byUsername.has(handle)) return { resolved: [], missing: handle };
  }
  return {
    resolved: normalized.map((handle) => {
      const row = byUsername.get(handle)!;
      return { id: row.id, name: row.name };
    }),
    missing: null,
  };
}

/**
 * Seed members and watermarks for a conversation that now exists. Idempotent
 * throughout — every write is `ON CONFLICT DO NOTHING` — so two racers
 * converging on one conversation row both seed harmlessly.
 */
async function seedMembers(conversationId: string, members: readonly ResolvedMember[]): Promise<void> {
  for (const memberRow of members) {
    await db
      .insert(member)
      .values({
        conversationId,
        userId: memberRow.id,
        displayName: memberRow.name,
      })
      .onConflictDoNothing();
    await db.insert(receipt).values({ conversationId, userId: memberRow.id }).onConflictDoNothing();
    await db.insert(delivery).values({ conversationId, userId: memberRow.id }).onConflictDoNothing();
  }
}

async function readConversation(conversationId: string): Promise<Conversation> {
  const [row] = await db.select().from(conversation).where(eq(conversation.id, conversationId)).limit(1);
  if (row === undefined) throw new Error('the conversation did not exist after insert');
  return conversationSchema.parse({
    id: row.id,
    kind: row.kind,
    directKey: row.directKey,
    title: row.title,
    lastSeq: seqFromBigInt(BigInt(row.lastSeq)),
  });
}

/**
 * A direct conversation with the holder of a handle.
 *
 * The key is the two user ids sorted and joined — never the handles, which are
 * display spellings of the same members — so argument order cannot produce two
 * keys and the unique index does the work it exists to do.
 */
export async function createDirectConversationWith(
  creatorId: string,
  otherHandle: string,
): Promise<CreateConversationOutcome> {
  const creator = await db
    .select({ id: user.id, username: user.username, name: user.name })
    .from(user)
    .where(eq(user.id, creatorId))
    .limit(1);
  if (creator[0] === undefined) throw new Error('the creator does not exist');
  const { resolved, missing } = await resolveHandles([otherHandle]);
  if (missing !== null) return { kind: 'unknownHandle', handle: missing };
  const peer = resolved[0]!;
  if (peer.id === creator[0].id) return { kind: 'cannotTalkToSelf' };

  const directKey = [creator[0].id, peer.id].sort().join(':');
  await db.insert(conversation).values({ kind: 'direct', directKey, title: null }).onConflictDoNothing();

  const [row] = await db
    .select({ id: conversation.id })
    .from(conversation)
    .where(eq(conversation.directKey, directKey))
    .limit(1);
  if (row === undefined) throw new Error('the direct conversation did not exist after insert');

  await seedMembers(row.id, [
    { id: creator[0].id, name: creator[0].name },
    { id: peer.id, name: peer.name },
  ]);
  return { kind: 'created', conversation: await readConversation(row.id) };
}

/**
 * A group conversation. `direct_key` NULL — Postgres treats NULLs as distinct,
 * so the same unique index that forces one row per direct pair allows unlimited
 * group rows, and no second mechanism exists.
 *
 * The ceiling is enforced by counting, in the application, before inserting:
 * a group is created whole or not at all, and the 501st member is a clean
 * refusal rather than a partial fan-out.
 */
export async function createGroupConversation(
  creatorId: string,
  title: string,
  handles: readonly string[],
): Promise<CreateConversationOutcome> {
  const creator = await db
    .select({ id: user.id, username: user.username, name: user.name })
    .from(user)
    .where(eq(user.id, creatorId))
    .limit(1);
  if (creator[0] === undefined) throw new Error('the creator does not exist');
  const { resolved, missing } = await resolveHandles(handles);
  if (missing !== null) return { kind: 'unknownHandle', handle: missing };

  const members = new Map<string, ResolvedMember>();
  members.set(creator[0].id, { id: creator[0].id, name: creator[0].name });
  for (const memberRow of resolved) members.set(memberRow.id, memberRow);
  if (members.size > MAX_GROUP_MEMBERS) {
    return { kind: 'tooManyMembers', members: members.size };
  }

  const [row] = await db
    .insert(conversation)
    .values({ kind: 'group', directKey: null, title })
    .returning({ id: conversation.id });
  if (row === undefined) throw new Error('the group insert returned no row');

  await seedMembers(row.id, [...members.values()]);
  return { kind: 'created', conversation: await readConversation(row.id) };
}
