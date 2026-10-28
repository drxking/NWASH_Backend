import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { seedDevelopmentAccount } from '../src/seed.js';

if (existsSync('.env')) process.loadEnvFile('.env');

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Development seed is disabled in production');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const prisma = new PrismaClient();
  try {
    const result = await seedDevelopmentAccount(prisma, {
      fullName: process.env.SEED_FULL_NAME,
      email: process.env.SEED_EMAIL,
      password: process.env.SEED_PASSWORD,
    });
    console.log(`Development account ${result}.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(() => {
  console.error('Development seed failed. Check seed variables and database availability.');
  process.exitCode = 1;
});
