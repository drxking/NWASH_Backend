import express from 'express';
import { PrismaClient } from '@prisma/client';
import { requestContext, sendError } from './http.js';

export function createApp({ prisma = new PrismaClient() } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestContext);
  app.get('/api/v1/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/v1/ready', async (req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      await req.app.locals.issueStorage?.checkReady();
      return res.json({ status: 'ok' });
    } catch {
      return sendError(res, 'SERVICE_UNAVAILABLE');
    }
  });
  return { app, prisma };
}
