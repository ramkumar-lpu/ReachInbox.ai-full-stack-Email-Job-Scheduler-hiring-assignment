import Redis, { RedisOptions } from 'ioredis';
import { env } from './env';

/**
 * Standard Redis options for BullMQ compatibility.
 * BullMQ requires maxRetriesPerRequest: null.
 */
export const redisOptions: RedisOptions = {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

/**
 * Shared Redis connection instance for BullMQ queue operations
 */
export const redisConnection = new Redis(env.REDIS_URL, redisOptions);

/**
 * Dedicated Redis client for rate limiting and general key-value operations
 */
export const redisClient = new Redis(env.REDIS_URL, {
  enableReadyCheck: true,
  maxRetriesPerRequest: 20,
});

redisConnection.on('error', (err) => {
  console.error('[Redis BullMQ Connection Error]:', err.message);
});

redisClient.on('error', (err) => {
  console.error('[Redis Client Error]:', err.message);
});
