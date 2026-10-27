import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import nodemailer from 'nodemailer';
import { app } from '../src/app';
import { prisma } from '../src/db/client';
import { emailQueue } from '../src/queues/emailQueue';
import { redisClient, redisConnection } from '../src/config/redis';
import { signToken } from '../src/services/authService';
import { createEmailWorker } from '../src/workers/emailWorker';

describe('ReachInbox Email Dispatch: Send Now vs. Scheduled Flows', () => {
  let server: http.Server;
  let baseUrl: string;
  let testUser: any;
  let testSender: any;
  let authToken: string;
  const originalCreateTransport = nodemailer.createTransport;
  const deliveredMockEmails: any[] = [];
  let shouldMockFail = false;

  before(async () => {
    // 1. Start HTTP server on ephemeral port
    await new Promise<void>((resolve) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address() as any;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });

    // 2. Setup isolated test user and sender in PostgreSQL
    testUser = await prisma.user.upsert({
      where: { email: 'scheduler-test@reachinbox.test' },
      update: {},
      create: {
        email: 'scheduler-test@reachinbox.test',
        name: 'Scheduler Test User',
      },
    });

    testSender = await prisma.sender.upsert({
      where: {
        userId_email: {
          userId: testUser.id,
          email: 'sender-test@reachinbox.test',
        },
      },
      update: {
        smtpPassword: 'live_test_valid_password_mock',
      },
      create: {
        userId: testUser.id,
        email: 'sender-test@reachinbox.test',
        smtpHost: 'smtp.mock.reachinbox.test',
        smtpPort: 587,
        smtpUsername: 'sender_test_user',
        smtpPassword: 'live_test_valid_password_mock',
        hourlyLimit: 500,
      },
    });

    authToken = signToken({ id: testUser.id, email: testUser.email });

    // 3. Mock nodemailer to prevent real network calls and record sent mail
    (nodemailer as any).createTransport = () => {
      return {
        sendMail: async (mailOptions: any) => {
          if (shouldMockFail) {
            throw new Error('Simulated SMTP connection error (mock)');
          }
          deliveredMockEmails.push(mailOptions);
          return {
            messageId: `<mock-${Date.now()}-${Math.random()}@reachinbox.test>`,
            response: '250 OK: Mock message accepted for delivery',
          };
        },
      };
    };
  });

  after(async () => {
    // Restore original nodemailer
    (nodemailer as any).createTransport = originalCreateTransport;

    // Clean up test database records
    if (testUser) {
      await prisma.email.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
      await prisma.emailBatch.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
      await prisma.sender.deleteMany({ where: { userId: testUser.id } }).catch(() => {});
      await prisma.user.delete({ where: { id: testUser.id } }).catch(() => {});
    }

    // Close server and database/redis connections
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.$disconnect();
    redisClient.disconnect();
    redisConnection.disconnect();
  });

  // =========================================================================
  // TEST 1: Send Now Flow (Immediate Dispatch via POST /api/emails/schedule with sendNow: true)
  // =========================================================================
  test('Send Now flow enqueues immediately with delay=0 and returns immediate message', async () => {
    const payload = {
      senderId: testSender.id,
      subject: 'Send Now Verification',
      body: 'Testing immediate send flow',
      recipients: ['immediate-recipient@reachinbox.test'],
      sendNow: true,
      delaySeconds: 0,
      hourlyLimit: 100,
    };

    const res = await fetch(`${baseUrl}/api/emails/schedule`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 201, 'API should respond with HTTP 201 Created');
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.sendNow, true, 'Response should confirm sendNow is true');
    assert.match(
      json.message,
      /queued 1 email\(s\) for immediate delivery/i,
      'Message must indicate immediate delivery'
    );
    assert.equal(json.emails.length, 1);

    const emailId = json.emails[0].id;

    // Verify PostgreSQL record: initial state is 'scheduled' (not prematurely 'sent')
    const dbEmail = await prisma.email.findUnique({ where: { id: emailId } });
    assert.ok(dbEmail, 'Email record must exist in DB');
    assert.equal(dbEmail.status, 'scheduled', 'Initial status must be scheduled before worker picks up');
    assert.equal(dbEmail.sentAt, null, 'sentAt must be null initially');

    // Verify BullMQ job options: delay must NOT be a future delay (delay is 0 or omitted)
    const job = await emailQueue.getJob(emailId);
    assert.ok(job, 'BullMQ job must exist in queue');
    assert.ok(
      !job.opts.delay || job.opts.delay === 0,
      `Immediate job delay must be 0 or undefined, got: ${job.opts.delay}`
    );

    // Clean up job
    await job.remove();
  });

  // =========================================================================
  // TEST 2: Send Now Route (Dedicated POST /api/emails/send-now)
  // =========================================================================
  test('Dedicated POST /api/emails/send-now forces immediate delivery', async () => {
    const payload = {
      senderId: testSender.id,
      subject: 'Send Now Route Verification',
      body: 'Testing dedicated /send-now route',
      recipients: ['sendnow-route@reachinbox.test'],
    };

    const res = await fetch(`${baseUrl}/api/emails/send-now`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 201, 'API should respond with HTTP 201 Created');
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.sendNow, true);
    assert.match(json.message, /immediate delivery/i);

    const emailId = json.emails[0].id;
    const job = await emailQueue.getJob(emailId);
    assert.ok(job, 'BullMQ job must exist');
    assert.ok(!job.opts.delay || job.opts.delay === 0);

    await job.remove();
  });

  // =========================================================================
  // TEST 3: Scheduled Flow (Future startTime with sendNow: false)
  // =========================================================================
  test('Scheduled flow respects future date/time and configures BullMQ delay > 0', async () => {
    // Schedule 1 hour in the future
    const futureDate = new Date(Date.now() + 3600 * 1000);
    const payload = {
      senderId: testSender.id,
      subject: 'Future Scheduled Email',
      body: 'Testing scheduled delivery',
      recipients: ['future-recipient@reachinbox.test'],
      startTime: futureDate.toISOString(),
      sendNow: false,
      delaySeconds: 0,
      hourlyLimit: 100,
    };

    const res = await fetch(`${baseUrl}/api/emails/schedule`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 201, 'API should respond with HTTP 201 Created');
    const json = await res.json();

    assert.equal(json.success, true);
    assert.equal(json.sendNow, false, 'sendNow should be false for scheduled emails');
    assert.match(json.message, /scheduled 1 email\(s\)/i);

    const emailId = json.emails[0].id;

    // Verify DB scheduledAt matches future date
    const dbEmail = await prisma.email.findUnique({ where: { id: emailId } });
    assert.ok(dbEmail, 'DB record must exist');
    assert.equal(dbEmail.status, 'scheduled');
    const timeDelta = Math.abs(dbEmail.scheduledAt.getTime() - futureDate.getTime());
    assert.ok(timeDelta < 2000, 'DB scheduledAt must match future date within 2s delta');

    // Verify BullMQ job delay > 0 (approximately 3600000 ms)
    const job = await emailQueue.getJob(emailId);
    assert.ok(job, 'BullMQ job must exist');
    assert.ok(
      job.opts.delay && job.opts.delay > 3500000,
      `Scheduled job delay must be > 3500s (~1 hour), got: ${job.opts.delay}ms`
    );

    // Delayed jobs are placed in the BullMQ delayed set
    const state = await job.getState();
    assert.equal(state, 'delayed', 'BullMQ job state must be "delayed"');

    await job.remove();
  });

  // =========================================================================
  // TEST 4: Multi-recipient Inter-Email Delay Pacing
  // =========================================================================
  test('Multi-recipient batch paces subsequent emails with delaySeconds', async () => {
    const payload = {
      senderId: testSender.id,
      subject: 'Batch Delivery Pacing',
      body: 'Testing batch delay',
      recipients: ['recipient1@reachinbox.test', 'recipient2@reachinbox.test'],
      sendNow: true,
      delaySeconds: 15, // 15 seconds delay between recipients
      hourlyLimit: 100,
    };

    const res = await fetch(`${baseUrl}/api/emails/schedule`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });

    assert.equal(res.status, 201);
    const json = await res.json();
    assert.equal(json.emails.length, 2);

    const [firstEmail, secondEmail] = json.emails;

    // First email has no delay (immediate)
    const job1 = await emailQueue.getJob(firstEmail.id);
    assert.ok(job1);
    assert.ok(!job1.opts.delay || job1.opts.delay === 0, 'First job delay should be 0');

    // Second email has 15s delay
    const job2 = await emailQueue.getJob(secondEmail.id);
    assert.ok(job2);
    assert.ok(
      job2.opts.delay && job2.opts.delay >= 14000 && job2.opts.delay <= 16000,
      `Second job delay should be ~15000ms, got: ${job2.opts.delay}ms`
    );

    await job1.remove();
    await job2.remove();
  });

  // =========================================================================
  // TEST 5: Worker Status Transition (scheduled -> processing -> sent)
  // =========================================================================
  test('Worker processes immediate email and transitions status from scheduled -> sent', async () => {
    deliveredMockEmails.length = 0;
    shouldMockFail = false;

    // Enqueue an immediate email
    const payload = {
      senderId: testSender.id,
      subject: 'Worker Status Transition Test',
      body: 'Hello from worker test',
      recipients: ['transition-test@reachinbox.test'],
      sendNow: true,
      delaySeconds: 0,
      hourlyLimit: 100,
    };

    const res = await fetch(`${baseUrl}/api/emails/schedule`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    const emailId = json.emails[0].id;

    // Start a worker to process the job
    const worker = createEmailWorker();

    try {
      // Wait for email status to transition to 'sent' in PostgreSQL
      const maxWaitMs = 8000;
      const startTime = Date.now();
      let finalEmail = null;

      while (Date.now() - startTime < maxWaitMs) {
        finalEmail = await prisma.email.findUnique({ where: { id: emailId } });
        if (finalEmail && finalEmail.status === 'sent') {
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      assert.ok(finalEmail, 'Email record must exist');
      assert.equal(
        finalEmail.status,
        'sent',
        `Email status must transition to 'sent', got: ${finalEmail?.status}`
      );
      assert.ok(finalEmail.sentAt, 'sentAt must be populated upon delivery');
      assert.equal(finalEmail.error, null, 'error must be null after successful delivery');

      // Verify mock transporter was called with correct parameters for this test email
      const match = deliveredMockEmails.find((e) => e.to === 'transition-test@reachinbox.test');
      assert.ok(match, 'Mock transporter must have recorded delivery for transition-test@reachinbox.test');
      assert.equal(match.subject, 'Worker Status Transition Test');
    } finally {
      await worker.close();
    }
  });

  // =========================================================================
  // TEST 6: Worker Error Handling (Delivery failure never falsely marks as sent)
  // =========================================================================
  test('SMTP failure does NOT mark email as sent; records error', async () => {
    deliveredMockEmails.length = 0;
    shouldMockFail = true; // Trigger mock error

    const payload = {
      senderId: testSender.id,
      subject: 'Worker Error Handling Test',
      body: 'Will fail due to simulated error',
      recipients: ['failure-test@reachinbox.test'],
      sendNow: true,
      delaySeconds: 0,
      hourlyLimit: 100,
    };

    const res = await fetch(`${baseUrl}/api/emails/schedule`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    const emailId = json.emails[0].id;

    const worker = createEmailWorker();

    try {
      // Wait for email to process and record failure/error
      const maxWaitMs = 6000;
      const startTime = Date.now();
      let emailAfterAttempt = null;

      while (Date.now() - startTime < maxWaitMs) {
        emailAfterAttempt = await prisma.email.findUnique({ where: { id: emailId } });
        if (emailAfterAttempt && emailAfterAttempt.error) {
          break;
        }
        await new Promise((r) => setTimeout(r, 200));
      }

      assert.ok(emailAfterAttempt, 'Email record must exist');
      assert.notEqual(
        emailAfterAttempt.status,
        'sent',
        'Failed email must NEVER be marked as sent'
      );
      assert.equal(emailAfterAttempt.sentAt, null, 'sentAt must remain null on failure');
      assert.match(
        emailAfterAttempt.error || '',
        /Simulated SMTP connection error/i,
        'Error message must be recorded on email record'
      );
    } finally {
      await worker.close();
      shouldMockFail = false;
    }
  });
});
