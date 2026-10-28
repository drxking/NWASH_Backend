import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
  console.error('TEST_DATABASE_URL is required for integration tests.');
  process.exit(1);
}
const databaseIdentity = (value) => {
  const parsed = new URL(value);
  return `${parsed.hostname.toLowerCase()}:${parsed.port || '5432'}${parsed.pathname}`;
};
if (process.env.DATABASE_URL && databaseIdentity(testUrl) === databaseIdentity(process.env.DATABASE_URL)) {
  console.error('TEST_DATABASE_URL must differ from DATABASE_URL.');
  process.exit(1);
}
const prismaExecutable = resolve('node_modules/.bin/prisma');
const result = spawnSync(prismaExecutable, ['migrate', 'deploy'], {
  env: { ...process.env, DATABASE_URL: testUrl },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
