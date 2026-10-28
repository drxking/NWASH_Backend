import { existsSync } from 'node:fs';
import { createApp } from './app.js';
import { installAuthRoutes } from './auth.js';
import { loadConfig } from './config.js';
import { IssueStorage } from './issue-storage.js';
import { installIssueRoutes } from './issues.js';
import { installApiFallback } from './http.js';

if (existsSync('.env')) process.loadEnvFile('.env');

async function main() {
  const config = loadConfig();
  const { app, prisma } = createApp();
  const storage = new IssueStorage(config.uploadDir);
  app.set('trust proxy', config.trustProxyHops === 0 ? false : config.trustProxyHops);
  await storage.initialize();
  await prisma.$connect();
  await installAuthRoutes(app, prisma, config);
  installIssueRoutes(app, prisma, config, storage);
  installApiFallback(app);
  const server = app.listen(config.port, config.host, () => {
    console.log(`NWASH API listening on ${config.host}:${config.port}`);
  });
  const shutdown = () => {
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((error) => {
  const code = error?.errorCode || error?.code;
  console.error(`Failed to start NWASH API${code ? ` (${code})` : ''}. Check environment configuration and database availability.`);
  process.exitCode = 1;
});
