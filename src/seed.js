import { Prisma } from '@prisma/client';
import { hashPassword, normalizeEmail, normalizeFullName, validPassword } from './security.js';

export async function seedDevelopmentAccount(prisma, input) {
  const fullName = normalizeFullName(input.fullName);
  const email = normalizeEmail(input.email);
  if (!fullName || !email || !validPassword(input.password)) {
    throw new Error('SEED_FULL_NAME, SEED_EMAIL, and SEED_PASSWORD must meet signup requirements');
  }
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) return 'already-exists';
  const passwordHash = await hashPassword(input.password);
  try {
    await prisma.$transaction(async (tx) => tx.user.create({ data: { fullName, email, passwordHash } }));
    return 'created';
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return 'already-exists';
    throw error;
  }
}
