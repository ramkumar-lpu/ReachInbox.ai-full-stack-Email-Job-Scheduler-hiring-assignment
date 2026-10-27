import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

// Ensure environment variables are loaded
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = new PrismaClient();

interface SeedSenderInput {
  email: string;
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  hourlyLimit: number;
}

const DEV_SENDERS: SeedSenderInput[] = [
  {
    email: 'alpha-sender@reachinbox.test',
    smtpHost: 'smtp.ethereal.email',
    smtpPort: 587,
    smtpUsername: 'dev_alpha@ethereal.email',
    smtpPassword: 'dev_placeholder_password_alpha',
    hourlyLimit: 100,
  },
  {
    email: 'beta-sender@reachinbox.test',
    smtpHost: 'smtp.ethereal.email',
    smtpPort: 587,
    smtpUsername: 'dev_beta@ethereal.email',
    smtpPassword: 'dev_placeholder_password_beta',
    hourlyLimit: 50,
  },
];

async function main() {
  console.log('🌱 Starting database seed for ReachInbox Scheduler...');

  // 1. Upsert a default development user
  const devUser = await prisma.user.upsert({
    where: { email: 'dev@reachinbox.test' },
    update: {
      name: 'ReachInbox Development User',
    },
    create: {
      email: 'dev@reachinbox.test',
      name: 'ReachInbox Development User',
      avatarUrl: 'https://avatar.iran.liara.run/public/boy',
    },
  });

  console.log(`👤 Verified development user: ${devUser.email} (ID: ${devUser.id})`);

  // 2. Idempotently upsert development sender identities
  for (const senderData of DEV_SENDERS) {
    const sender = await prisma.sender.upsert({
      where: {
        userId_email: {
          userId: devUser.id,
          email: senderData.email,
        },
      },
      update: {
        smtpHost: senderData.smtpHost,
        smtpPort: senderData.smtpPort,
        smtpUsername: senderData.smtpUsername,
        hourlyLimit: senderData.hourlyLimit,
        // Existing password is preserved if already set
      },
      create: {
        userId: devUser.id,
        email: senderData.email,
        smtpHost: senderData.smtpHost,
        smtpPort: senderData.smtpPort,
        smtpUsername: senderData.smtpUsername,
        smtpPassword: senderData.smtpPassword,
        hourlyLimit: senderData.hourlyLimit,
      },
      select: {
        id: true,
        email: true,
        smtpHost: true,
        smtpPort: true,
        smtpUsername: true,
        hourlyLimit: true,
        createdAt: true,
      },
    });

    // Notice: smtpPassword is intentionally excluded from the select and console output
    console.log(`📧 Seeded sender identity [${sender.email}]:`, {
      id: sender.id,
      email: sender.email,
      smtpHost: sender.smtpHost,
      smtpPort: sender.smtpPort,
      smtpUsername: sender.smtpUsername,
      hourlyLimit: sender.hourlyLimit,
    });
  }

  console.log('\n⚠️  SECURITY NOTICE:');
  console.log('   The seeded senders use placeholder development credentials.');
  console.log('   They cannot send real mail until valid SMTP/Ethereal accounts are configured.');
  console.log('✅ Seeding completed successfully (idempotent).\n');
}

main()
  .catch((e) => {
    console.error('❌ Database seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
