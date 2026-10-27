# ReachInbox Email Job Scheduler & Dashboard

A persistent email job scheduler, queue processor, and dashboard monorepo built for the ReachInbox hiring assignment.

> **Status**: **Working End-to-End MVP Completed**.  
> Features Express API, PostgreSQL (Prisma), BullMQ with Redis, Nodemailer with Ethereal SMTP, rate limiting, startup reconciliation, Bull Board, and a React + Vite + Tailwind CSS dashboard.

---

## Architecture Overview

```
Reachinbox-scheduler/
├── backend/
│   ├── prisma/
│   │   ├── migrations/       # Version-controlled SQL migrations
│   │   ├── schema.prisma     # Prisma relational schema
│   │   ├── seed.ts           # Idempotent development sender seeding
│   │   └── verify.ts         # Diagnostic verification script
│   ├── scripts/
│   │   └── createEtherealAccount.ts # Helper to generate live Ethereal SMTP test accounts
│   ├── src/
│   │   ├── config/           # Strict Zod env validation, Redis & BullMQ connections
│   │   ├── db/client.ts      # Singleton PrismaClient
│   │   ├── queues/           # BullMQ delayed queue definition
│   │   ├── routes/           # /health, /api/emails/schedule, /scheduled, /sent, /senders
│   │   ├── services/         # Nodemailer dispatch, Redis sliding-window rate limiter, reconciliation
│   │   ├── workers/          # BullMQ worker with fresh DB reads & rate limit rescheduling
│   │   ├── app.ts            # Express app + Bull Board UI mounted at /admin/queues
│   │   ├── server.ts         # HTTP server entrypoint + embedded worker
│   │   └── worker.ts         # Standalone worker entrypoint
│   ├── package.json
│   └── tsconfig.json
├── frontend/                 # React + Vite + TypeScript + Tailwind CSS Dashboard
│   ├── src/
│   │   ├── api/client.ts     # Typed API client connecting to backend
│   │   ├── components/       # Navbar, ComposeModal, EmailTable, StatusBadge
│   │   ├── types/index.ts    # TypeScript interfaces
│   │   ├── App.tsx           # Dashboard view with Scheduled & Sent tabs + Metrics
│   │   └── main.tsx
│   ├── package.json
│   └── vite.config.ts        # Proxies /api to backend port 4000
├── docker-compose.yml        # PostgreSQL 16, Redis 7 (AOF), Elasticsearch 8
├── .gitignore
└── README.md
```

---

## Infrastructure Components

| Service | Technology | Host Port | Configuration |
|---|---|---|---|
| **Database** | PostgreSQL 16 (Alpine) | `127.0.0.1:5433` (or `5432`) | Persistent volume (`reachinbox_postgres_data`) |
| **Queue / Cache** | Redis 7 (Alpine) | `127.0.0.1:6380` (or `6379`) | Append-Only File (`--appendonly yes`), named volume |
| **Search Engine** | Elasticsearch 8.15 | `127.0.0.1:9200` | Single-node dev mode, 512MB heap limit |

---

## Core Scheduler Features

### 1. Job Scheduling & BullMQ Delayed Queue
- `POST /api/emails/schedule` accepts an array of recipients (or raw text/CSV upload).
- Computes staggered delivery timestamps: `T + (index * delaySeconds)`.
- Persists an `Email` record per recipient in PostgreSQL.
- Creates delayed jobs in BullMQ using the **Email record's UUID as the stable `jobId`**.
- Status transitions: `scheduled` → `processing` → `sent` / `failed`.

### 2. Redis-Backed Sliding-Window Hourly Rate Limiting
- Enforces per-sender configurable hourly limits (e.g. 50 or 100 emails/hour) using Redis sorted sets (`ZADD`, `ZREMRANGEBYSCORE`, `ZCARD`).
- When a limit is reached, **jobs are never dropped**: the worker computes the earliest reopening window and reschedules the job using BullMQ's native `job.moveToDelayed()` and `DelayedError`.
- State is strictly maintained in Redis and survives worker restarts.

### 3. Startup Reconciliation
- On server/worker boot, the reconciliation service scans PostgreSQL for records in `scheduled` or `processing` states.
- If a BullMQ job is missing (e.g., Redis was flushed or server died mid-scheduling), the job is restored into the queue with its remaining delay calculated relative to `scheduledAt`.
- If a job was interrupted mid-flight, its status is safely reset to `scheduled`.

### 4. Bull Board Queue Dashboard
- Mounted at `http://localhost:4000/admin/queues`.
- Inspect active, delayed, waiting, completed, and failed jobs in real time.

---

## Distributed Systems Note: SMTP Crash-Window Duplicate Risk

In a distributed job queue dispatching emails via external SMTP servers:
1. The worker calls `transporter.sendMail(...)`.
2. The remote SMTP server accepts the message for delivery.
3. The worker attempts to update PostgreSQL with `status: 'sent', sentAt: new Date()`.

**The Crash Window:** If the worker process crashes (OOM, SIGKILL, network drop to PostgreSQL) in the microsecond window between step 2 and step 3:
- The email has already been sent to the recipient by the SMTP server.
- But PostgreSQL still shows the status as `processing` or `scheduled`.
- Upon worker recovery or BullMQ retry, at-least-once delivery semantics cause the job to re-execute, resulting in a duplicate email to the recipient.

*Mitigation:* Mark status as `processing` immediately before SMTP calls, log timestamps, and use deterministic message-id headers where receiving MTAs support deduplication.

---

## Quick Start (Running End-to-End)

### 1. Start Infrastructure
```bash
docker compose up -d
docker compose ps
```

### 2. Backend Setup & Live SMTP Test Credentials
```bash
cd backend
npm install
npm run db:migrate
npm run db:seed

# Optional: Generate a live Ethereal test account with 1 command
npm run ethereal:create
```

### 3. Start Backend API & Worker
```bash
npm run dev
```
Backend runs at `http://localhost:4000`.  
Bull Board UI: `http://localhost:4000/admin/queues`.

### 4. Start Frontend Dashboard
In a second terminal:
```bash
cd frontend
npm install
npm run dev
```
Frontend runs at `http://127.0.0.1:3000`.

---

## Verified End-to-End Smoke Test

1. Open `http://127.0.0.1:3000` in your browser.
2. Click **"Compose New Email"**.
3. Enter or paste recipient email addresses (e.g. `client@example.com`).
4. Enter Subject and Body.
5. Click **"Schedule"**.
6. The job is queued into BullMQ, dispatched by the worker, sent via Ethereal SMTP, updated in PostgreSQL, and appears under the **"Sent Emails"** tab with its live delivery status and Ethereal preview link logged in the terminal!
