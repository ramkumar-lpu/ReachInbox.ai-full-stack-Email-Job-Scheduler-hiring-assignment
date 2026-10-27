export type EmailStatus = 'scheduled' | 'processing' | 'sent' | 'failed';

export interface SenderInfo {
  id: string;
  email: string;
  smtpHost: string;
  smtpPort?: number;
  hourlyLimit?: number;
}

export interface EmailBatchInfo {
  id: string;
  startTime: string;
  delaySeconds: number;
}

export interface EmailRecord {
  id: string;
  batchId: string;
  userId: string;
  senderId: string;
  recipient: string;
  subject: string;
  body: string;
  scheduledAt: string;
  sentAt: string | null;
  status: EmailStatus;
  attemptCount: number;
  error: string | null;
  bullmqJobId: string | null;
  createdAt: string;
  updatedAt: string;
  sender?: SenderInfo;
  batch?: EmailBatchInfo;
}

export interface SenderRecord {
  id: string;
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  hourlyLimit: number;
  createdAt: string;
}

export interface SchedulePayload {
  senderId?: string;
  subject: string;
  body: string;
  recipients: string[];
  startTime?: string;
  delaySeconds: number;
  hourlyLimit: number;
}
