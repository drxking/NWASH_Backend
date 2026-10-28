import { existsSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { IssueStorage } from '../src/issue-storage.js';

if (existsSync('.env') && !process.env.DATABASE_URL) process.loadEnvFile('.env');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const storage = new IssueStorage(process.env.UPLOAD_DIR || './uploads');
const prisma = new PrismaClient();
const remove = process.argv.includes('--delete');
const graceMs = 24 * 60 * 60 * 1000;

try {
  await storage.initialize();
  const committed = new Set((await prisma.attachment.findMany({ select: { storageKey: true } })).map((item) => item.storageKey));
  const candidates = [];
  for (const directory of [storage.stagingDir, storage.objectsDir]) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const info = await stat(path);
      if (!info.isFile() || Date.now() - info.mtimeMs < graceMs) continue;
      if (directory === storage.objectsDir && committed.has(name)) continue;
      candidates.push(path);
    }
  }
  if (remove) await Promise.all(candidates.map((path) => rm(path, { force: true })));
  console.log(JSON.stringify({ candidates: candidates.length, deleted: remove ? candidates.length : 0, dryRun: !remove }));
} finally {
  await prisma.$disconnect();
}
