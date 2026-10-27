import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env';

export const ES_EMAIL_INDEX = 'reachinbox-emails';

// Lazily or conditionally instantiate Elasticsearch client
let clientInstance: Client | null = null;

export function getEsClient(): Client | null {
  if (!env.ELASTICSEARCH_ENABLED) {
    return null;
  }
  if (!clientInstance) {
    clientInstance = new Client({
      node: env.ELASTICSEARCH_URL,
      maxRetries: 2,
      requestTimeout: 4000,
    });
  }
  return clientInstance;
}

export interface EmailIndexPayload {
  id: string;
  userId: string;
  senderId: string;
  senderEmail?: string;
  recipient: string;
  subject: string;
  body: string;
  status: string;
  scheduledAt: Date;
  sentAt?: Date | null;
  createdAt: Date;
}

/**
 * Initializes the Elasticsearch index with appropriate full-text search mappings.
 * Fails safely: never throws or crashes application startup if ES is unavailable or disabled.
 */
export async function initElasticsearch(): Promise<void> {
  if (!env.ELASTICSEARCH_ENABLED) {
    console.log('ℹ️  [Elasticsearch] Disabled by configuration (ELASTICSEARCH_ENABLED=false).');
    return;
  }

  const client = getEsClient();
  if (!client) return;

  try {
    const exists = await client.indices.exists({ index: ES_EMAIL_INDEX });
    if (!exists) {
      await client.indices.create({
        index: ES_EMAIL_INDEX,
        mappings: {
          properties: {
            id: { type: 'keyword' },
            userId: { type: 'keyword' },
            senderId: { type: 'keyword' },
            senderEmail: { type: 'keyword' },
            recipient: {
              type: 'text',
              fields: { keyword: { type: 'keyword' } },
            },
            subject: { type: 'text' },
            body: { type: 'text' },
            status: { type: 'keyword' },
            scheduledAt: { type: 'date' },
            sentAt: { type: 'date' },
            createdAt: { type: 'date' },
          },
        },
      });
      console.log(`🔍 [Elasticsearch] Created index "${ES_EMAIL_INDEX}" with search mappings.`);
    } else {
      console.log(`🔍 [Elasticsearch] Connected. Index "${ES_EMAIL_INDEX}" ready.`);
    }
  } catch (err: unknown) {
    console.warn('⚠️ [Elasticsearch Warning] Could not initialize index (search will fall back to PostgreSQL):', (err as Error).message);
  }
}

/**
 * Indexes a new email record into Elasticsearch.
 * Safe non-blocking execution: does not throw or halt transaction if indexing fails.
 */
export async function indexEmail(doc: EmailIndexPayload): Promise<void> {
  if (!env.ELASTICSEARCH_ENABLED) {
    return;
  }

  const client = getEsClient();
  if (!client) return;

  try {
    await client.index({
      index: ES_EMAIL_INDEX,
      id: doc.id,
      document: {
        id: doc.id,
        userId: doc.userId,
        senderId: doc.senderId,
        senderEmail: doc.senderEmail || '',
        recipient: doc.recipient,
        subject: doc.subject,
        body: doc.body,
        status: doc.status,
        scheduledAt: doc.scheduledAt.toISOString(),
        sentAt: doc.sentAt ? doc.sentAt.toISOString() : null,
        createdAt: doc.createdAt.toISOString(),
      },
      refresh: 'wait_for',
    });
  } catch (err: unknown) {
    console.warn(`⚠️ [Elasticsearch Warning] Failed to index email ${doc.id}:`, (err as Error).message);
  }
}

/**
 * Updates an email document status in Elasticsearch.
 * Safe non-blocking execution: silently logs warning if document is missing.
 */
export async function updateEmailInEs(
  id: string,
  update: { status: string; sentAt?: Date | null; error?: string | null }
): Promise<void> {
  if (!env.ELASTICSEARCH_ENABLED) {
    return;
  }

  const client = getEsClient();
  if (!client) return;

  try {
    await client.update({
      index: ES_EMAIL_INDEX,
      id,
      doc: {
        status: update.status,
        ...(update.sentAt && { sentAt: update.sentAt.toISOString() }),
        ...(update.error && { error: update.error }),
      },
      refresh: 'wait_for',
    });
  } catch (err: unknown) {
    console.warn(`⚠️ [Elasticsearch Warning] Update document ${id}:`, (err as Error).message);
  }
}

/**
 * Executes a full-text multi-match search query across emails.
 * Returns empty array when disabled or on error so route automatically falls back to PostgreSQL.
 */
export async function searchEmailsInEs(
  userId: string,
  query: string,
  status?: string
): Promise<any[]> {
  if (!env.ELASTICSEARCH_ENABLED) {
    return [];
  }

  const client = getEsClient();
  if (!client) return [];

  try {
    const mustConditions: any[] = [{ term: { userId } }];

    if (status) {
      mustConditions.push({ term: { status } });
    }

    if (query.trim()) {
      mustConditions.push({
        multi_match: {
          query: query.trim(),
          fields: ['subject^3', 'recipient^2', 'body', 'senderEmail'],
          fuzziness: 'AUTO',
        },
      });
    }

    const response = await client.search({
      index: ES_EMAIL_INDEX,
      query: {
        bool: {
          must: mustConditions,
        },
      },
      sort: [{ scheduledAt: { order: 'desc' } }],
      size: 50,
    });

    return response.hits.hits.map((hit) => hit._source);
  } catch (err: unknown) {
    console.warn('⚠️ [Elasticsearch Search Warning] Query failed (falling back to database):', (err as Error).message);
    return [];
  }
}

/**
 * Checks Elasticsearch connectivity for readiness probe.
 */
export async function checkEsHealth(): Promise<{
  status: 'connected' | 'disconnected' | 'disabled';
  latencyMs?: number;
  error?: string;
}> {
  if (!env.ELASTICSEARCH_ENABLED) {
    return { status: 'disabled' };
  }

  const client = getEsClient();
  if (!client) {
    return { status: 'disabled' };
  }

  try {
    const start = Date.now();
    await Promise.race([
      client.ping(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Elasticsearch ping timed out')), 3000)
      ),
    ]);
    return {
      status: 'connected',
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      status: 'disconnected',
      error: (err as Error).message.includes('timed out') ? 'Ping timed out' : 'Connection failed',
    };
  }
}
