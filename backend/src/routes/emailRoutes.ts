import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma } from '../db/client';
import { emailQueue } from '../queues/emailQueue';

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
});

/**
 * Helper to ensure a development tenant user exists
 */
async function getOrCreateDevUser() {
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

/**
 * GET /api/senders
 * Returns active senders (sensitive credentials strictly excluded).
 */
emailRouter.get('/senders', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getOrCreateDevUser();
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
 * POST /api/emails/schedule
 * Validates, records batch & emails in PostgreSQL, and enqueues delayed BullMQ jobs.
 */
emailRouter.post('/schedule', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validated = scheduleEmailSchema.parse(req.body);
    const user = await getOrCreateDevUser();

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
          error: 'No sender configured. Please run database seed or create a sender first.',
        });
        return;
      }
    }

    // 2. Deduplicate recipients list
    const uniqueRecipients = Array.from(new Set(validated.recipients));

    // 3. Determine start time
    const baseTime = validated.startTime ? new Date(validated.startTime) : new Date();
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

    // 5. Persist Email records and schedule BullMQ delayed jobs
    for (let i = 0; i < uniqueRecipients.length; i++) {
      const recipient = uniqueRecipients[i]!;
      // Calculate scheduled time with incremental delay: T + (i * delaySeconds)
      const scheduledAt = new Date(
        effectiveStartTime.getTime() + i * validated.delaySeconds * 1000
      );

      // Create individual PostgreSQL email row
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
          bullmqJobId: null, // Will be set to email.id below
        },
      });

      // Calculate initial delay relative to now
      const delayMs = Math.max(0, scheduledAt.getTime() - Date.now());

      // Create delayed BullMQ job with stable UUID jobId
      await emailQueue.add(
        'send-email',
        {
          emailId: email.id,
          batchId: batch.id,
          userId: user.id,
          senderId: sender.id,
          recipient: email.recipient,
        },
        {
          jobId: email.id, // Stable idempotency identifier
          delay: delayMs,
        }
      );

      // Link job ID back to email record
      await prisma.email.update({
        where: { id: email.id },
        data: { bullmqJobId: email.id },
      });

      scheduledEmails.push({
        id: email.id,
        recipient: email.recipient,
        scheduledAt: email.scheduledAt,
        status: email.status,
      });
    }

    res.status(201).json({
      success: true,
      message: `Successfully scheduled ${scheduledEmails.length} email(s).`,
      batchId: batch.id,
      scheduledCount: scheduledEmails.length,
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
});

/**
 * GET /api/emails/scheduled
 * Retrieves all emails in 'scheduled' or 'processing' states.
 */
emailRouter.get('/scheduled', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getOrCreateDevUser();

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
emailRouter.get('/sent', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await getOrCreateDevUser();

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
