import { Worker, DelayedError } from 'bullmq';
import { redisConnection } from '../config/redis';
import { EMAIL_QUEUE_NAME, EmailJobData } from '../queues/emailQueue';
import { prisma } from '../db/client';
import { checkAndConsumeRateLimit } from '../services/rateLimiter';
import { sendEmailViaSmtp } from '../services/emailService';
import { updateEmailInEs } from '../services/searchService';
import { env } from '../config/env';

/**
 * Creates and initializes the BullMQ Email Worker.
 * Features:
 * - Fresh reads from PostgreSQL before sending
 * - Redis-backed sliding window hourly rate limiting with automatic rescheduling
 * - Status lifecycle transitions: scheduled -> processing -> sent / failed
 * - Configurable concurrency and inter-message send delay
 */
export function createEmailWorker(): Worker<EmailJobData> {
  const worker = new Worker<EmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job, token) => {
      const { emailId } = job.data;
      console.log(`\n📨 [Worker Processing] Job ${job.id} for Email ${emailId}...`);

      // 1. Fetch fresh record from PostgreSQL
      const email = await prisma.email.findUnique({
        where: { id: emailId },
        include: { sender: true },
      });

      if (!email) {
        console.warn(`⚠️ [Worker] Email record ${emailId} not found in DB. Discarding.`);
        return;
      }

      if (email.status === 'sent') {
        console.log(`ℹ️ [Worker] Email ${emailId} is already marked sent. Skipping.`);
        return;
      }

      // 2. Redis-backed Hourly Rate Limit Enforcement
      const rateLimitCheck = await checkAndConsumeRateLimit(
        email.sender.id,
        email.sender.hourlyLimit,
        email.id
      );

      if (!rateLimitCheck.allowed) {
        const retryDelayMs = rateLimitCheck.retryDelayMs ?? 60000;
        const rescheduleAt = new Date(Date.now() + retryDelayMs);

        console.log(
          `⏳ [Rate Limit Hit] Sender "${email.sender.email}" reached hourly capacity (${rateLimitCheck.currentCount}/${rateLimitCheck.limitPerHour}).`
        );
        console.log(
          `   Rescheduling email ${email.id} to run at ${rescheduleAt.toISOString()} (in ${Math.round(retryDelayMs / 1000)}s)...`
        );

        // Update database to maintain truthful scheduledAt timestamp
        await prisma.email.update({
          where: { id: email.id },
          data: {
            scheduledAt: rescheduleAt,
            status: 'scheduled',
          },
        });

        // Delay job in BullMQ without marking as failed
        await job.moveToDelayed(Date.now() + retryDelayMs, token!);
        throw new DelayedError();
      }

      // 3. Mark status -> 'processing' in PostgreSQL
      await prisma.email.update({
        where: { id: email.id },
        data: {
          status: 'processing',
          attemptCount: { increment: 1 },
        },
      });
      void updateEmailInEs(email.id, { status: 'processing' });

      // 4. Configurable minimum send delay buffer
      if (env.MIN_SEND_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, env.MIN_SEND_DELAY_MS));
      }

      // 5. Attempt SMTP Dispatch
      try {
        const sendResult = await sendEmailViaSmtp(email, email.sender);

        // SMTP acknowledged delivery: Transition status -> 'sent'
        await prisma.email.update({
          where: { id: email.id },
          data: {
            status: 'sent',
            sentAt: new Date(),
            error: null,
          },
        });
        void updateEmailInEs(email.id, { status: 'sent', sentAt: new Date() });

        console.log(`✅ [Worker Sent] Email ${email.id} successfully sent to <${email.recipient}>`);
        if (sendResult.previewUrl) {
          console.log(`   🔗 Ethereal Preview: ${sendResult.previewUrl}`);
        }
      } catch (err: unknown) {
        const errorObj = err as Error;
        const errorMessage = errorObj?.message || 'Unknown SMTP Dispatch Error';
        const willRetry = job.attemptsMade < (job.opts.attempts || 3) - 1;

        console.error(
          `❌ [Worker Send Failed] Email ${email.id} to <${email.recipient}> (Attempt ${job.attemptsMade + 1}/${job.opts.attempts}): ${errorMessage}`
        );

        // Update PostgreSQL with the error message and status
        await prisma.email.update({
          where: { id: email.id },
          data: {
            status: willRetry ? 'scheduled' : 'failed',
            error: errorMessage,
          },
        });
        void updateEmailInEs(email.id, {
          status: willRetry ? 'scheduled' : 'failed',
          error: errorMessage,
        });

        // Re-throw so BullMQ executes exponential backoff
        throw err;
      }
    },
    {
      connection: redisConnection,
      concurrency: env.WORKER_CONCURRENCY,
    }
  );

  worker.on('failed', (job, err) => {
    if (err.name !== 'DelayedError') {
      console.error(`💥 [BullMQ Job Failed] Job ${job?.id}:`, err.message);
    }
  });

  worker.on('error', (err) => {
    console.error('💥 [BullMQ Worker Error]:', err.message);
  });

  console.log(
    `⚙️  [Email Worker] Active (Concurrency: ${env.WORKER_CONCURRENCY}, Min Delay: ${env.MIN_SEND_DELAY_MS}ms)`
  );

  return worker;
}
