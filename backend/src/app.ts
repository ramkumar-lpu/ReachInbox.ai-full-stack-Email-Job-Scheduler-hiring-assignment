import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { healthRouter } from './routes/health';
import { emailRouter } from './routes/emailRoutes';
import { emailQueue } from './queues/emailQueue';

export const app = express();

// Security and utility middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Bull Board Queue Dashboard setup at /admin/queues
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter: serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());

// API Routes
app.use('/health', healthRouter);
app.use('/api/emails', emailRouter);

// 404 handler for undefined routes
app.use((req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

// Centralized error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[App Error]', err);
  const isDevelopment = process.env.NODE_ENV !== 'production';

  res.status(500).json({
    status: 'error',
    message: isDevelopment ? err.message : 'Internal Server Error',
    ...(isDevelopment && { stack: err.stack }),
  });
});
