import { Queue } from 'bullmq';
import { redisConnection } from '../config/redis';

export interface EmailJobData {
  emailId: string;
  batchId: string;
  userId: string;
  senderId: string;
  recipient: string;
}

export const EMAIL_QUEUE_NAME = 'email-dispatch-queue';

/**
 * BullMQ Queue instance for delayed and persistent email delivery jobs.
 * Each job uses the Email entity's UUID as its stable jobId for idempotency.
 */
export const emailQueue = new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 3000,
    },
    removeOnComplete: {
      count: 1000,
      age: 24 * 3600,
    },
    removeOnFail: {
      count: 2000,
      age: 7 * 24 * 3600,
    },
  },
});
