import { EmailRecord, SenderRecord, SchedulePayload } from '../types';

const API_BASE = '/api/emails';

export async function fetchScheduledEmails(): Promise<EmailRecord[]> {
  const res = await fetch(`${API_BASE}/scheduled`);
  if (!res.ok) {
    throw new Error(`Failed to fetch scheduled emails (${res.status})`);
  }
  const json = await res.json();
  return json.data || [];
}

export async function fetchSentEmails(): Promise<EmailRecord[]> {
  const res = await fetch(`${API_BASE}/sent`);
  if (!res.ok) {
    throw new Error(`Failed to fetch sent emails (${res.status})`);
  }
  const json = await res.json();
  return json.data || [];
}

export async function fetchSenders(): Promise<SenderRecord[]> {
  const res = await fetch(`${API_BASE}/senders`);
  if (!res.ok) {
    throw new Error(`Failed to fetch senders (${res.status})`);
  }
  const json = await res.json();
  return json.data || [];
}

export async function scheduleEmails(payload: SchedulePayload): Promise<{
  success: boolean;
  message: string;
  scheduledCount: number;
}> {
  const res = await fetch(`${API_BASE}/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (!res.ok || !json.success) {
    throw new Error(json.error || json.message || 'Failed to schedule emails');
  }

  return json;
}
