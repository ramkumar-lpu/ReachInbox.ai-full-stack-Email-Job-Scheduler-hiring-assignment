import { Router, Request, Response } from 'express';
import { prisma } from '../db/client';
import { redisClient } from '../config/redis';
import { env } from '../config/env';
import { checkEsHealth } from '../services/searchService';

export const healthRouter = Router();

interface DependencyStatus {
  status: 'connected' | 'disconnected' | 'disabled';
  latencyMs?: number;
  error?: string;
}

/**
 * Liveness Probe: GET /health/live
 * Fast, non-blocking check to confirm the Node.js process is active and accepting requests.
 */
healthRouter.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    check: 'liveness',
    service: 'reachinbox-scheduler-backend',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});

/**
 * Readiness Probe: GET /health/ready
 * Thorough dependency check for core operational prerequisites (PostgreSQL & Redis).
 * Returns HTTP 200 when ready, or HTTP 503 when core dependencies are unavailable.
 */
healthRouter.get('/ready', async (_req: Request, res: Response) => {
  const result = await evaluateReadiness();
  const statusCode = result.isReady ? 200 : 503;

  res.status(statusCode).json({
    status: result.isReady ? 'ready' : 'unhealthy',
    check: 'readiness',
    service: 'reachinbox-scheduler-backend',
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    dependencies: result.dependencies,
  });
});

/**
 * Primary / Backward-Compatible Probe: GET /health
 * Validates core service readiness before returning healthy status.
 */
healthRouter.get('/', async (_req: Request, res: Response) => {
  const result = await evaluateReadiness();
  const statusCode = result.isReady ? 200 : 503;

  res.status(statusCode).json({
    status: result.isReady ? 'ok' : 'unhealthy',
    service: 'reachinbox-scheduler-backend',
    environment: env.NODE_ENV,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    dependencies: result.dependencies,
  });
});

/**
 * Performs non-destructive connectivity verification against PostgreSQL, Redis, and Elasticsearch.
 * Strictly sanitizes output: never logs or leaks credentials, passwords, or connection URIs.
 */
async function evaluateReadiness(): Promise<{
  isReady: boolean;
  dependencies: {
    postgres: DependencyStatus;
    redis: DependencyStatus;
    elasticsearch: DependencyStatus;
  };
}> {
  // 1. PostgreSQL Verification (Query SELECT 1 with 3-second timeout)
  let postgresStatus: DependencyStatus = { status: 'disconnected' };
  try {
    const pgStart = Date.now();
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('PostgreSQL check timed out')), 3000)
      ),
    ]);
    postgresStatus = {
      status: 'connected',
      latencyMs: Date.now() - pgStart,
    };
  } catch (err: unknown) {
    const isTimeout = (err as Error).message.includes('timed out');
    postgresStatus = {
      status: 'disconnected',
      error: isTimeout ? 'Connection timed out' : 'Database query failed',
    };
  }

  // 2. Redis Verification (PING command with 3-second timeout)
  let redisStatus: DependencyStatus = { status: 'disconnected' };
  try {
    const redisStart = Date.now();
    const pingResponse = await Promise.race([
      redisClient.ping(),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('Redis ping timed out')), 3000)
      ),
    ]);

    if (pingResponse === 'PONG') {
      redisStatus = {
        status: 'connected',
        latencyMs: Date.now() - redisStart,
      };
    } else {
      redisStatus = {
        status: 'disconnected',
        error: 'Unexpected response from Redis',
      };
    }
  } catch (err: unknown) {
    const isTimeout = (err as Error).message.includes('timed out');
    redisStatus = {
      status: 'disconnected',
      error: isTimeout ? 'Ping timed out' : 'Connection failed',
    };
  }

  // 3. Optional Elasticsearch Verification
  const esStatus = await checkEsHealth();

  // Core prerequisites: PostgreSQL and Redis must both be connected
  const isReady = postgresStatus.status === 'connected' && redisStatus.status === 'connected';

  return {
    isReady,
    dependencies: {
      postgres: postgresStatus,
      redis: redisStatus,
      elasticsearch: esStatus,
    },
  };
}
