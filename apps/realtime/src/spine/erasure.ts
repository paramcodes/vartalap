/**
 * Account erasure — tombstoning and zero cascade (ADR 0041, Gate H3).
 *
 * Runs in one transaction:
 * - Anonymises the user row into a tombstone.
 * - Retains the username reservation so it can never be reused.
 * - Deletes sessions and credentials (the person's ability to act).
 * - Cascades nothing to messages, receipts, deliveries, or memberships.
 */
import { eq } from 'drizzle-orm';
import { account, db as defaultDb, pushSubscription, session, user } from '@vartalap/database';

export async function eraseAccount(userId: string, dbInstance = defaultDb): Promise<void> {
  const shortId = userId.replace(/-/g, '').slice(0, 10);
  const tombstoneUsername = `deleted_${shortId}`;
  const tombstoneEmail = `tombstone-${userId}@deleted.invalid`;

  await dbInstance.transaction(async (tx) => {
    // 1. Delete credentials, sessions, and push subscriptions
    await tx.delete(session).where(eq(session.userId, userId));
    await tx.delete(account).where(eq(account.userId, userId));
    await tx.delete(pushSubscription).where(eq(pushSubscription.userId, userId));

    // 2. Anonymise user row into a tombstone
    await tx
      .update(user)
      .set({
        email: tombstoneEmail,
        emailVerified: false,
        name: 'Deleted user',
        username: tombstoneUsername,
        displayUsername: null,
        image: null,
        avatarMediaId: null,
        updatedAt: new Date(),
      })
      .where(eq(user.id, userId));
  });
}
