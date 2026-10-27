import http from 'http';
import { Worker } from 'bullmq';
import { app } from './app';
import { env } from './config/env';
import { prisma } from './db/client';
import { redisClient, redisConnection } from './config/redis';
import { reconcilePendingJobs } from './services/reconciliationService';
import { createEmailWorker } from './workers/emailWorker';

const server = http.createServer(app);
let activeWorker: Worker | null = null;

// Start listening
server.listen(env.PORT, async () => {
  console.log(`=======================================================`);
  console.log(`🚀 ReachInbox Scheduler Backend started`);
  console.log(`📡 Environment: ${env.NODE_ENV}`);
  console.log(`🌐 Port:        ${env.PORT}`);
  console.log(`🩺 Health:      http://localhost:${env.PORT}/health`);
  console.log(`📊 Bull Board:  http://localhost:${env.PORT}/admin/queues`);
  console.log(`=======================================================`);

  // Run startup reconciliation and launch background worker if enabled
  if (env.EMBEDDED_WORKER) {
    try {
      await reconcilePendingJobs();
      activeWorker = createEmailWorker();
    } catch (err) {
      console.error('[Server] Failed to initialize embedded email worker:', err);
    }
  }
});

// Server shutdown state
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`\n[Server] Received ${signal}. Initiating graceful shutdown...`);

  if (activeWorker) {
    try {
      await activeWorker.close();
      console.log('[Server] Embedded worker closed cleanly.');
    } catch (wErr) {
      console.error('[Server] Error closing worker:', wErr);
    }
  }

  // Stop accepting new connections
  server.close(async (err) => {
    if (err) {
      console.error('[Server] Error while closing HTTP server:', err);
      process.exit(1);
    }
    try {
      await prisma.$disconnect();
      redisClient.disconnect();
      redisConnection.disconnect();
      console.log('[Server] Database and Redis connections closed cleanly.');
    } catch (dbErr) {
      console.error('[Server] Error disconnecting clients:', dbErr);
    }
    console.log('[Server] HTTP server closed cleanly. Exiting.');
    process.exit(0);
  });

  // Force process exit if connections take too long to close
  const forceExitTimeout = setTimeout(() => {
    console.error('[Server] Forced shutdown: connections did not close in time.');
    process.exit(1);
  }, 10000);

  // Unref ensures this timer alone won't keep the event loop alive
  forceExitTimeout.unref();
};

// Process signal listeners
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

// Process error listeners
process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Server] Unhandled Promise Rejection:', reason);
  void gracefulShutdown('unhandledRejection');
});

process.on('uncaughtException', (error: Error) => {
  console.error('[Server] Uncaught Exception:', error);
  void gracefulShutdown('uncaughtException');
});
