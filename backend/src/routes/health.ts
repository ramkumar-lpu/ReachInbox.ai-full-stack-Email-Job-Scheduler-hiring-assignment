import { Router, Request, Response } from 'express';

export const healthRouter = Router();

/**
 * GET /health
 * Returns service status, current timestamp, and server uptime.
 */
healthRouter.get('/', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    service: 'reachinbox-scheduler-backend',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
  });
});
