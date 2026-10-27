# ReachInbox Email Job Scheduler — Production Deployment Runbook

**Target Domain:** `https://scheduler.ramkumar.app`  
**Host Architecture:** Single AWS EC2 Instance (`t3.small`, 2 GiB RAM, 1 vCPU, 25–30 GB gp3 storage, Ubuntu 24.04 / 22.04 LTS x86)  
**Region:** AWS Asia Pacific Mumbai (`ap-south-1`)  
**Network Gateway:** Caddy Reverse Proxy (Listening on ports 80 & 443 with automated Let's Encrypt / ZeroSSL HTTPS)  
**Database:** Neon Serverless PostgreSQL over SSL (`DATABASE_URL`)  
**Internal Services:** Express REST API, BullMQ Worker, Redis 7 (AOF), Elasticsearch 8.15.3 (Single-node, 512MB JVM heap)

---

## Table of Contents

1. [Architecture Overview & Network Isolation](#1-architecture-overview--network-isolation)
2. [Resource Sizing & Memory Strategy (2 GiB RAM)](#2-resource-sizing--memory-strategy-2-gib-ram)
3. [Prerequisites & DNS Configuration](#3-prerequisites--dns-configuration)
4. [AWS Security Group Configuration](#4-aws-security-group-configuration)
5. [EC2 Server Provisioning & Hardening](#5-ec2-server-provisioning--hardening)
6. [Repository Setup & Deploy Key](#6-repository-setup--deploy-key)
7. [Environment Configuration (.env)](#7-environment-configuration-env)
8. [Neon PostgreSQL Schema Migration & Seeding](#8-neon-postgresql-schema-migration--seeding)
9. [Launching the Production Stack](#9-launching-the-production-stack)
10. [End-to-End Verification & Health Checks](#10-end-to-end-verification--health-checks)
11. [OAuth 2.0 Credentials Setup (Google & Slack)](#11-oauth-20-credentials-setup-google--slack)
12. [Ongoing Maintenance, Updates & Rollbacks](#12-ongoing-maintenance-updates--rollbacks)
13. [Troubleshooting & Diagnostics](#13-troubleshooting--diagnostics)

---

## 1. Architecture Overview & Network Isolation

In production, all services run under Docker Compose on a single isolated internal bridge network (`internal-net`). **Caddy is the only service that publishes host ports (`80` and `443`).** 

```
                                  INTERNET
                                      │
               ┌──────────────────────┴──────────────────────┐
               │    DNS: scheduler.ramkumar.app (A Record)   │
               └──────────────────────┬──────────────────────┘
                                      │
                         AWS Elastic IP (Static Public)
                                      │
                         AWS Security Group (80, 443, 22)
                                      │
  ╔═══════════════════════════════════╪═════════════════════════════════════╗
  ║ AWS EC2 t3.small (ap-south-1)     │                                     ║
  ║                                   ▼                                     ║
  ║                     ┌───────────────────────────┐                       ║
  ║                     │  Caddy Web Server (Prod)  │                       ║
  ║                     │   - Auto TLS (80 / 443)   │                       ║
  ║                     │   - Serves React SPA (/)  │                       ║
  ║                     └─────────────┬─────────────┘                       ║
  ║                                   │ (internal Docker network)           ║
  ║          ┌────────────────────────┼────────────────────────┐            ║
  ║          │ /api/*, /admin/queues* │                        │            ║
  ║          ▼                        ▼                        │            ║
  ║  ┌──────────────┐         ┌──────────────┐                 │            ║
  ║  │ Express API  │         │ BullMQ Worker│                 │            ║
  ║  │ Backend:4000 │         │ Engine       │                 │            ║
  ║  └───────┬──────┘         └───────┬──────┘                 │            ║
  ║          │                        │                        │            ║
  ║          ├────────────────────────┼────────────────────────┤            ║
  ║          │                        │                        │            ║
  ║          ▼                        ▼                        ▼            ║
  ║  ┌──────────────┐         ┌──────────────┐         ┌──────────────┐     ║
  ║  │   Redis 7    │         │Elasticsearch8│         │ Caddy Data & │     ║
  ║  │(AOF enabled) │         │ (512MB Heap) │         │ Config Vols  │     ║
  ║  └──────────────┘         └──────────────┘         └──────────────┘     ║
  ╚═══════════════════════════════════╤═════════════════════════════════════╝
                                      │
                           DATABASE_URL (SSL Mode)
                                      │
                                      ▼
                        ┌───────────────────────────┐
                        │     Neon PostgreSQL       │
                        │  (Serverless / Managed)   │
                        └───────────────────────────┘
```

- **No Internal Ports Exposed:** Ports `4000` (Express), `6379` (Redis), and `9200` (Elasticsearch) are not mapped to host interfaces and cannot be reached from outside the EC2 instance.
- **Auto-TLS:** Caddy requests and renews Let's Encrypt / ZeroSSL certificates automatically via the ACME HTTP-01 challenge on port 80.
- **Database Offloading:** By hosting PostgreSQL on Neon, database memory and disk I/O are offloaded from the `t3.small` instance.

---

## 2. Resource Sizing & Memory Strategy (2 GiB RAM)

The EC2 `t3.small` instance provides 2.0 GiB (2048 MB) of physical RAM. To prevent out-of-memory (OOM) killer terminations:

| Service / Component | Memory Allocation | Optimization Applied |
| :--- | :--- | :--- |
| **Elasticsearch 8** | ~512 MB – 650 MB | `ES_JAVA_OPTS=-Xms512m -Xmx512m`, single-node, xpack security disabled |
| **Backend Express API** | ~90 MB – 140 MB | Node.js 22 Alpine, production build, no dev dependencies |
| **BullMQ Worker** | ~90 MB – 140 MB | Standalone Node.js 22 Alpine process, concurrency capped at 5 |
| **Redis 7** | ~40 MB – 60 MB | Alpine image, AOF persistence, small key footprint |
| **Caddy Web Server** | ~25 MB – 40 MB | Go binary, static file serving, reverse proxy |
| **Ubuntu OS & Daemons** | ~250 MB – 300 MB | Minimal Ubuntu LTS installation, systemd |
| **Total Resident Memory**| **~1,000 MB – 1,350 MB** | Well within 2,048 MB threshold (~65% utilization) |
| **Swap Space (Safety Net)** | **2,048 MB (2 GB)** | Prevents OOM kills during Docker builds or load spikes |

---

## 3. Prerequisites & DNS Configuration

### 3.1 DNS A Record
In your DNS provider (e.g., Cloudflare, Route 53, Namecheap, GoDaddy):
1. Create an **A Record**:
   - **Host / Name:** `scheduler` (or `scheduler.ramkumar.app`)
   - **Type:** `A`
   - **Value / Points to:** `<YOUR_EC2_ELASTIC_IP>`
   - **TTL:** `300` seconds (5 minutes for fast propagation)
2. *Important (if using Cloudflare):* Set Proxy status to **DNS Only** (Grey Cloud) during initial setup so Caddy can solve the ACME HTTP-01 challenge directly.

### 3.2 Neon PostgreSQL Database
1. Log in to [Neon Console](https://console.neon.tech/).
2. Create or select a project in `ap-south-1` (Mumbai) or the closest AWS region.
3. Copy the pooled or direct connection string:
   ```
   postgresql://neondb_owner:YOUR_SECRET_PASSWORD@ep-sample-pool.ap-south-1.aws.neon.tech/neondb?sslmode=require
   ```

---

## 4. AWS Security Group Configuration

In the AWS EC2 Management Console, locate your instance's Security Group and configure the following rules:

### Inbound Rules (Strictly Minimal)

| Type | Protocol | Port Range | Source | Description |
| :--- | :--- | :--- | :--- | :--- |
| **SSH** | TCP | `22` | `YOUR_ADMIN_IP/32` (or your bastion CIDR) | Remote administration |
| **HTTP** | TCP | `80` | `0.0.0.0/0` | Let's Encrypt ACME challenge & HTTP to HTTPS redirect |
| **HTTPS** | TCP | `443` | `0.0.0.0/0` | Secure public web and API traffic |

> [!CAUTION]
> **Never open ports 4000, 6379, 9200, or 5432 to `0.0.0.0/0`.** All inter-service traffic flows exclusively over Docker's internal bridge network.

### Outbound Rules
- Default: **All Traffic** (`0.0.0.0/0`) to allow outbound HTTPS calls to Neon PostgreSQL, SMTP relays (Ethereal / Gmail / SendGrid), Google OAuth, and Slack Webhooks.

---

## 5. EC2 Server Provisioning & Hardening

SSH into your newly launched Ubuntu EC2 instance:

```bash
ssh -i /path/to/your-key.pem ubuntu@<YOUR_EC2_ELASTIC_IP>
```

### 5.1 System Updates & Prerequisites
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl wget git htop ca-certificates gnupg lsb-release
```

### 5.2 Configure 2 GB Swapfile (Crucial for 2 GiB instances)
```bash
# Check if swap exists
sudo swapon --show

# Create 2GB swap file
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile

# Make swap persistent across reboots
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Optimize swappiness for server workloads
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
```

### 5.3 Configure Virtual Memory for Elasticsearch
Elasticsearch requires `vm.max_map_count` to be at least `262144`:
```bash
sudo sysctl -w vm.max_map_count=262144
echo 'vm.max_map_count=262144' | sudo tee -a /etc/sysctl.conf
```

### 5.4 Install Docker Engine & Docker Compose Plugin
```bash
# Add Docker's official GPG key
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

# Add repository to Apt sources
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker packages
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Enable and start Docker service
sudo systemctl enable docker
sudo systemctl start docker

# Add ubuntu user to docker group (avoid sudo for docker commands)
sudo usermod -aG docker ubuntu
newgrp docker
```

Verify installation:
```bash
docker --version
docker compose version
```

---

## 6. Repository Setup & Deploy Key

### 6.1 Clone the Project Repository
```bash
cd /home/ubuntu
git clone https://github.com/ramkumar-lpu/ReachInbox.ai-full-stack-Email-Job-Scheduler-hiring-assignment.git scheduler
cd scheduler
```

---

## 7. Environment Configuration (.env)

Create the production environment file from the provided template:

```bash
cp .env.production.example .env
chmod 600 .env
nano .env
```

### Required Configuration in `.env`
```dotenv
# Node Environment & Server Port
NODE_ENV=production
PORT=4000

# Neon PostgreSQL Database Connection (Must include ?sslmode=require)
DATABASE_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-sample-pool.ap-south-1.aws.neon.tech/neondb?sslmode=require"

# Docker Internal Service Connections
REDIS_URL=redis://redis:6379
ELASTICSEARCH_URL=http://elasticsearch:9200

# Application Public Origin
FRONTEND_URL=https://scheduler.ramkumar.app

# Secure 64-character JWT Secret (Generate via: openssl rand -hex 32)
JWT_SECRET=paste_generated_hex_secret_here

# Google OAuth 2.0 Credentials
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_CALLBACK_URL=https://scheduler.ramkumar.app/api/auth/google/callback

# Slack OAuth 2.0 Credentials
SLACK_CLIENT_ID=your_slack_client_id
SLACK_CLIENT_SECRET=your_slack_client_secret
SLACK_CALLBACK_URL=https://scheduler.ramkumar.app/api/slack/callback

# Background Worker Performance Tuning
WORKER_CONCURRENCY=5
MIN_SEND_DELAY_MS=200
EMBEDDED_WORKER=false
```

Generate a random JWT secret:
```bash
openssl rand -hex 32
```

---

## 8. Neon PostgreSQL Schema Migration & Seeding

Before launching the full container stack, apply Prisma migrations to your Neon database and seed development sender records.

### Option A: Direct Migration via Node.js on EC2 (Fastest)
```bash
# Install Node.js 22 LTS on the host if not already present
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Install dependencies in backend directory
cd /home/ubuntu/scheduler/backend
npm ci

# Apply schema migrations to Neon
DATABASE_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-sample-pool.ap-south-1.aws.neon.tech/neondb?sslmode=require" npx prisma migrate deploy

# Run the idempotent seed script
DATABASE_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-sample-pool.ap-south-1.aws.neon.tech/neondb?sslmode=require" npm run db:seed

# Verify database state
DATABASE_URL="postgresql://neondb_owner:YOUR_PASSWORD@ep-sample-pool.ap-south-1.aws.neon.tech/neondb?sslmode=require" npm run db:verify

cd /home/ubuntu/scheduler
```

### Option B: Migration via Docker (Without Node.js on Host)
If you prefer not to install Node.js on the host OS:
```bash
# Build backend image first
docker compose -f docker-compose.prod.yml build backend

# Run migration inside a transient container
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
```

---

## 9. Launching the Production Stack

Start all production services in detached mode:

```bash
cd /home/ubuntu/scheduler
docker compose -f docker-compose.prod.yml up -d --build
```

### 9.1 Verify Container Status
```bash
docker compose -f docker-compose.prod.yml ps
```

Expected healthy output:
```
NAME                    IMAGE                               COMMAND                  SERVICE         STATUS                   PORTS
reachinbox_backend_prod reachinbox-scheduler-backend        "node dist/server.js"    backend         running (healthy)        
reachinbox_caddy_prod   reachinbox-scheduler-caddy          "caddy run --config …"   caddy           running                  0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
reachinbox_es_prod      elasticsearch:8.15.3                "/bin/tini -- /usr/l…"   elasticsearch   running (healthy)        
reachinbox_redis_prod   redis:7-alpine                      "redis-server --appe…"   redis           running (healthy)        
reachinbox_worker_prod  reachinbox-scheduler-backend        "node dist/worker.js"    worker          running                  
```

### 9.2 Inspect Live Logs
```bash
# Follow all container logs
docker compose -f docker-compose.prod.yml logs -f

# Follow Caddy logs to confirm Let's Encrypt certificate issuance
docker compose -f docker-compose.prod.yml logs -f caddy

# Follow Express API startup and reconciliation
docker compose -f docker-compose.prod.yml logs -f backend

# Follow BullMQ Worker email consumer
docker compose -f docker-compose.prod.yml logs -f worker
```

---

## 10. End-to-End Verification & Health Checks

Execute these non-destructive verification steps on the host or from your workstation:

### 10.1 API Health Probe
```bash
curl -i https://scheduler.ramkumar.app/health
```
**Expected Response (`200 OK`):**
```json
{
  "status": "ok",
  "uptime": 12.34,
  "timestamp": "2026-10-27T12:00:00.000Z",
  "environment": "production"
}
```

### 10.2 Scheduled and Sent Email Endpoints
```bash
curl -i https://scheduler.ramkumar.app/api/emails/scheduled
curl -i https://scheduler.ramkumar.app/api/emails/sent
```
Both return `200 OK` with JSON payloads containing email records.

### 10.3 Elasticsearch Full-Text Search
```bash
curl -i "https://scheduler.ramkumar.app/api/emails/search?q=welcome"
```
Returns matching email records indexed in Elasticsearch 8.

### 10.4 Web Dashboard & SPA Fallback
Open `https://scheduler.ramkumar.app` in any modern browser:
- The React dashboard loads with clean Tailwind styling.
- Metrics cards reflect Scheduled, Processing, Sent, and Failed counts.
- Search bar queries Elasticsearch in real-time.
- Navigating directly to subpaths or refreshing the page works seamlessly due to Caddy's `try_files {path} /index.html` fallback.

### 10.5 Bull Board Monitoring Interface
Open `https://scheduler.ramkumar.app/admin/queues` in your browser:
- Live BullMQ `email-queue` dashboard displays active, completed, failed, and delayed jobs.

---

## 11. OAuth 2.0 Credentials Setup (Google & Slack)

### 11.1 Google Cloud Console
1. Visit [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Edit your **OAuth 2.0 Client ID** (Web application):
   - **Authorized JavaScript origins:**
     - `https://scheduler.ramkumar.app`
   - **Authorized redirect URIs:**
     - `https://scheduler.ramkumar.app/api/auth/google/callback`
3. Save changes. Google OAuth sign-in will now authenticate users and issue secure session cookies.

### 11.2 Slack App Console
1. Visit [Slack API Apps](https://api.slack.com/apps).
2. Under **OAuth & Permissions**:
   - **Redirect URLs:**
     - `https://scheduler.ramkumar.app/api/slack/callback`
   - **Bot Token Scopes:**
     - `chat:write`
     - `channels:read`
3. Save changes. Clicking "Connect Slack" on the dashboard will authorize your workspace and dispatch delivery notifications.

---

## 12. Ongoing Maintenance, Updates & Rollbacks

### 12.1 Applying Code Updates (Zero-Downtime Rebuild)
When new commits are pushed to the GitHub repository:

```bash
cd /home/ubuntu/scheduler

# Pull latest code
git pull origin main

# Re-run migrations if Prisma schema changed
cd backend && DATABASE_URL="<NEON_URL>" npx prisma migrate deploy && cd ..

# Rebuild and restart containers in place
docker compose -f docker-compose.prod.yml up -d --build

# Prune old dangling Docker images to free disk space
docker image prune -f
```

### 12.2 Instant Rollback Procedure
If an issue arises after a deployment:

```bash
cd /home/ubuntu/scheduler

# Identify the previous stable commit hash
git log --oneline -n 5

# Revert to stable commit
git checkout <COMMIT_HASH>

# Rebuild and restart containers
docker compose -f docker-compose.prod.yml up -d --build
```

### 12.3 Managing Services
```bash
# Stop all services cleanly
docker compose -f docker-compose.prod.yml stop

# Restart a specific service (e.g., worker)
docker compose -f docker-compose.prod.yml restart worker

# View memory and CPU utilization of containers
docker stats --no-stream
```

---

## 13. Troubleshooting & Diagnostics

### Issue 1: Caddy Fails to Obtain TLS Certificate
- **Symptom:** Browser shows `SSL_ERROR_INTERNAL_ERROR_ALERT` or connection refused on 443.
- **Diagnostic:** Check Caddy logs:
  ```bash
  docker compose -f docker-compose.prod.yml logs caddy | grep -i "certificate"
  ```
- **Causes & Fixes:**
  1. *DNS not propagated:* Run `dig +short scheduler.ramkumar.app` or `nslookup scheduler.ramkumar.app`. Verify it resolves to your Elastic IP.
  2. *Port 80 blocked:* Check AWS Security Group. Port 80 must be open to `0.0.0.0/0` for the ACME challenge.
  3. *Cloudflare Proxy enabled:* If using Cloudflare, turn proxy off (Grey Cloud) so Let's Encrypt can reach Caddy directly.

### Issue 2: Elasticsearch Fails on Startup
- **Symptom:** `reachinbox_es_prod` exits or is continuously restarting.
- **Diagnostic:**
  ```bash
  docker compose -f docker-compose.prod.yml logs elasticsearch
  ```
- **Fix:** If the log shows `max virtual memory areas vm.max_map_count [65530] is too low`, apply the kernel setting:
  ```bash
  sudo sysctl -w vm.max_map_count=262144
  docker compose -f docker-compose.prod.yml restart elasticsearch
  ```

### Issue 3: Container OOM Kill on `t3.small`
- **Symptom:** Container abruptly exits with exit code `137`.
- **Diagnostic:** Check system dmesg:
  ```bash
  sudo dmesg -T | grep -i oom
  ```
- **Fix:** Verify swapfile is enabled:
  ```bash
  free -m
  ```
  If `Swap` shows `0`, recreate the 2 GB swapfile following Section 5.2. Ensure Elasticsearch JVM heap remains locked at `512m` (`-Xms512m -Xmx512m`).

### Issue 4: Neon Database SSL Handshake Failure
- **Symptom:** Express fails to start with `PrismaClientInitializationError: Error in Prisma Client: Can't reach database server`.
- **Fix:** Ensure the connection string ends with `?sslmode=require` and the password in `.env` is properly URL-encoded if it contains special characters like `@`, `!`, or `#`.
