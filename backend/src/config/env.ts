import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { z } from 'zod';

// Resolve possible .env paths (supporting execution from project root or backend folder)
const candidateEnvPaths = [
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), 'backend', '.env'),
  path.resolve(__dirname, '..', '..', '.env'),
];

for (const envPath of candidateEnvPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

// Fallback to standard dotenv resolution
dotenv.config();

/**
 * Helper to validate URI schemes like postgresql://, redis://, and http(s)://
 */
const isValidUri = (value: string, allowedProtocols?: string[]): boolean => {
  try {
    const parsed = new URL(value);
    if (allowedProtocols && allowedProtocols.length > 0) {
      return allowedProtocols.includes(parsed.protocol);
    }
    return Boolean(parsed.protocol && parsed.host);
  } catch {
    return false;
  }
};

/**
 * Strict Environment Schema definition using Zod
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce
    .number()
    .int('PORT must be an integer')
    .min(1, 'PORT must be between 1 and 65535')
    .max(65535, 'PORT must be between 1 and 65535')
    .default(4000),
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL cannot be empty')
    .refine(
      (val) => isValidUri(val, ['postgresql:', 'postgres:']),
      {
        message:
          'DATABASE_URL must be a valid PostgreSQL connection URL (e.g. postgresql://user:password@localhost:5432/dbname)',
      }
    ),
  REDIS_URL: z
    .string({ required_error: 'REDIS_URL is required' })
    .min(1, 'REDIS_URL cannot be empty')
    .refine(
      (val) => isValidUri(val, ['redis:', 'rediss:']),
      {
        message:
          'REDIS_URL must be a valid Redis connection URL (e.g. redis://localhost:6379)',
      }
    ),
  ELASTICSEARCH_URL: z
    .string({ required_error: 'ELASTICSEARCH_URL is required' })
    .min(1, 'ELASTICSEARCH_URL cannot be empty')
    .refine(
      (val) => isValidUri(val, ['http:', 'https:']),
      {
        message:
          'ELASTICSEARCH_URL must be a valid HTTP/HTTPS URL (e.g. http://localhost:9200)',
      }
    ),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
  MIN_SEND_DELAY_MS: z.coerce.number().int().min(0).max(60000).default(200),
  EMBEDDED_WORKER: z
    .enum(['true', 'false'])
    .default('true')
    .transform((val) => val === 'true'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  JWT_SECRET: z.string().default('reachinbox-dev-jwt-secret-replace-in-production'),
  GOOGLE_CLIENT_ID: z.string().default(''),
  GOOGLE_CLIENT_SECRET: z.string().default(''),
  GOOGLE_CALLBACK_URL: z.string().default(''),
  SLACK_CLIENT_ID: z.string().default(''),
  SLACK_CLIENT_SECRET: z.string().default(''),
  SLACK_CALLBACK_URL: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('\n❌ Environment variable validation failed:');
  const formattedErrors = parsed.error.format();
  for (const [key, issues] of Object.entries(formattedErrors)) {
    if (key === '_errors') continue;
    const issueList = issues as { _errors?: string[] };
    if (issueList?._errors?.length) {
      console.error(`  - ${key}: ${issueList._errors.join(', ')}`);
    }
  }
  console.error('\nPlease check your .env file against .env.example.\n');
  process.exit(1);
}

export const env = parsed.data;
export type Env = z.infer<typeof envSchema>;
