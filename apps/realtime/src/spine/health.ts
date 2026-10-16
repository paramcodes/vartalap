/**
 * Health check dependency probe (H-16) and outbox purge (H-18, Gate H5).
 */
import { and, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db as defaultDb, outbox } from '@vartalap/database';
import { Redis } from './redis.ts';

export interface HealthStatus {
  readonly status: 'pass' | 'fail';
  readonly database: boolean;
  readonly redis: boolean;
}

export async function checkHealth(dbInstance = defaultDb): Promise<HealthStatus> {
  let dbOk = false;
  try {
    await dbInstance.execute(sql`SELECT 1`);
    dbOk = true;
  } catch {
    dbOk = false;
  }

  let redisOk = false;
  try {
    const redis = await Redis.connect({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
    const reply = await redis.command('PING');
    redisOk = reply === 'PONG';
  } catch {
    redisOk = false;
  }

  const allOk = dbOk && redisOk;
  return {
    status: allOk ? 'pass' : 'fail',
    database: dbOk,
    redis: redisOk,
  };
}

/**
 * ADR 0057 & H-18: Outbox purge.
 * - Deletes rows that have been successfully published.
 * - Deletes failed attempts older than 24 hours from created_at.
 * - Never purges fresh sends (attempts = 0).
 */
export async function purgeOutbox(dbInstance = defaultDb): Promise<{ publishedPurged: number; failedPurged: number }> {
  // 1. Published rows
  const published = await dbInstance
    .delete(outbox)
    .where(isNotNull(outbox.publishedAt));

  // 2. Failed rows older than 24 hours
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const failed = await dbInstance
    .delete(outbox)
    .where(
      and(
        isNull(outbox.publishedAt),
        lt(outbox.createdAt, cutoff),
        sql`${outbox.attempts} > 0`,
      ),
    );

  return {
    publishedPurged: 0,
    failedPurged: 0,
  };
}
