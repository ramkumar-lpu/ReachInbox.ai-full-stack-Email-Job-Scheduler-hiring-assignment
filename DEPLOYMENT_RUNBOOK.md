# ReachInbox Email Job Scheduler — Production Deployment Runbook

**Target Domain:** `https://scheduler.ramkumar.app`  
**Host Architecture:** Single AWS EC2 Instance (`t3.small`, 2 GiB RAM, 1 vCPU, 25–30 GB gp3 storage, Ubuntu 24.04 / 22.04 LTS x86)  
**Region:** AWS Asia Pacific Mumbai (`ap-south-1`)  
**Network Gateway:** Caddy Reverse Proxy (Listening on ports 80 & 443 with automated Let's Encrypt / ZeroSSL HTTPS)  
**Database:** Neon Serverless PostgreSQL over SSL (`DATABASE_URL`)  
**Internal Services:** Express REST API, BullMQ Worker, Redis 7 (AOF + `noeviction`), Optional Elasticsearch 8.15.3 (Single-node, 512MB JVM heap)

---

## Table of Contents

1. [Architecture Overview & Network Isolation](#1-architecture-overview--network-isolation)
2. [Resource Sizing & Memory Strategy (2 GiB RAM)](#2-resource-sizing--memory-strategy-2-gib-ram)
3. [Prerequisites & DNS Configuration](#3-prerequisites--dns-configuration)
4. [AWS Security Group Configuration](#4-aws-security-group-configuration)
5. [EC2 Server Provisioning & Hardening](#5-ec2-server-provisioning--hardening)
6. [Repository Setup & Configuration](#6-repository-setup--configuration)
7. [Environment Configuration (.env)](#7-environment-configuration-env)
8. [Neon PostgreSQL Schema Deployment (Prisma Migrate Deploy)](#8-neon-postgresql-schema-deployment-prisma-migrate-deploy)
9. [Launching the Production Stack](#9-launching-the-production-stack)
10. [End-to-End Verification & Health Checks](#10-end-to-end-verification--health-checks)
11. [OAuth 2.0 Credentials Setup (Google & Slack)](#11-oauth-20-credentials-setup-google--slack)
12. [Ongoing Maintenance, Updates & Rollbacks](#12-ongoing-maintenance-updates--rollbacks)
13. [Troubleshooting & Diagnostics](#13-troubleshooting--diagnostics)

---

## 1. Architecture Overview & Network Isolation

In production, all application services run under Docker Compose on a single isolated internal bridge network (`internal-net`). **Caddy is the only service that publishes host ports (`80` and `443`).** 

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
  ║  │ (noeviction) │         │ (Optional)   │         │ Config Vols  │     ║
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
- **Redis Queue Safety:** Redis uses `--maxmemory-policy noeviction` so BullMQ queued jobs and locks are never discarded under memory pressure.

---

## 2. Resource Sizing & Memory Strategy (2 GiB RAM)

The EC2 `t3.small` instance provides 2.0 GiB (2048 MB) of physical RAM. To guarantee stability:

| Service / Component | Memory Limit / Allocation | Optimization Applied |
| :--- | :--- | :--- |
| **Backend Express API** | Limit: 350 MB / Reserve: 100 MB | Node.js 22 Alpine, production build, non-root user `node` |
| **BullMQ Worker** | Limit: 350 MB / Reserve: 100 MB | Standalone Node.js 22 Alpine process, concurrency capped at 5 |
| **Redis 7** | Limit: 200 MB / Reserve: 50 MB | Alpine image, AOF persistence, `--maxmemory 150mb`, `noeviction` |
| **Caddy Web Server** | Limit: 100 MB / Reserve: 30 MB | Go binary, static file serving, reverse proxy |
| **Elasticsearch 8 (Optional)** | Limit: 768 MB / Reserve: 512 MB | Disabled by default. Enabled only via `--profile search` |
| **Ubuntu OS & Daemons** | ~250 MB – 300 MB | Minimal Ubuntu LTS installation, systemd |
| **Total Memory (without ES)** | **~600 MB – 900 MB** | Lightweight (~40% RAM utilization) |
| **Total Memory (with ES)** | **~1,400 MB – 1,700 MB** | Fits safely within 2 GiB threshold |
| **Swap Space (Safety Net)** | **2,048 MB (2 GB)** | Prevents OOM kills during Docker builds or load spikes |

---

## 3. Prerequisites & DNS Configuration

### 3.1 DNS A Record
In your DNS provider (e.g., Cloudflare, Route 53, Namecheap):
1. Create an **A Record**:
   - **Host / Name:** `scheduler` (or `scheduler.ramkumar.app`)
   - **Type:** `A`
   - **Value / Points to:** `<YOUR_EC2_ELASTIC_IP>`
   - **TTL:** `300` seconds (5 minutes)
2. *Important (if using Cloudflare):* Set Proxy status to **DNS Only** (Grey Cloud) during initial setup so Caddy can solve the ACME HTTP-01 challenge directly.

### 3.2 Neon PostgreSQL Database
1. Log in to [Neon Console](https://console.neon.tech/).
2. Create or select a project in `ap-south-1` (Mumbai) or the closest AWS region.
3. Copy the pooled or direct connection string (ensure `?sslmode=require` is present):
   ```
   postgresql://neondb_owner:YOUR_SECRET_PASSWORD@ep-sample-pool.ap-south-1.aws.neon.tech/neondb?sslmode=require
   ```

---

## 4. AWS Security Group Configuration

In the AWS EC2 Management Console, configure the Security Group:

### Inbound Rules (Strictly Minimal)

| Type | Protocol | Port Range | Source | Description |
| :--- | :--- | :--- | :--- | :--- |
| **SSH** | TCP | `22` | `YOUR_ADMIN_IP/32` (or your bastion CIDR) | Remote administration |
| **HTTP** | TCP | `80` | `0.0.0.0/0` | Let's Encrypt ACME challenge & HTTP to HTTPS redirect |
| **HTTPS** | TCP | `443` | `0.0.0.0/0` | Secure public web and API traffic |

> [!CAUTION]
> **Never open ports 4000, 6379, 9200, or 5432 to `0.0.0.0/0`.** All inter-service traffic flows exclusively over Docker's internal bridge network.

---

## 5. EC2 Server Provisioning & Hardening

SSH into your Ubuntu EC2 instance:

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

### 5.3 Configure Virtual Memory for Elasticsearch (if used)
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

---

## 6. Repository Setup & Configuration

Clone the project repository:
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

### Required Variables in `.env`:
```dotenv
NODE_ENV=production
PORT=4000

# Neon PostgreSQL connection string (must include ?sslmode=require)
DATABASE_URL="postgresql://neondb_owner:YOUR_SECRET_PASSWORD@ep-sample-pool.ap-south-1.aws.neon.tech/neondb?sslmode=require"

# Docker Internal Service Connections
REDIS_URL=redis://redis:6379

# Elasticsearch (default: false for lightweight t3.small operation)
ELASTICSEARCH_ENABLED=false
ELASTICSEARCH_URL=http://elasticsearch:9200

# Public Origin
FRONTEND_URL=https://scheduler.ramkumar.app

# Secure 64-character JWT Secret (Generate via: openssl rand -hex 32)
JWT_SECRET=paste_generated_hex_secret_here

# Protected Bull Board Admin Credentials (Required in production)
ADMIN_ENABLED=true
ADMIN_USERNAME=admin
ADMIN_PASSWORD=paste_strong_admin_password_here

# Guard: strictly false in production (prevents dev fallback)
ALLOW_DEV_AUTH=false

# Google OAuth 2.0 Credentials
GOOGLE_CLIENT_ID=your_google_client_id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_CALLBACK_URL=https://scheduler.ramkumar.app/api/auth/google/callback

# Slack OAuth 2.0 Credentials
SLACK_CLIENT_ID=your_slack_client_id
SLACK_CLIENT_SECRET=your_slack_client_secret
SLACK_CALLBACK_URL=https://scheduler.ramkumar.app/api/slack/callback

# Worker Configuration
WORKER_CONCURRENCY=5
MIN_SEND_DELAY_MS=200
EMBEDDED_WORKER=false
```

Generate a random 64-character hex key for `JWT_SECRET`:
```bash
openssl rand -hex 32
```

---

## 8. Neon PostgreSQL Schema Deployment (Prisma Migrate Deploy)

> [!IMPORTANT]
> In production, **always use `prisma migrate deploy`**. Never run `prisma migrate dev` against production databases.

### Running Migrations via Transient Docker Container:
```bash
cd /home/ubuntu/scheduler

# 1. Build backend image
docker compose -f docker-compose.prod.yml build backend

# 2. Deploy migrations to Neon
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy
```

*(Optional: If you need to create production senders, do so through the application API or seed script targeting Neon).*

---

## 9. Launching the Production Stack

### Mode A: Standard Lightweight Stack (Recommended for `t3.small`)
Runs Caddy, Backend API, BullMQ Worker, and Redis 7 (Elasticsearch disabled, saving ~600MB RAM):
```bash
cd /home/ubuntu/scheduler
docker compose -f docker-compose.prod.yml up -d --build
```

### Mode B: Full Stack with Elasticsearch
Runs all services plus Elasticsearch 8.15.3 (Ensure `ELASTICSEARCH_ENABLED=true` in `.env`):
```bash
cd /home/ubuntu/scheduler
docker compose -f docker-compose.prod.yml --profile search up -d --build
```

### 9.1 Verify Container Status
```bash
docker compose -f docker-compose.prod.yml ps
```

Expected healthy output:
```
NAME                    IMAGE                         COMMAND                  SERVICE         STATUS                   PORTS
reachinbox_backend_prod reachinbox-scheduler-backend  "node dist/server.js"    backend         running                  
reachinbox_caddy_prod   reachinbox-scheduler-caddy    "caddy run --config …"   caddy           running                  0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp
reachinbox_redis_prod   redis:7-alpine                "redis-server --appe…"   redis           running (healthy)        
reachinbox_worker_prod  reachinbox-scheduler-backend  "node dist/worker.js"    worker          running                  
```

### 9.2 Inspect Logs
```bash
# Follow live logs for all services
docker compose -f docker-compose.prod.yml logs -f

# Check Caddy SSL certificate acquisition
docker compose -f docker-compose.prod.yml logs -f caddy

# Check Express API startup
docker compose -f docker-compose.prod.yml logs -f backend

# Check BullMQ Worker
docker compose -f docker-compose.prod.yml logs -f worker
```

---

## 10. End-to-End Verification & Health Checks

### 10.1 Liveness & Readiness Probes
```bash
# Liveness Probe (verifies HTTP event loop is responding)
curl -i https://scheduler.ramkumar.app/health/live

# Readiness Probe (verifies PostgreSQL & Redis connectivity)
curl -i https://scheduler.ramkumar.app/health/ready

# Primary Probe (verifies overall system health)
curl -i https://scheduler.ramkumar.app/health
```

**Expected Readiness Response (`200 OK`):**
```json
{
  "status": "ready",
  "check": "readiness",
  "service": "reachinbox-scheduler-backend",
  "environment": "production",
  "timestamp": "2026-10-27T12:00:00.000Z",
  "uptimeSeconds": 45,
  "dependencies": {
    "postgres": { "status": "connected", "latencyMs": 14 },
    "redis": { "status": "connected", "latencyMs": 2 },
    "elasticsearch": { "status": "disabled" }
  }
}
```

### 10.2 Production Authentication Verification
Verify that unauthenticated requests receive HTTP 401 and cannot bypass authentication:
```bash
# Must return HTTP 401 Unauthorized
curl -i https://scheduler.ramkumar.app/api/emails/scheduled

# Must return HTTP 401 Unauthorized
curl -i -X POST https://scheduler.ramkumar.app/api/emails/schedule \
  -H "Content-Type: application/json" \
  -d '{"subject":"Test","body":"Test","recipients":["test@example.com"]}'
```

### 10.3 Bull Board Admin Access Verification
```bash
# Without credentials -> HTTP 401 Unauthorized
curl -i https://scheduler.ramkumar.app/admin/queues

# With configured credentials -> HTTP 200 OK
curl -i -u admin:YOUR_ADMIN_PASSWORD https://scheduler.ramkumar.app/admin/queues
```
In your browser, visit `https://scheduler.ramkumar.app/admin/queues` and enter your configured `ADMIN_USERNAME` and `ADMIN_PASSWORD` in the browser prompt.

### 10.4 Web Dashboard Verification
Open `https://scheduler.ramkumar.app` in your browser:
- The React SPA loads over HTTPS.
- Direct navigation to any URL or page refresh works seamlessly due to Caddy SPA fallback (`try_files {path} /index.html`).
- Google OAuth login works and sets a secure `token` cookie.
- Search works with PostgreSQL fallback (or Elasticsearch if enabled).

---

## 11. OAuth 2.0 Credentials Setup (Google & Slack)

### 11.1 Google Cloud Console
1. Visit [Google Cloud Console Credentials](https://console.cloud.google.com/apis/credentials).
2. Edit your **OAuth 2.0 Client ID** (Web application):
   - **Authorized JavaScript origins:** `https://scheduler.ramkumar.app`
   - **Authorized redirect URIs:** `https://scheduler.ramkumar.app/api/auth/google/callback`
3. Save changes.

### 11.2 Slack App Console
1. Visit [Slack API Apps](https://api.slack.com/apps).
2. Under **OAuth & Permissions**:
   - **Redirect URLs:** `https://scheduler.ramkumar.app/api/slack/callback`
   - **Bot Token Scopes:** `incoming-webhook`, `chat:write`
3. Save changes.

---

## 12. Ongoing Maintenance, Updates & Rollbacks

### 12.1 Deploying Code Updates (Zero Downtime)
```bash
cd /home/ubuntu/scheduler

# 1. Pull latest code
git pull origin main

# 2. Run new migrations if schema changed
docker compose -f docker-compose.prod.yml run --rm backend npx prisma migrate deploy

# 3. Rebuild and restart updated containers
docker compose -f docker-compose.prod.yml up -d --build

# 4. Remove dangling Docker images to free disk space
docker image prune -f
```

### 12.2 Instant Rollback Procedure
If a deployment needs to be reverted:
```bash
cd /home/ubuntu/scheduler

# Check recent commit history
git log --oneline -n 5

# Checkout the previous known-good commit
git checkout <PREVIOUS_COMMIT_HASH>

# Rebuild and restart containers
docker compose -f docker-compose.prod.yml up -d --build
```

### 12.3 Service Control Commands
```bash
# View resource consumption (CPU & RAM)
docker stats --no-stream

# Restart worker
docker compose -f docker-compose.prod.yml restart worker

# Restart backend API
docker compose -f docker-compose.prod.yml restart backend

# Stop entire stack cleanly
docker compose -f docker-compose.prod.yml stop
```

---

## 13. Troubleshooting & Diagnostics

### Issue 1: Bull Board Returns 503 Service Unavailable
- **Cause:** In production, `ADMIN_PASSWORD` is either missing or shorter than 8 characters in `.env`.
- **Fix:** Set a strong password in `.env` (`ADMIN_PASSWORD=...`) and restart backend:
  ```bash
  docker compose -f docker-compose.prod.yml up -d backend
  ```

### Issue 2: Health Check Returns 503 Unhealthy
- **Cause:** PostgreSQL or Redis is unreachable.
- **Diagnostic:** Check `/health/ready` response payload to identify which dependency failed.
- **Fixes:**
  - If `postgres` is disconnected: verify Neon connection string and network reachability. Ensure `?sslmode=require` is present.
  - If `redis` is disconnected: check `docker compose -f docker-compose.prod.yml logs redis`.

### Issue 3: Caddy Fails to Obtain TLS Certificate
- **Diagnostic:** Check Caddy logs: `docker compose -f docker-compose.prod.yml logs caddy`.
- **Causes & Fixes:**
  1. *DNS not propagated:* Run `dig +short scheduler.ramkumar.app` and confirm it returns your Elastic IP.
  2. *Port 80 blocked:* Ensure AWS Security Group permits inbound HTTP (port 80) from `0.0.0.0/0`.
  3. *Cloudflare Proxy:* Temporarily set Cloudflare proxy to "DNS Only" (Grey Cloud) during initial certificate issuance.

### Issue 4: Container Out of Memory (OOM) Termination
- **Diagnostic:** Check kernel logs: `sudo dmesg -T | grep -i oom`.
- **Fix:** Verify 2GB swapfile is active (`free -m`). If Elasticsearch is enabled and causing memory pressure, disable it (`ELASTICSEARCH_ENABLED=false` in `.env`) and run without `--profile search`.
