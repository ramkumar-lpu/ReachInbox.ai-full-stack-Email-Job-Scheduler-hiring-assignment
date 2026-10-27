import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { healthRouter } from './routes/health';
import { emailRouter } from './routes/emailRoutes';
import { authRouter, slackRouter } from './routes/authRoutes';
import { emailQueue } from './queues/emailQueue';
import { authenticateUser } from './services/authService';
import { initElasticsearch } from './services/searchService';

export const app = express();

// Security and utility middleware
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(cookieParser());
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

// Public health check
app.use('/health', healthRouter);

// Authentication & Integration routes
app.use('/api/auth', authenticateUser, authRouter);
app.use('/api/slack', authenticateUser, slackRouter);

// Email Scheduler API routes (authenticated)
app.use('/api/emails', authenticateUser, emailRouter);

// Initialize Elasticsearch index on startup
void initElasticsearch();

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
