import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { authenticate } from './auth.js';
import { ApiError, logServerError, sendError } from './http.js';
import { parseMetadata, matchFiles, fingerprint, issueResponse, encodeCursor, decodeCursor } from './issue-contract.js';
import { verifyMedia } from './media-validation.js';
import { parseIssueMultipart } from './multipart.js';
import { RateLimiter } from './rate-limit.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const clientId = /^[A-Za-z0-9_-]{1,128}$/;
const attachmentOrder = { clientAttachmentId: 'asc' };
const includeAttachments = { attachments: { orderBy: attachmentOrder } };
const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'audio/mp4': 'm4a' };

async function ensureFiles(row, storage) {
  for (const attachment of row.attachments) {
    if (!await storage.exists(attachment.storageKey, attachment.sizeBytes)) throw new ApiError('SERVICE_UNAVAILABLE');
  }
}

function errorResponse(req, res, error) {
  if (error instanceof ApiError) return sendError(res, error.code, error.details);
  if (error instanceof Prisma.PrismaClientInitializationError || ['P1001', 'P1002', 'P1017'].includes(error?.code) || ['ENOSPC', 'EROFS', 'EACCES'].includes(error?.code)) {
    logServerError(req, 'SERVICE_UNAVAILABLE');
    return sendError(res, 'SERVICE_UNAVAILABLE');
  }
  logServerError(req, error?.code || 'INTERNAL_ERROR');
  return sendError(res, 'INTERNAL_ERROR');
}

export function installIssueRoutes(app, prisma, config, storage) {
  const auth = authenticate(prisma, config);
  const limiter = new RateLimiter();
  app.locals.issueStorage = storage;
  app.use('/api/v1/issues', (_req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });

  app.post('/api/v1/issues', auth, async (req, res) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const ipRetry = limiter.check(`upload:ip:${ip}`, config.uploadIpLimit, config.uploadWindowMs);
    const userRetry = limiter.check(`upload:user:${req.authUser.id}`, config.uploadUserLimit, config.uploadWindowMs);
    if (ipRetry || userRetry) return sendError(res, 'RATE_LIMITED', [], Math.max(ipRetry, userRetry));
    const headerKey = req.get('Idempotency-Key');
    if (!headerKey || !clientId.test(headerKey)) return sendError(res, 'VALIDATION_ERROR', [{ field: 'Idempotency-Key', reason: 'Valid client issue id required' }]);
    let stagedFiles = [];
    const promotedKeys = [];
    try {
      const parsed = await parseIssueMultipart(req, storage, config);
      stagedFiles = parsed.files;
      const metadata = parseMetadata(parsed.metadataRaw, config);
      const filesById = matchFiles(metadata, stagedFiles, headerKey);
      for (const item of metadata.attachments) {
        const file = filesById.get(item.clientAttachmentId);
        const maximum = item.kind === 'photo' ? config.maxPhotoBytes : config.maxAudioBytes;
        if (file.sizeBytes > maximum) throw new ApiError('PAYLOAD_TOO_LARGE', [{ field: file.fieldName, reason: 'Per-file limit exceeded' }]);
        file.mimeType = await verifyMedia(file);
      }
      const contentFingerprint = fingerprint(metadata, filesById);
      const ownerId = req.authUser.id;
      let replayed = false;
      let row;
      try {
        row = await prisma.$transaction(async (tx) => {
          const existing = await tx.issue.findUnique({ where: { ownerId_clientIssueId: { ownerId, clientIssueId: metadata.clientIssueId } }, include: includeAttachments });
          if (existing) {
            if (existing.fingerprint !== contentFingerprint) throw new ApiError('ISSUE_CONTENT_CONFLICT');
            replayed = true;
            return existing;
          }
          const attachments = [];
          for (const item of metadata.attachments) {
            const file = filesById.get(item.clientAttachmentId);
            const storageKey = await storage.promote(file, file.mimeType);
            promotedKeys.push(storageKey);
            attachments.push({
              id: randomUUID(), clientAttachmentId: item.clientAttachmentId, kind: item.kind,
              mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256, storageKey,
              createdAt: new Date(item.createdAt), durationMs: item.durationMs,
            });
          }
          await storage.beforeCommit();
          return tx.issue.create({
            data: {
              id: randomUUID(), ownerId, clientIssueId: metadata.clientIssueId,
              clientCreatedAt: new Date(metadata.clientCreatedAt), clientUpdatedAt: new Date(metadata.clientUpdatedAt),
              description: metadata.description, locationStatus: metadata.locationStatus,
              locationSource: metadata.locationSource, latitude: metadata.location?.latitude ?? null,
              longitude: metadata.location?.longitude ?? null, accuracy: metadata.location?.accuracy ?? null,
              locationTimestamp: metadata.location ? BigInt(metadata.location.timestamp) : null,
              fingerprint: contentFingerprint, attachments: { create: attachments },
            },
            include: includeAttachments,
          });
        }, { timeout: 120000, maxWait: 30000 });
      } catch (error) {
        await storage.removePromoted(promotedKeys);
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          row = await prisma.issue.findUnique({ where: { ownerId_clientIssueId: { ownerId, clientIssueId: metadata.clientIssueId } }, include: includeAttachments });
          if (!row) throw error;
          if (row.fingerprint !== contentFingerprint) throw new ApiError('ISSUE_CONTENT_CONFLICT');
          replayed = true;
        } else throw error;
      }
      await ensureFiles(row, storage);
      return res.status(replayed ? 200 : 201).json({ issue: issueResponse(row), replayed });
    } catch (error) {
      if (error.stagedFiles) stagedFiles = error.stagedFiles;
      if (res.destroyed || req.aborted) return;
      return errorResponse(req, res, error);
    } finally {
      await storage.removeStaged(stagedFiles);
    }
  });

  app.get('/api/v1/issues', auth, async (req, res) => {
    try {
      const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError('VALIDATION_ERROR', [{ field: 'limit', reason: 'Must be 1–100' }]);
      const cursor = req.query.cursor === undefined ? null : decodeCursor(req.query.cursor);
      const ownerId = req.authUser.id;
      const rows = await prisma.issue.findMany({
        where: { ownerId, ...(cursor ? { OR: [{ clientCreatedAt: { lt: new Date(cursor.date) } }, { clientCreatedAt: new Date(cursor.date), id: { lt: cursor.id } }] } : {}) },
        orderBy: [{ clientCreatedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: includeAttachments,
      });
      const page = rows.slice(0, limit);
      for (const row of page) await ensureFiles(row, storage);
      res.json({ issues: page.map(issueResponse), nextCursor: rows.length > limit ? encodeCursor(page.at(-1)) : null });
    } catch (error) { errorResponse(req, res, error); }
  });

  app.get('/api/v1/issues/:id', auth, async (req, res) => {
    try {
      if (!uuid.test(req.params.id)) return sendError(res, 'NOT_FOUND');
      const row = await prisma.issue.findFirst({ where: { id: req.params.id, ownerId: req.authUser.id }, include: includeAttachments });
      if (!row) return sendError(res, 'NOT_FOUND');
      await ensureFiles(row, storage);
      return res.json({ issue: issueResponse(row) });
    } catch (error) { return errorResponse(req, res, error); }
  });

  app.get('/api/v1/issues/:issueId/attachments/:attachmentId/content', auth, async (req, res) => {
    try {
      if (!uuid.test(req.params.issueId) || !uuid.test(req.params.attachmentId)) return sendError(res, 'NOT_FOUND');
      const item = await prisma.attachment.findFirst({ where: { id: req.params.attachmentId, issueId: req.params.issueId, issue: { ownerId: req.authUser.id } } });
      if (!item) return sendError(res, 'NOT_FOUND');
      const path = storage.pathFor(item.storageKey);
      let size;
      try { size = (await stat(path)).size; } catch { throw new ApiError('SERVICE_UNAVAILABLE'); }
      if (size !== item.sizeBytes) throw new ApiError('SERVICE_UNAVAILABLE');
      res.set({ 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' });
      const range = req.get('Range');
      let start = 0;
      let end = size - 1;
      if (range !== undefined) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) {
          res.set('Content-Range', `bytes */${size}`);
          return res.status(416).json({ error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Requested range cannot be satisfied.', details: [] }, requestId: req.requestId });
        }
        if (!match[1]) {
          const suffix = Number(match[2]);
          start = Math.max(0, size - suffix);
        } else {
          start = Number(match[1]);
          if (match[2]) end = Number(match[2]);
        }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size || (!match[1] && Number(match[2]) === 0)) {
          res.set('Content-Range', `bytes */${size}`);
          return res.status(416).json({ error: { code: 'RANGE_NOT_SATISFIABLE', message: 'Requested range cannot be satisfied.', details: [] }, requestId: req.requestId });
        }
        end = Math.min(end, size - 1);
      }
      res.set({
        'Content-Type': item.mimeType,
        'Content-Length': String(end - start + 1),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename="${item.id}.${extensions[item.mimeType]}"`,
      });
      if (range !== undefined) res.status(206).set('Content-Range', `bytes ${start}-${end}/${size}`);
      const stream = createReadStream(path, { start, end });
      res.on('close', () => stream.destroy());
      stream.on('error', () => {
        if (!res.headersSent) {
          res.removeHeader('Content-Length');
          res.removeHeader('Content-Type');
          sendError(res, 'SERVICE_UNAVAILABLE');
        }
        else res.destroy();
      });
      stream.pipe(res);
    } catch (error) { return errorResponse(req, res, error); }
  });
}
