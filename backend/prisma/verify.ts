import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function verify() {
  console.log('\n🔍 Verifying ReachInbox database contents via Prisma...');

  const [userCount, senderCount, batchCount, emailCount] = await Promise.all([
    prisma.user.count(),
    prisma.sender.count(),
    prisma.emailBatch.count(),
    prisma.email.count(),
  ]);

  console.log('📊 Table Record Counts:');
  console.log(`   - Users:          ${userCount}`);
  console.log(`   - Senders:        ${senderCount}`);
  console.log(`   - Email Batches:  ${batchCount}`);
  console.log(`   - Emails:         ${emailCount}`);

  const senders = await prisma.sender.findMany({
    select: {
      id: true,
      email: true,
      smtpHost: true,
      smtpPort: true,
      smtpUsername: true,
      hourlyLimit: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
        },
      },
    },
  });

  console.log('\n📬 Configured Senders (Sensitive Credentials Masked):');
  for (const s of senders) {
    console.log(`   • [${s.id}]`);
    console.log(`     Email:        ${s.email}`);
    console.log(`     Tenant User:  ${s.user.name} <${s.user.email}>`);
    console.log(`     SMTP Server:  ${s.smtpHost}:${s.smtpPort} (user: ${s.smtpUsername})`);
    console.log(`     Hourly Limit: ${s.hourlyLimit} emails/hr`);
    console.log(`     Created At:   ${s.createdAt.toISOString()}`);
  }

  console.log('\n✅ Database verification query succeeded.\n');
}

verify()
  .catch((err) => {
    console.error('❌ Database verification failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
