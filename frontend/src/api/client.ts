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

export async function searchEmails(
  query: string,
  status?: string
): Promise<{ data: EmailRecord[]; source: string }> {
  const params = new URLSearchParams();
  if (query) params.append('q', query);
  if (status) params.append('status', status);

  const res = await fetch(`${API_BASE}/search?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Search failed (${res.status})`);
  }
  const json = await res.json();
  return {
    data: json.data || [],
    source: json.source || 'database',
  };
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

export async function fetchCurrentUser(): Promise<{
  authenticated: boolean;
  user?: {
    id: string;
    email: string;
    name?: string;
    avatarUrl?: string;
    hasGoogleAuth: boolean;
  };
}> {
  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) return { authenticated: false };
    return await res.json();
  } catch {
    return { authenticated: false };
  }
}

export async function fetchSlackStatus(): Promise<{
  connected: boolean;
  connection?: { teamId: string; channelId?: string };
}> {
  try {
    const res = await fetch('/api/slack/status');
    if (!res.ok) return { connected: false };
    return await res.json();
  } catch {
    return { connected: false };
  }
}
