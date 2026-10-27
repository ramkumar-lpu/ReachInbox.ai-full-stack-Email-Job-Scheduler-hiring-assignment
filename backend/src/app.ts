import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { healthRouter } from './routes/health';
import { emailRouter } from './routes/emailRoutes';
import { authRouter, slackRouter } from './routes/authRoutes';
import { emailQueue } from './queues/emailQueue';
import { authenticateUser, optionalAuthenticate } from './services/authService';
import { initElasticsearch } from './services/searchService';
import { env } from './config/env';

export const app = express();

// Trust Caddy reverse proxy headers (X-Forwarded-Proto, X-Forwarded-For)
// Crucial for secure cookie transmission and accurate client IP logging behind Caddy
app.set('trust proxy', 1);

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

/**
 * HTTP Basic Authentication middleware for Bull Board queue dashboard.
 * - Fails closed in production if ADMIN_PASSWORD is missing or weak.
 * - Compares credentials using constant-time comparison to mitigate timing attacks.
 */
function adminAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  // If admin dashboard is disabled via env
  if (!env.ADMIN_ENABLED) {
    res.status(403).json({
      status: 'error',
      message: 'Admin queue dashboard is disabled by administrator policy.',
    });
    return;
  }

  // In production, strictly require configured credentials and fail closed if missing
  if (env.NODE_ENV === 'production') {
    if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8) {
      console.warn('⚠️ [Bull Board Blocked] Production access blocked: ADMIN_PASSWORD is missing or too short.');
      res.status(503).json({
        status: 'error',
        message: 'Admin queue dashboard is disabled: admin credentials are not properly configured.',
      });
      return;
    }
  }

  const expectedUser = env.ADMIN_USERNAME || 'admin';
  const expectedPass = env.ADMIN_PASSWORD || (env.NODE_ENV === 'production' ? '' : 'admin');

  if (!expectedPass) {
    res.status(503).json({
      status: 'error',
      message: 'Admin dashboard credentials not configured.',
    });
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="ReachInbox Admin Queues"');
    res.status(401).send('Authentication required to access queue dashboard.');
    return;
  }

  try {
    const b64Credentials = authHeader.split(' ')[1] || '';
    const decoded = Buffer.from(b64Credentials, 'base64').toString('utf-8');
    const colonIndex = decoded.indexOf(':');

    if (colonIndex === -1) {
      res.setHeader('WWW-Authenticate', 'Basic realm="ReachInbox Admin Queues"');
      res.status(401).send('Invalid basic authentication format.');
      return;
    }

    const username = decoded.slice(0, colonIndex);
    const password = decoded.slice(colonIndex + 1);

    // Constant-time comparison
    const maxLen = 128;
    const userBuf = Buffer.from(username.padEnd(maxLen, ' '));
    const expUserBuf = Buffer.from(expectedUser.padEnd(maxLen, ' '));
    const passBuf = Buffer.from(password.padEnd(maxLen, ' '));
    const expPassBuf = Buffer.from(expectedPass.padEnd(maxLen, ' '));

    const userValid = username === expectedUser && crypto.timingSafeEqual(userBuf, expUserBuf);
    const passValid = password === expectedPass && crypto.timingSafeEqual(passBuf, expPassBuf);

    if (userValid && passValid) {
      return next();
    }
  } catch (err) {
    console.warn('[Bull Board Auth Error]', err);
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="ReachInbox Admin Queues"');
  res.status(401).send('Invalid administrator credentials.');
}

// Bull Board Queue Dashboard setup at /admin/queues with HTTP Basic Auth
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter: serverAdapter,
});

app.use('/admin/queues', adminAuthMiddleware, serverAdapter.getRouter());

// Public health checks (includes /health, /health/live, /health/ready)
app.use('/health', healthRouter);

// Authentication & Integration routes
// /api/auth routes: public endpoints like /google, /callback, /logout work; /me checks session
app.use('/api/auth', optionalAuthenticate, authRouter);
app.use('/api/slack', authenticateUser, slackRouter);

// Email Scheduler API routes (strictly authenticated)
app.use('/api/emails', authenticateUser, emailRouter);

// Conditionally initialize Elasticsearch index on startup
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
  const isDevelopment = env.NODE_ENV !== 'production';

  res.status(500).json({
    status: 'error',
    message: isDevelopment ? err.message : 'Internal Server Error',
    ...(isDevelopment && { stack: err.stack }),
  });
});
