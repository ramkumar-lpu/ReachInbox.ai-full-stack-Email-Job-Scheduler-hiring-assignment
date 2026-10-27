import nodemailer from 'nodemailer';
import { prisma } from '../src/db/client';

async function generateEthereal() {
  console.log('🧪 Generating live Ethereal test SMTP credentials via Nodemailer...');
  const testAccount = await nodemailer.createTestAccount();

  console.log('\n=======================================================');
  console.log('✨ Live Ethereal Test Account Created:');
  console.log(`   Host:     ${testAccount.smtp.host}`);
  console.log(`   Port:     ${testAccount.smtp.port}`);
  console.log(`   Username: ${testAccount.user}`);
  console.log(`   Password: ${testAccount.pass}`);
  console.log('=======================================================\n');

  // Automatically update development sender in PostgreSQL
  const devUser = await prisma.user.findUnique({
    where: { email: 'dev@reachinbox.test' },
  });

  if (devUser) {
    const updated = await prisma.sender.updateMany({
      where: {
        userId: devUser.id,
        email: 'alpha-sender@reachinbox.test',
      },
      data: {
        smtpHost: testAccount.smtp.host,
        smtpPort: testAccount.smtp.port,
        smtpUsername: testAccount.user,
        smtpPassword: testAccount.pass,
      },
    });

    console.log(
      `✅ Updated development sender "alpha-sender@reachinbox.test" with live Ethereal credentials! (${updated.count} record(s) updated)`
    );
    console.log('📬 Any email scheduled with this sender will now be delivered to Ethereal with web preview links.\n');
  } else {
    console.log('⚠️ Development user not found. Run "npm run db:seed" first.');
  }

  await prisma.$disconnect();
}

generateEthereal().catch((err) => {
  console.error('Failed to create Ethereal account:', err);
  process.exit(1);
});
