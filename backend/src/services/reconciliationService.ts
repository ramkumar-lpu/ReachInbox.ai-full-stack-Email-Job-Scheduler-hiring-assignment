import { prisma } from '../db/client';
import { emailQueue } from '../queues/emailQueue';

/**
 * Reconciles the database state with the BullMQ delayed queue on system startup.
 * Restores any jobs for pending/scheduled records that may have been lost if Redis was
 * restarted or if the server crashed before scheduling completed.
 */
export async function reconcilePendingJobs(): Promise<{
  scanned: number;
  restored: number;
}> {
  console.log('🔄 [Reconciliation] Checking for pending database records missing from BullMQ...');

  const pendingEmails = await prisma.email.findMany({
    where: {
      status: {
        in: ['scheduled', 'processing'],
      },
    },
  });

  let restoredCount = 0;

  for (const email of pendingEmails) {
    try {
      const existingJob = await emailQueue.getJob(email.id);

      if (!existingJob) {
        const delay = Math.max(0, email.scheduledAt.getTime() - Date.now());

        // If email was stuck in 'processing' when the server died, reset it to 'scheduled'
        if (email.status === 'processing') {
          await prisma.email.update({
            where: { id: email.id },
            data: { status: 'scheduled' },
          });
        }

        await emailQueue.add(
          'send-email',
          {
            emailId: email.id,
            batchId: email.batchId,
            userId: email.userId,
            senderId: email.senderId,
            recipient: email.recipient,
          },
          {
            jobId: email.id,
            delay,
          }
        );

        restoredCount++;
        console.log(
          `   ↪ Restored job for email ${email.id} (recipient: ${email.recipient}, delay: ${delay}ms)`
        );
      }
    } catch (err) {
      console.error(
        `❌ [Reconciliation Error] Failed to restore job for email ${email.id}:`,
        err
      );
    }
  }

  console.log(
    `✅ [Reconciliation Complete] Scanned: ${pendingEmails.length}, Restored: ${restoredCount}\n`
  );

  return {
    scanned: pendingEmails.length,
    restored: restoredCount,
  };
}
