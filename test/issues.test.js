import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import { installAuthRoutes } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { installIssueRoutes } from '../src/issues.js';
import { IssueStorage } from '../src/issue-storage.js';
import { installApiFallback } from '../src/http.js';

if (existsSync('.env')) process.loadEnvFile('.env');
const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || testUrl === process.env.DATABASE_URL) throw new Error('Separate TEST_DATABASE_URL required');

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url));
const password = 'test password 123';
const secret = 'test-only-issue-secret-at-least-32-bytes-long';
const createdAt = '2026-10-28T12:00:00.000Z';

function metadata(overrides = {}) {
  return {
    clientIssueId: randomUUID(), clientCreatedAt: createdAt,
    clientUpdatedAt: '2026-10-28T12:10:00.000Z', description: 'Water leak',
    locationStatus: 'none', attachments: [], ...overrides,
  };
}

function descriptor(id, kind, extra = {}) {
  return { clientAttachmentId: id, kind, createdAt: createdAt, ...extra };
}

async function makeServer(prisma, config, storage) {
  const { app } = createApp({ prisma });
  app.set('trust proxy', false);
  await installAuthRoutes(app, prisma, config);
  installIssueRoutes(app, prisma, config, storage);
  installApiFallback(app);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}/api/v1` };
}

async function setup(overrides = {}) {
  const uploadDir = mkdtempSync(join(tmpdir(), 'nwash-issues-'));
  const prisma = new PrismaClient({ datasources: { db: { url: testUrl } } });
  const storage = new IssueStorage(uploadDir);
  await storage.initialize();
  await prisma.$connect();
  const config = { ...loadConfig({ DATABASE_URL: testUrl, JWT_SECRET: secret }), uploadIpLimit: 1000, uploadUserLimit: 1000, ...overrides };
  let live = await makeServer(prisma, config, storage);
  const emails = [];
  const signup = async () => {
    const email = `issue-${randomUUID()}@example.com`;
    emails.push(email);
    const result = await fetch(`${live.base}/auth/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fullName: 'Issue Tester', email, password }) });
    assert.equal(result.status, 201);
    return { ...(await result.json()), email };
  };
  return {
    prisma, storage, config, signup, emails,
    get base() { return live.base; },
    async restart() {
      await new Promise((resolve) => live.server.close(resolve));
      live = await makeServer(prisma, config, storage);
    },
    async stop() { await new Promise((resolve) => live.server.close(resolve)); },
    async close() {
      if (live.server.listening) await new Promise((resolve) => live.server.close(resolve));
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
      await prisma.$disconnect();
      rmSync(uploadDir, { recursive: true, force: true });
    },
  };
}

async function upload(ctx, token, meta, parts = [], options = {}) {
  const form = new FormData();
  form.append('metadata', options.rawMetadata ?? JSON.stringify(meta));
  for (const part of parts) {
    form.append(part.fieldName ?? `media:${part.id}`, new Blob([part.bytes], { type: part.mime }), part.filename ?? `${part.id}.bin`);
  }
  if (options.extraField) form.append('unexpected', 'x');
  const response = await fetch(`${ctx.base}/issues`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Idempotency-Key': options.key ?? meta.clientIssueId }, body: form });
  return { response, body: await response.json() };
}

async function readJson(ctx, token, path) {
  const response = await fetch(`${ctx.base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { response, body: await response.json() };
}

test('uploads text-only, photo, audio, mixed evidence and optional location', async () => {
  const ctx = await setup();
  try {
    const user = await ctx.signup();
    const text = await upload(ctx, user.accessToken, metadata({ clientCreatedAt: '2025-01-01T00:00:00.000Z' }));
    assert.equal(text.response.status, 201);
    assert.equal(text.body.issue.attachments.length, 0);
    assert.equal(text.body.issue.location, null);
    const unavailable = await upload(ctx, user.accessToken, metadata({ locationStatus: 'unavailable' }));
    assert.equal(unavailable.response.status, 201);
    assert.equal(unavailable.body.issue.location, null);
    const jpg = await fixture('photo.jpg');
    const png = await fixture('photo.png');
    const m4a = await fixture('voice.m4a');
    const multi = metadata({ description: '', attachments: [descriptor('p1', 'photo'), descriptor('p2', 'photo'), descriptor('a1', 'audio', { durationMs: 9500 })], locationStatus: 'captured', locationSource: 'manual', location: { latitude: 27.67272, longitude: 85.34395, accuracy: 100, timestamp: 1793188800000 } });
    const result = await upload(ctx, user.accessToken, multi, [
      { id: 'a1', bytes: m4a, mime: 'audio/mp4' },
      { id: 'p2', bytes: png, mime: 'image/png' },
      { id: 'p1', bytes: jpg, mime: 'image/jpeg' },
    ]);
    assert.equal(result.response.status, 201);
    assert.equal(result.body.issue.attachments.length, 3);
    assert.equal(result.body.issue.location.timestamp, 1793188800000);
    assert.equal(result.body.issue.locationSource, 'manual');
    assert.equal(result.body.issue.attachments.find((x) => x.clientAttachmentId === 'a1').durationMs, 9500);
    const legacy = await upload(ctx, user.accessToken, metadata({ attachments: [descriptor('p1', 'photo')], description: '', locationStatus: 'captured', location: { latitude: 0, longitude: 0, accuracy: 0, timestamp: 1793188800000 } }), [{ id: 'p1', bytes: jpg, mime: 'image/jpeg' }]);
    assert.equal(legacy.response.status, 201);
    assert.equal(legacy.body.issue.locationSource, null);
    const audioOnly = await upload(ctx, user.accessToken, metadata({ description: ' ', attachments: [descriptor('a', 'audio', { durationMs: 0 })] }), [{ id: 'a', bytes: m4a, mime: 'audio/x-m4a' }]);
    assert.equal(audioOnly.response.status, 201);
    assert.equal(audioOnly.body.issue.attachments[0].mimeType, 'audio/mp4');
  } finally { await ctx.close(); }
});

test('rejects invalid evidence, location, multipart mapping, and media', async () => {
  const ctx = await setup();
  try {
    const user = await ctx.signup();
    const anonymous = await fetch(`${ctx.base}/issues`, { method: 'POST' });
    assert.equal(anonymous.status, 401);
    const retired = await fetch(`${ctx.base}/reports`);
    assert.equal(retired.status, 404);
    const jpg = await fixture('photo.jpg');
    const png = await fixture('photo.png');
    const m4a = await fixture('voice.m4a');
    const invalid = [
      metadata({ description: '   ' }),
      metadata({ description: '', locationStatus: 'captured', location: { latitude: 0, longitude: 0, accuracy: 1, timestamp: 1793188800000 } }),
      metadata({ locationStatus: 'pending' }),
      metadata({ locationStatus: 'captured', location: { latitude: 91, longitude: 0, accuracy: 1, timestamp: 1793188800000 } }),
      metadata({ locationStatus: 'captured', location: { latitude: 0, longitude: 0, accuracy: 1, timestamp: 1793188800 } }),
      metadata({ ownerId: user.user.id }),
      metadata({ status: 'pending_upload' }),
      metadata({ attachments: [descriptor('x', 'photo'), descriptor('x', 'photo')] }),
      metadata({ attachments: [descriptor('a', 'audio', { durationMs: -1 })] }),
    ];
    for (const meta of invalid) {
      const result = await upload(ctx, user.accessToken, meta);
      assert.equal(result.response.status, 400);
      assert.equal(result.body.error.code, 'VALIDATION_ERROR');
      assert.equal(typeof result.body.requestId, 'string');
    }
    const one = metadata({ attachments: [descriptor('p', 'photo')] });
    const cases = [
      [[], 400],
      [[{ id: 'p', bytes: jpg, mime: 'image/jpeg' }, { id: 'p', bytes: jpg, mime: 'image/jpeg' }], 400],
      [[{ id: 'extra', bytes: jpg, mime: 'image/jpeg' }], 400],
      [[{ id: 'p', bytes: png, mime: 'image/jpeg' }], 415],
      [[{ id: 'p', bytes: Buffer.alloc(0), mime: 'image/jpeg' }], 415],
      [[{ id: 'p', bytes: Buffer.from('ffd8ffe0', 'hex'), mime: 'image/jpeg' }], 415],
      [[{ id: 'p', bytes: jpg, mime: 'video/mp4' }], 415],
    ];
    for (const [parts, status] of cases) {
      const result = await upload(ctx, user.accessToken, { ...one, clientIssueId: randomUUID() }, parts);
      assert.equal(result.response.status, status);
    }
    const badKey = await upload(ctx, user.accessToken, one, [{ id: 'p', bytes: jpg, mime: 'image/jpeg' }], { key: 'different' });
    assert.equal(badKey.response.status, 400);
    const extra = await upload(ctx, user.accessToken, metadata(), [], { extraField: true });
    assert.equal(extra.response.status, 400);
    const traversal = await upload(ctx, user.accessToken, { ...one, clientIssueId: randomUUID() }, [{ id: 'p', bytes: jpg, mime: 'image/jpeg', filename: '../../private.txt' }]);
    assert.equal(traversal.response.status, 201);
    assert.match(traversal.body.issue.attachments[0].contentPath, /\/attachments\/[0-9a-f-]+\/content$/);
    const stored = await ctx.prisma.attachment.findUniqueOrThrow({ where: { id: traversal.body.issue.attachments[0].id } });
    assert.match(stored.storageKey, /^[0-9a-f-]{36}\.jpg$/);
    const wrongAudio = await upload(ctx, user.accessToken, metadata({ attachments: [descriptor('a', 'audio')] }), [{ id: 'a', bytes: m4a, mime: 'image/heic' }]);
    assert.equal(wrongAudio.response.status, 415);
  } finally { await ctx.close(); }
});

test('idempotency ignores part order and JSON key order, detects changed content, and handles concurrent retries', async () => {
  const ctx = await setup();
  try {
    const user = await ctx.signup();
    const jpg = await fixture('photo.jpg');
    const png = await fixture('photo.png');
    const meta = metadata({ attachments: [descriptor('p1', 'photo'), descriptor('p2', 'photo')] });
    const first = await upload(ctx, user.accessToken, meta, [{ id: 'p1', bytes: jpg, mime: 'image/jpeg' }, { id: 'p2', bytes: png, mime: 'image/png' }]);
    assert.equal(first.response.status, 201);
    const reordered = { attachments: [...meta.attachments].reverse(), description: meta.description, locationStatus: meta.locationStatus, clientUpdatedAt: meta.clientUpdatedAt, clientCreatedAt: meta.clientCreatedAt, clientIssueId: meta.clientIssueId };
    const retry = await upload(ctx, user.accessToken, reordered, [{ id: 'p2', bytes: png, mime: 'image/png', filename: 'changed.png' }, { id: 'p1', bytes: jpg, mime: 'image/jpeg', filename: 'changed.jpg' }]);
    assert.equal(retry.response.status, 200);
    assert.equal(retry.body.replayed, true);
    assert.equal(retry.body.issue.id, first.body.issue.id);
    const changed = await upload(ctx, user.accessToken, { ...meta, description: 'changed' }, [{ id: 'p1', bytes: jpg, mime: 'image/jpeg' }, { id: 'p2', bytes: png, mime: 'image/png' }]);
    assert.equal(changed.response.status, 409);
    assert.equal(changed.body.error.code, 'ISSUE_CONTENT_CONFLICT');
    const simultaneous = metadata();
    const results = await Promise.all([upload(ctx, user.accessToken, simultaneous), upload(ctx, user.accessToken, simultaneous)]);
    assert.deepEqual(results.map((r) => r.response.status).sort(), [200, 201]);
    assert.equal(results[0].body.issue.id, results[1].body.issue.id);
    assert.equal(await ctx.prisma.issue.count({ where: { ownerId: user.user.id, clientIssueId: simultaneous.clientIssueId } }), 1);
  } finally { await ctx.close(); }
});

test('enforces configured attachment count, per-file, metadata, and total-body limits', async () => {
  const ctx = await setup({ maxPhotos: 1, maxPhotoBytes: 100, maxMetadataBytes: 400, maxRequestBytes: 3000 });
  try {
    const user = await ctx.signup();
    const jpg = await fixture('photo.jpg');
    const tooLargeFile = await upload(ctx, user.accessToken, metadata({ attachments: [descriptor('p', 'photo')] }), [{ id: 'p', bytes: jpg, mime: 'image/jpeg' }]);
    assert.equal(tooLargeFile.response.status, 413);
    const tooMany = await upload(ctx, user.accessToken, metadata({ attachments: [descriptor('p1', 'photo'), descriptor('p2', 'photo')] }));
    assert.equal(tooMany.response.status, 413);
    const tooLargeMetadata = await upload(ctx, user.accessToken, metadata({ description: 'x'.repeat(500) }));
    assert.equal(tooLargeMetadata.response.status, 413);
    ctx.config.maxRequestBytes = 300;
    const tooLargeBody = await upload(ctx, user.accessToken, metadata());
    assert.equal(tooLargeBody.response.status, 413);
  } finally { await ctx.close(); }
});

test('authenticated upload rate limits include Retry-After', async () => {
  const ctx = await setup({ uploadIpLimit: 1, uploadUserLimit: 1 });
  try {
    const user = await ctx.signup();
    assert.equal((await upload(ctx, user.accessToken, metadata())).response.status, 201);
    const limited = await upload(ctx, user.accessToken, metadata());
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  } finally { await ctx.close(); }
});

test('owners are isolated; pagination follows client creation time and audio supports ranges', async () => {
  const ctx = await setup();
  try {
    const a = await ctx.signup();
    const b = await ctx.signup();
    const m4a = await fixture('voice.m4a');
    const sharedId = randomUUID();
    const older = await upload(ctx, a.accessToken, metadata({ clientIssueId: sharedId, clientCreatedAt: '2020-01-01T00:00:00.000Z', attachments: [descriptor('a', 'audio', { durationMs: 250 })] }), [{ id: 'a', bytes: m4a, mime: 'audio/mp4' }]);
    assert.equal(older.response.status, 201);
    const otherOwner = await upload(ctx, b.accessToken, metadata({ clientIssueId: sharedId }));
    assert.equal(otherOwner.response.status, 201);
    for (let i = 0; i < 3; i++) assert.equal((await upload(ctx, a.accessToken, metadata({ clientCreatedAt: createdAt }))).response.status, 201);
    const firstPage = await readJson(ctx, a.accessToken, '/issues?limit=2');
    assert.equal(firstPage.response.status, 200);
    assert.equal(firstPage.body.issues.length, 2);
    assert.ok(firstPage.body.nextCursor);
    const secondPage = await readJson(ctx, a.accessToken, `/issues?limit=2&cursor=${firstPage.body.nextCursor}`);
    assert.equal(secondPage.response.status, 200);
    assert.equal(secondPage.body.issues.length, 2);
    assert.equal(secondPage.body.issues.at(-1).id, older.body.issue.id);
    assert.equal(secondPage.body.nextCursor, null);
    assert.equal(new Set([...firstPage.body.issues, ...secondPage.body.issues].map((x) => x.id)).size, 4);
    const detail = await readJson(ctx, a.accessToken, `/issues/${older.body.issue.id}`);
    assert.equal(detail.response.status, 200);
    const notOwner = await readJson(ctx, b.accessToken, `/issues/${older.body.issue.id}`);
    assert.equal(notOwner.response.status, 404);
    const path = older.body.issue.attachments[0].contentPath;
    const denied = await fetch(`${ctx.base}${path}`, { headers: { Authorization: `Bearer ${b.accessToken}` } });
    assert.equal(denied.status, 404);
    const noToken = await fetch(`${ctx.base}${path}`);
    assert.equal(noToken.status, 401);
    const ranged = await fetch(`${ctx.base}${path}`, { headers: { Authorization: `Bearer ${a.accessToken}`, Range: 'bytes=0-9' } });
    assert.equal(ranged.status, 206);
    assert.equal(ranged.headers.get('content-type'), 'audio/mp4');
    assert.equal(ranged.headers.get('content-range'), `bytes 0-9/${m4a.length}`);
    assert.equal((await ranged.arrayBuffer()).byteLength, 10);
    const invalidRange = await fetch(`${ctx.base}${path}`, { headers: { Authorization: `Bearer ${a.accessToken}`, Range: 'bytes=99999-' } });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get('content-range'), `bytes */${m4a.length}`);
    const retry = await upload(ctx, a.accessToken, metadata({ clientIssueId: sharedId, clientCreatedAt: '2020-01-01T00:00:00.000Z', attachments: [descriptor('a', 'audio', { durationMs: 250 })] }), [{ id: 'a', bytes: m4a, mime: 'audio/mp4' }]);
    assert.equal(retry.response.status, 200);
    const afterRetry = await readJson(ctx, a.accessToken, '/issues?limit=10');
    assert.equal(afterRetry.body.issues.at(-1).id, older.body.issue.id);
  } finally { await ctx.close(); }
});

test('promotion failure rolls back, restart retains committed files, cleanup preserves them', async () => {
  const ctx = await setup();
  try {
    const user = await ctx.signup();
    const jpg = await fixture('photo.jpg');
    const meta = metadata({ attachments: [descriptor('p', 'photo')] });
    const originalPromote = ctx.storage.promote.bind(ctx.storage);
    ctx.storage.promote = async () => { throw new Error('injected storage failure'); };
    const failed = await upload(ctx, user.accessToken, meta, [{ id: 'p', bytes: jpg, mime: 'image/jpeg' }]);
    assert.equal(failed.response.status, 500);
    assert.equal(await ctx.prisma.issue.count({ where: { ownerId: user.user.id, clientIssueId: meta.clientIssueId } }), 0);
    ctx.storage.promote = originalPromote;
    ctx.storage.beforeCommit = async () => { throw new Error('injected pre-commit failure'); };
    const beforeCommit = await upload(ctx, user.accessToken, meta, [{ id: 'p', bytes: jpg, mime: 'image/jpeg' }]);
    assert.equal(beforeCommit.response.status, 500);
    assert.equal(await ctx.prisma.issue.count({ where: { ownerId: user.user.id, clientIssueId: meta.clientIssueId } }), 0);
    assert.equal((await readdir(ctx.storage.objectsDir)).length, 0);
    ctx.storage.beforeCommit = async () => {};
    const completed = await upload(ctx, user.accessToken, meta, [{ id: 'p', bytes: jpg, mime: 'image/jpeg' }]);
    assert.equal(completed.response.status, 201);
    await ctx.restart();
    const recovered = await readJson(ctx, user.accessToken, `/issues/${completed.body.issue.id}`);
    assert.equal(recovered.response.status, 200);
    const stored = await ctx.prisma.attachment.findFirstOrThrow({ where: { issueId: completed.body.issue.id } });
    const committedPath = ctx.storage.pathFor(stored.storageKey);
    const orphan = join(ctx.storage.objectsDir, `${randomUUID()}.jpg`);
    await (await import('node:fs/promises')).copyFile(committedPath, orphan);
    const abandonedStage = join(ctx.storage.stagingDir, randomUUID());
    await (await import('node:fs/promises')).copyFile(committedPath, abandonedStage);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(orphan, old, old);
    await utimes(committedPath, old, old);
    await utimes(abandonedStage, old, old);
    await ctx.stop();
    const cleanup = spawnSync(process.execPath, ['scripts/cleanup-uploads.js', '--delete'], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: testUrl, UPLOAD_DIR: ctx.storage.root }, encoding: 'utf8' });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(abandonedStage), false);
    assert.equal(existsSync(committedPath), true);
    await ctx.restart();
    const afterCleanup = await readJson(ctx, user.accessToken, `/issues/${completed.body.issue.id}`);
    assert.equal(afterCleanup.response.status, 200);
  } finally { await ctx.close(); }
});

test('interrupted multipart upload leaves no committed issue or staged files', async () => {
  const ctx = await setup();
  try {
    const user = await ctx.signup();
    const id = randomUUID();
    const boundary = `boundary-${randomUUID()}`;
    const meta = metadata({ clientIssueId: id, attachments: [descriptor('p', 'photo')] });
    const url = new URL(`${ctx.base}/issues`);
    await new Promise((resolve) => {
      const req = httpRequest(url, { method: 'POST', headers: { Authorization: `Bearer ${user.accessToken}`, 'Idempotency-Key': id, 'Content-Type': `multipart/form-data; boundary=${boundary}` } });
      req.on('error', () => resolve());
      req.on('close', () => resolve());
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(meta)}\r\n`);
      req.write(`--${boundary}\r\nContent-Disposition: form-data; name="media:p"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);
      req.write(Buffer.from('ffd8ffe0', 'hex'));
      setTimeout(() => req.destroy(), 30);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await ctx.prisma.issue.count({ where: { ownerId: user.user.id, clientIssueId: id } }), 0);
    assert.equal((await readdir(ctx.storage.stagingDir)).length, 0);
  } finally { await ctx.close(); }
});

test('health and readiness respond without exposing configuration', async () => {
  const ctx = await setup();
  try {
    const health = await readJson(ctx, '', '/health');
    assert.deepEqual(health.body, { status: 'ok' });
    const ready = await readJson(ctx, '', '/ready');
    assert.deepEqual(ready.body, { status: 'ok' });
    ctx.storage.checkReady = async () => { throw new Error('storage unavailable'); };
    const unavailable = await readJson(ctx, '', '/ready');
    assert.equal(unavailable.response.status, 503);
    assert.equal(unavailable.body.error.code, 'SERVICE_UNAVAILABLE');
  } finally { await ctx.close(); }
});
