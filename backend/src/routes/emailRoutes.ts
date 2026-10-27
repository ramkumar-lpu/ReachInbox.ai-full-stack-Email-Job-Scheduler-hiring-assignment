import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { emailQueue } from '../queues/emailQueue';
import { indexEmail, searchEmailsInEs } from '../services/searchService';
import { getOrCreateDemoUser } from '../services/authService';
import { env } from '../config/env';

export const emailRouter = Router();

/**
 * Validation schema for scheduling a batch of emails.
 */
const scheduleEmailSchema = z.object({
  senderId: z.string().uuid().optional(),
  subject: z.string().min(1, 'Subject cannot be empty'),
  body: z.string().min(1, 'Body cannot be empty'),
  recipients: z
    .array(z.string().email('Invalid email address format'))
    .min(1, 'At least one valid recipient email is required'),
  startTime: z.string().datetime({ offset: true }).optional(),
  delaySeconds: z.coerce.number().int().min(0).default(0),
  hourlyLimit: z.coerce.number().int().min(1).max(1000).default(50),
  sendNow: z.boolean().default(false),
});

/**
 * Helper to resolve the authenticated user.
 * In Demo Mode:
 * - Automatically falls back to getOrCreateDemoUser() for seamless review.
 * In production:
 * - Strictly requires req.user (attached by authenticateUser middleware).
 * - Never creates or falls back to dev@reachinbox.test when DEMO_MODE is false.
 * In development:
 * - Falls back to dev user only when ALLOW_DEV_AUTH is explicitly true.
 */
async function resolveUser(req: Request): Promise<any | null> {
  const user = (req as any).user;
  if (user) return user;

  // In demo mode, use persistent demo reviewer user
  if (env.DEMO_MODE) {
    return getOrCreateDemoUser();
  }

  // In production, never bypass authentication
  if (env.NODE_ENV === 'production') {
    return null;
  }

  // In non-production, only fall back if explicitly permitted
  if (env.ALLOW_DEV_AUTH) {
    return prisma.user.upsert({
      where: { email: 'dev@reachinbox.test' },
      update: {},
      create: {
        email: 'dev@reachinbox.test',
        name: 'ReachInbox Development User',
        avatarUrl: 'https://avatar.iran.liara.run/public/boy',
      },
    });
  }

  return null;
}

/**
 * GET /api/emails/senders
 * Returns active senders (sensitive credentials strictly excluded).
 */
emailRouter.get('/senders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Authentication required.',
      });
      return;
    }

    const senders = await prisma.sender.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        email: true,
        smtpHost: true,
        smtpPort: true,
        smtpUsername: true,
        hourlyLimit: true,
        createdAt: true,
      },
    });

    res.status(200).json({
      success: true,
      data: senders,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/emails/search
 * Full-text search across emails powered by Elasticsearch 8 with DB fallback
 */
emailRouter.get('/search', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Authentication required.',
      });
      return;
    }

    const query = (req.query.q as string) || '';
    const status = req.query.status as string | undefined;

    // Search Elasticsearch if enabled
    let esResults: any[] = [];
    if (env.ELASTICSEARCH_ENABLED) {
      esResults = await searchEmailsInEs(user.id, query, status);
    }

    if (esResults && esResults.length > 0) {
      res.status(200).json({
        success: true,
        source: 'elasticsearch',
        count: esResults.length,
        data: esResults,
      });
      return;
    }

    // Fallback to PostgreSQL relational search if ES is disabled or yields no results
    const dbResults = await prisma.email.findMany({
      where: {
        userId: user.id,
        ...(status && { status: status as any }),
        ...(query && {
          OR: [
            { subject: { contains: query, mode: 'insensitive' } },
            { recipient: { contains: query, mode: 'insensitive' } },
            { body: { contains: query, mode: 'insensitive' } },
          ],
        }),
      },
      include: {
        sender: {
          select: { id: true, email: true, smtpHost: true },
        },
      },
      orderBy: { scheduledAt: 'desc' },
      take: 50,
    });

    res.status(200).json({
      success: true,
      source: 'database',
      count: dbResults.length,
      data: dbResults,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Shared handler for both /schedule and /send-now.
 * Validates, records batch & emails in PostgreSQL, conditionally indexes into ES,
 * and enqueues BullMQ jobs (immediate without intentional delay if sendNow is true, delayed otherwise).
 */
async function handleScheduleOrSend(
  req: Request,
  res: Response,
  next: NextFunction,
  forceSendNow?: boolean
) {
  try {
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Authentication required.',
      });
      return;
    }

    const validated = scheduleEmailSchema.parse(req.body);
    const isSendNow = forceSendNow ?? (validated.sendNow || !validated.startTime);

    // 1. Resolve sender
    let sender = null;
    if (validated.senderId) {
      sender = await prisma.sender.findFirst({
        where: { id: validated.senderId, userId: user.id },
      });
      if (!sender) {
        res.status(404).json({
          success: false,
          error: `Sender with ID "${validated.senderId}" not found for this tenant.`,
        });
        return;
      }
    } else {
      sender = await prisma.sender.findFirst({
        where: { userId: user.id },
      });
      if (!sender) {
        res.status(400).json({
          success: false,
          error: 'No sender configured. Please create a sender first.',
        });
        return;
      }
    }

    // 2. Deduplicate recipients list
    const uniqueRecipients = Array.from(new Set(validated.recipients));

    // 3. Determine start time
    const baseTime = isSendNow
      ? new Date()
      : validated.startTime
      ? new Date(validated.startTime)
      : new Date();
    const effectiveStartTime = isNaN(baseTime.getTime()) ? new Date() : baseTime;

    // 4. Create EmailBatch record in PostgreSQL
    const batch = await prisma.emailBatch.create({
      data: {
        userId: user.id,
        subject: validated.subject,
        body: validated.body,
        startTime: effectiveStartTime,
        delaySeconds: validated.delaySeconds,
        hourlyLimit: validated.hourlyLimit,
        totalRecipients: uniqueRecipients.length,
      },
    });

    const scheduledEmails = [];

    // 5. Persist Email records and schedule BullMQ jobs
    for (let i = 0; i < uniqueRecipients.length; i++) {
      const recipient = uniqueRecipients[i]!;

      // Calculate scheduled time:
      // If sendNow is true:
      // - First recipient has scheduledAt = effectiveStartTime (now)
      // - Subsequent recipients pace out if delaySeconds > 0
      // If scheduled:
      // - Starts from effectiveStartTime + (i * delaySeconds)
      const interEmailOffsetMs = i * validated.delaySeconds * 1000;
      const scheduledAt = new Date(effectiveStartTime.getTime() + interEmailOffsetMs);

      // Create individual PostgreSQL email row with initial status 'scheduled'
      // Note: Send Now starts in 'scheduled' and transitions to 'processing' -> 'sent'
      // when the worker delivers it, ensuring it is never falsely marked sent.
      const email = await prisma.email.create({
        data: {
          batchId: batch.id,
          userId: user.id,
          senderId: sender.id,
          recipient,
          subject: validated.subject,
          body: validated.body,
          scheduledAt,
          status: 'scheduled',
          bullmqJobId: null,
        },
      });

      // Calculate delay relative to now
      // If sendNow and recipient 0: delayMs is strictly 0 (no future delay)
      let delayMs = 0;
      if (isSendNow) {
        delayMs = i === 0 ? 0 : Math.max(0, scheduledAt.getTime() - Date.now());
      } else {
        delayMs = Math.max(0, scheduledAt.getTime() - Date.now());
      }

      // BullMQ job options:
      // For immediate jobs (delayMs === 0), omit delay so BullMQ places it in the 'wait' queue directly.
      const jobOptions: { jobId: string; delay?: number } = {
        jobId: email.id, // Stable idempotency identifier
      };
      if (delayMs > 0) {
        jobOptions.delay = delayMs;
      }

      await emailQueue.add(
        'send-email',
        {
          emailId: email.id,
          batchId: batch.id,
          userId: user.id,
          senderId: sender.id,
          recipient: email.recipient,
        },
        jobOptions
      );

      // Link job ID back to email record
      await prisma.email.update({
        where: { id: email.id },
        data: { bullmqJobId: email.id },
      });

      // Index into Elasticsearch if enabled (non-blocking, never fails scheduling)
      if (env.ELASTICSEARCH_ENABLED) {
        void indexEmail({
          id: email.id,
          userId: user.id,
          senderId: sender.id,
          senderEmail: sender.email,
          recipient: email.recipient,
          subject: email.subject,
          body: email.body,
          status: email.status,
          scheduledAt: email.scheduledAt,
          createdAt: email.createdAt,
        }).catch((err) => {
          console.warn(`⚠️ [ES Indexing Non-fatal Error] Email ${email.id}:`, (err as Error).message);
        });
      }

      scheduledEmails.push({
        id: email.id,
        recipient: email.recipient,
        scheduledAt: email.scheduledAt,
        status: email.status,
      });
    }

    res.status(201).json({
      success: true,
      message: isSendNow
        ? `Successfully queued ${scheduledEmails.length} email(s) for immediate delivery.`
        : `Successfully scheduled ${scheduledEmails.length} email(s).`,
      batchId: batch.id,
      scheduledCount: scheduledEmails.length,
      sendNow: isSendNow,
      emails: scheduledEmails,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: 'Validation failed',
        details: err.format(),
      });
      return;
    }
    next(err);
  }
}

/**
 * POST /api/emails/schedule
 * Validates, records batch & emails in PostgreSQL, conditionally indexes into ES,
 * and enqueues BullMQ jobs (delayed for scheduled sends, immediate if sendNow: true).
 */
emailRouter.post('/schedule', async (req: Request, res: Response, next: NextFunction) => {
  await handleScheduleOrSend(req, res, next);
});

/**
 * POST /api/emails/send-now
 * Dedicated endpoint for immediate dispatch.
 * Enqueues emails for immediate BullMQ processing without delay.
 */
emailRouter.post('/send-now', async (req: Request, res: Response, next: NextFunction) => {
  await handleScheduleOrSend(req, res, next, true);
});

/**
 * GET /api/emails/scheduled
 * Retrieves all emails in 'scheduled' or 'processing' states.
 */
emailRouter.get('/scheduled', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Authentication required.',
      });
      return;
    }

    const emails = await prisma.email.findMany({
      where: {
        userId: user.id,
        status: { in: ['scheduled', 'processing'] },
      },
      include: {
        sender: {
          select: {
            id: true,
            email: true,
            smtpHost: true,
            hourlyLimit: true,
          },
        },
        batch: {
          select: {
            id: true,
            startTime: true,
            delaySeconds: true,
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
    });

    res.status(200).json({
      success: true,
      count: emails.length,
      data: emails,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/emails/sent
 * Retrieves all emails in 'sent' or 'failed' states.
 */
emailRouter.get('/sent', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await resolveUser(req);
    if (!user) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized: Authentication required.',
      });
      return;
    }

    const emails = await prisma.email.findMany({
      where: {
        userId: user.id,
        status: { in: ['sent', 'failed'] },
      },
      include: {
        sender: {
          select: {
            id: true,
            email: true,
            smtpHost: true,
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    res.status(200).json({
      success: true,
      count: emails.length,
      data: emails,
    });
  } catch (err) {
    next(err);
  }
});
