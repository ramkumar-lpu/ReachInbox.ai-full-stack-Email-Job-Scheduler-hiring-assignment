import nodemailer from 'nodemailer';
import { Email, Sender } from '@prisma/client';

export interface SendResult {
  messageId: string;
  previewUrl?: string | false;
}

/**
 * DISTRIBUTED SYSTEMS ARCHITECTURE NOTE: The SMTP Crash-Window Duplicate Risk
 *
 * In a distributed architecture dispatching emails via an external SMTP server:
 *
 *   [Worker] ---- 1. sendMail() ----> [SMTP Server] (Email accepted & delivered)
 *      |
 *      |  <-- CRASH WINDOW: If worker dies here (OOM, crash, DB network failure) -->
 *      v
 *   [PostgreSQL] (status remains 'processing' or 'scheduled')
 *
 * Because SMTP does not participate in distributed two-phase commits (2PC) or XA transactions
 * with PostgreSQL, this crash window means an email may be delivered by SMTP while PostgreSQL
 * never receives the acknowledgement.
 *
 * When the worker restarts or BullMQ retries the unacknowledged job, it executes at-least-once
 * delivery, which may result in a duplicate email to the recipient.
 *
 * Mitigation:
 * 1. Mark status = 'processing' BEFORE initiating SMTP network calls.
 * 2. Record the attemptCount immediately.
 * 3. Use deterministic message-id headers when supported by downstream MTAs.
 */
export async function sendEmailViaSmtp(
  email: Email,
  sender: Sender
): Promise<SendResult> {
  // Check if sender has unconfigured placeholder credentials
  if (
    sender.smtpPassword.includes('placeholder') ||
    sender.smtpUsername.includes('placeholder')
  ) {
    throw new Error(
      `SMTP Delivery Blocked: Sender "${sender.email}" is configured with development placeholder credentials. To send live test emails, configure valid Ethereal credentials (run 'npm run ethereal:create' in the backend).`
    );
  }

  const transporter = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpPort === 465,
    auth: {
      user: sender.smtpUsername,
      pass: sender.smtpPassword,
    },
    // Strict timeout settings
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  const info = await transporter.sendMail({
    from: `"${sender.email}" <${sender.smtpUsername}>`,
    to: email.recipient,
    subject: email.subject,
    text: email.body,
    html: `<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1e293b;">
      ${email.body.replace(/\n/g, '<br/>')}
    </div>`,
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);

  return {
    messageId: info.messageId,
    previewUrl,
  };
}
