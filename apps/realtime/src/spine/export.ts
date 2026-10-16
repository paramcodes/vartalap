/**
 * On-demand data export (ADR 0022, Gate H4).
 *
 * Emits the caller's complete account archive:
 * - Profile metadata (excluding passwords and tokens)
 * - Conversation memberships
 * - All messages authored by this user
 * - Receipt watermarks
 */
import { eq } from 'drizzle-orm';
import { db as defaultDb, member, message, receipt, user } from '@vartalap/database';

export interface ExportArchive {
  readonly profile: {
    readonly id: string;
    readonly username: string;
    readonly name: string;
    readonly email: string;
    readonly createdAt: string;
  } | null;
  readonly memberships: readonly {
    readonly conversationId: string;
    readonly displayName: string;
    readonly leftAt: string | null;
    readonly mutedAt: string | null;
  }[];
  readonly messages: readonly {
    readonly id: string;
    readonly conversationId: string;
    readonly body: string;
    readonly seq: string;
    readonly createdAt: string;
  }[];
  readonly receipts: readonly {
    readonly conversationId: string;
    readonly readThrough: string;
    readonly sharedThrough: string;
  }[];
}

export async function exportUserData(userId: string, dbInstance = defaultDb): Promise<ExportArchive> {
  // 1. Profile
  const userRows = await dbInstance
    .select({
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);

  const profile = userRows[0]
    ? {
        id: userRows[0].id,
        username: userRows[0].username,
        name: userRows[0].name,
        email: userRows[0].email,
        createdAt: userRows[0].createdAt.toISOString(),
      }
    : null;

  // 2. Memberships
  const memberRows = await dbInstance
    .select({
      conversationId: member.conversationId,
      displayName: member.displayName,
      leftAt: member.leftAt,
      mutedAt: member.mutedAt,
    })
    .from(member)
    .where(eq(member.userId, userId));

  const memberships = memberRows.map((m) => ({
    conversationId: m.conversationId,
    displayName: m.displayName,
    leftAt: m.leftAt ? m.leftAt.toISOString() : null,
    mutedAt: m.mutedAt ? m.mutedAt.toISOString() : null,
  }));

  // 3. Authored Messages
  const messageRows = await dbInstance
    .select({
      id: message.id,
      conversationId: message.conversationId,
      body: message.body,
      seq: message.seq,
      createdAt: message.createdAt,
    })
    .from(message)
    .where(eq(message.authorId, userId));

  const messages = messageRows.map((msg) => ({
    id: msg.id,
    conversationId: msg.conversationId,
    body: msg.body,
    seq: String(msg.seq),
    createdAt: msg.createdAt.toISOString(),
  }));

  // 4. Receipts
  const receiptRows = await dbInstance
    .select({
      conversationId: receipt.conversationId,
      readThrough: receipt.readThrough,
      sharedThrough: receipt.sharedThrough,
    })
    .from(receipt)
    .where(eq(receipt.userId, userId));

  const receipts = receiptRows.map((r) => ({
    conversationId: r.conversationId,
    readThrough: String(r.readThrough),
    sharedThrough: String(r.sharedThrough),
  }));

  return {
    profile,
    memberships,
    messages,
    receipts,
  };
}
