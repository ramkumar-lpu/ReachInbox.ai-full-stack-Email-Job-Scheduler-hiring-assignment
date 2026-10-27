# Multi-stage production Dockerfile for ReachInbox Backend
FROM node:22-alpine AS builder

WORKDIR /app

# Install OpenSSL for Prisma engine compatibility on Alpine
RUN apk add --no-cache openssl

# Copy dependency definitions
COPY package*.json ./
COPY prisma ./prisma/

# Install all dependencies including devDependencies for build
RUN npm ci

# Copy source code and build config
COPY tsconfig.json ./
COPY src ./src

# Generate typed Prisma Client and compile TypeScript to dist/
RUN npx prisma generate
RUN npm run build

# =============================================================================
# Production Image
# =============================================================================
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install OpenSSL for Prisma runtime compatibility on Alpine
RUN apk add --no-cache openssl

# Copy package manifests and production dependencies only
COPY package*.json ./
COPY prisma ./prisma/
RUN npm ci --omit=dev

# Generate Prisma Client in production environment
RUN npx prisma generate

# Copy compiled JavaScript output
COPY --from=builder /app/dist ./dist

EXPOSE 4000

CMD ["node", "dist/server.js"]
