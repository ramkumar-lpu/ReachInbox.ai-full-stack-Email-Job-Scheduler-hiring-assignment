import { Client } from '@elastic/elasticsearch';
import { env } from '../config/env';

export const ES_EMAIL_INDEX = 'reachinbox-emails';

export const esClient = new Client({
  node: env.ELASTICSEARCH_URL,
});

/**
 * Initializes the Elasticsearch index with appropriate full-text search mappings
 */
export async function initElasticsearch(): Promise<void> {
  try {
    const exists = await esClient.indices.exists({ index: ES_EMAIL_INDEX });
    if (!exists) {
      await esClient.indices.create({
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
    console.warn('⚠️ [Elasticsearch Warning] Could not initialize index:', (err as Error).message);
  }
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
 * Indexes a new email record into Elasticsearch
 */
export async function indexEmail(doc: EmailIndexPayload): Promise<void> {
  try {
    await esClient.index({
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
    console.error(`❌ [Elasticsearch Index Error] Failed to index email ${doc.id}:`, (err as Error).message);
  }
}

/**
 * Updates an email document status in Elasticsearch
 */
export async function updateEmailInEs(
  id: string,
  update: { status: string; sentAt?: Date | null; error?: string | null }
): Promise<void> {
  try {
    await esClient.update({
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
    // If not found in ES, silently ignore so primary DB operations never fail
    console.warn(`⚠️ [Elasticsearch Update Warning] Document ${id}:`, (err as Error).message);
  }
}

/**
 * Executes a full-text multi-match search query across emails
 */
export async function searchEmailsInEs(
  userId: string,
  query: string,
  status?: string
): Promise<any[]> {
  try {
    const mustConditions: any[] = [
      { term: { userId } },
    ];

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

    const response = await esClient.search({
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
    console.error('❌ [Elasticsearch Search Error]:', (err as Error).message);
    return [];
  }
}
