import { createEmailWorker } from './workers/emailWorker';
import { reconcilePendingJobs } from './services/reconciliationService';
import { prisma } from './db/client';
import { redisClient, redisConnection } from './config/redis';

async function startStandaloneWorker() {
  console.log('=======================================================');
  console.log('🚀 ReachInbox Standalone Email Worker starting...');
  console.log('=======================================================');

  // Run startup reconciliation before processing
  await reconcilePendingJobs();

  // Start worker
  const worker = createEmailWorker();

  const shutdown = async (signal: string) => {
    console.log(`\n[Worker] Received ${signal}. Shutting down worker...`);
    await worker.close();
    await prisma.$disconnect();
    redisClient.disconnect();
    redisConnection.disconnect();
    console.log('[Worker] Worker closed cleanly.');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

startStandaloneWorker().catch((err) => {
  console.error('Fatal error starting standalone worker:', err);
  process.exit(1);
});
