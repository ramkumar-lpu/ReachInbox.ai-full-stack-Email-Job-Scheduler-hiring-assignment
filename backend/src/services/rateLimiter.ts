import { redisClient } from '../config/redis';

export interface RateLimitResult {
  allowed: boolean;
  retryDelayMs?: number;
  currentCount: number;
  limitPerHour: number;
}

const ONE_HOUR_MS = 60 * 60 * 1000; // 3,600,000 ms

/**
 * Checks and consumes a rate limit token for an outbound sender using a sliding window in Redis.
 * Ensures strict persistence without relying on ephemeral in-memory state.
 */
export async function checkAndConsumeRateLimit(
  senderId: string,
  limitPerHour: number,
  uniqueToken: string
): Promise<RateLimitResult> {
  const key = `ratelimit:sender:${senderId}`;
  const now = Date.now();
  const windowStart = now - ONE_HOUR_MS;

  // 1. Evict entries that fell outside the 1-hour sliding window
  await redisClient.zremrangebyscore(key, 0, windowStart);

  // 2. Count requests dispatched in the current 1-hour window
  const currentCount = await redisClient.zcard(key);

  if (currentCount >= limitPerHour) {
    // Find the oldest member in the current window to determine when a slot reopens
    const oldestMembers = await redisClient.zrange(key, 0, '0');
    let retryDelayMs = ONE_HOUR_MS;

    if (oldestMembers.length > 0 && oldestMembers[0]) {
      const oldestScore = await redisClient.zscore(key, oldestMembers[0]);
      if (oldestScore) {
        const oldestTimestamp = parseFloat(oldestScore);
        const nextAvailableTime = oldestTimestamp + ONE_HOUR_MS;
        retryDelayMs = Math.max(2000, nextAvailableTime - now + 200); // 200ms buffer
      }
    }

    return {
      allowed: false,
      retryDelayMs,
      currentCount,
      limitPerHour,
    };
  }

  // 3. Under limit: register this send action in the sliding window
  await redisClient.zadd(key, now, `${uniqueToken}:${now}`);
  // Set safety TTL of 2 hours so empty keys don't linger indefinitely
  await redisClient.expire(key, 7200);

  return {
    allowed: true,
    currentCount: currentCount + 1,
    limitPerHour,
  };
}
