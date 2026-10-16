/**
 * Rate limits are a Redis token bucket keyed on identity (ADR 0043, Gate H2).
 *
 * Rules:
 * - send: 30 / min, burst 10 (user, fails open)
 * - auth: 10 / min, burst 3 (IP, fails closed)
 * - search: 60 / min, burst 20 (user, fails open)
 * - presign: 20 / hr, burst 5 (user, fails open)
 */
import { Redis } from './redis.ts';

export type RateLimitSurface = 'send' | 'auth' | 'search' | 'presign';

export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
  readonly burst: number;
  readonly failClosed: boolean;
}

export const RATE_LIMIT_RULES: Record<RateLimitSurface, RateLimitRule> = {
  send: { limit: 30, windowSeconds: 60, burst: 10, failClosed: false },
  auth: { limit: 10, windowSeconds: 60, burst: 3, failClosed: true },
  search: { limit: 60, windowSeconds: 60, burst: 20, failClosed: false },
  presign: { limit: 20, windowSeconds: 3600, burst: 5, failClosed: false },
};

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetSeconds: number;
  readonly retryAfter?: number;
}

export async function checkRateLimit(
  surface: RateLimitSurface,
  identifier: string,
  redisClient?: Redis,
): Promise<RateLimitVerdict> {
  const rule = RATE_LIMIT_RULES[surface];
  const maxAllowed = rule.limit + rule.burst;

  try {
    const redis = redisClient ?? (await Redis.connect({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' }));
    const key = `ratelimit:${surface}:${identifier}`;
    const now = Date.now();
    const windowStart = now - rule.windowSeconds * 1000;

    await redis.command('ZREMRANGEBYSCORE', key, 0, windowStart);
    const count = Number(await redis.command('ZCARD', key));

    if (count < maxAllowed) {
      const member = `${now}:${Math.random()}`;
      await redis.command('ZADD', key, now, member);
      await redis.command('EXPIRE', key, rule.windowSeconds);
      return {
        allowed: true,
        limit: rule.limit,
        remaining: Math.max(0, maxAllowed - count - 1),
        resetSeconds: rule.windowSeconds,
      };
    }

    return {
      allowed: false,
      limit: rule.limit,
      remaining: 0,
      resetSeconds: rule.windowSeconds,
      retryAfter: rule.windowSeconds,
    };
  } catch (err) {
    // Auth fails closed; everything else fails open (ADR 0043)
    if (rule.failClosed) {
      return {
        allowed: false,
        limit: rule.limit,
        remaining: 0,
        resetSeconds: rule.windowSeconds,
        retryAfter: rule.windowSeconds,
      };
    }
    return {
      allowed: true,
      limit: rule.limit,
      remaining: rule.limit,
      resetSeconds: rule.windowSeconds,
    };
  }
}
