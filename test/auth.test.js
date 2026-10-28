import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { installAuthRoutes } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { seedDevelopmentAccount } from '../src/seed.js';
import { hashPassword } from '../src/security.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl || testDatabaseUrl === process.env.DATABASE_URL) {
  throw new Error('Set a separate TEST_DATABASE_URL before running integration tests');
}

const secret = 'test-only-secret-value-that-is-at-least-32-bytes-long';
const password = 'correct password 123';

async function setup(overrides = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'nwash-auth-test-'));
  const prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } });
  const config = { ...loadConfig({ DATABASE_URL: testDatabaseUrl, JWT_SECRET: secret }), ...overrides };
  const { app } = createApp({ prisma, dataDir });
  app.set('trust proxy', false);
  await prisma.$connect();
  await installAuthRoutes(app, prisma, config);
  const server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server failed to listen');
  const base = `http://127.0.0.1:${address.port}/api/v1`;
  const emails = [];
  return {
    prisma,
    config,
    base,
    emails,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await prisma.user.deleteMany({ where: { email: { in: emails } } });
      await prisma.$disconnect();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function signupBody(email, fullName = 'Sam Example', passwordValue = password) {
  return { fullName, email, password: passwordValue };
}

async function jsonRequest(base, path, method, body, authorization) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authorization ? { Authorization: authorization } : {}),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });
  return { response, json: await response.json() };
}

test('signup validates names, passwords, and malformed or oversized JSON', async () => {
  const ctx = await setup({ signupIpLimit: 100, signupEmailLimit: 100 });
  try {
    const cases = [
      { fullName: '', email: 'a@example.com', password },
      { fullName: '   ', email: 'a@example.com', password },
      { fullName: 'x'.repeat(101), email: 'a@example.com', password },
      signupBody('a@example.com', 'A', 'short'),
      signupBody('a@example.com', 'A', 'x'.repeat(129)),
      { fullName: 7, email: 'a@example.com', password },
      { fullName: 'A', email: 'bad-email', password },
      { fullName: 'A', email: 'a@example.com', password, passwordConfirmation: password },
      {},
      [],
    ];
    for (const body of cases) {
      const result = await jsonRequest(ctx.base, '/auth/signup', 'POST', body);
      assert.equal(result.response.status, 400);
      assert.deepEqual(result.json.error, { code: 'VALIDATION_ERROR', message: 'Invalid request.', details: [] });
      assert.equal(typeof result.json.requestId, 'string');
      assert.equal(result.response.headers.get('cache-control'), 'no-store');
    }
    for (const raw of ['{"fullName":', JSON.stringify({ fullName: 'A', email: 'a@example.com', password, extra: 'x'.repeat(20_000) })]) {
      const result = await jsonRequest(ctx.base, '/auth/signup', 'POST', raw);
      assert.equal(result.response.status, 400);
      assert.equal(result.json.error.code, 'VALIDATION_ERROR');
    }
  } finally {
    await ctx.close();
  }
});

test('signup issues a session; normalized login and /me return only public user fields', async () => {
  const ctx = await setup();
  const email = `unicode-${randomUUID()}@example.com`;
  ctx.emails.push(email);
  try {
    const created = await jsonRequest(ctx.base, '/auth/signup', 'POST', signupBody(`  ${email.toUpperCase()}  `, '  एकल  '));
    assert.equal(created.response.status, 201);
    assert.equal(created.response.headers.get('cache-control'), 'no-store');
    assert.equal(created.json.tokenType, 'Bearer');
    assert.equal(created.json.expiresIn, 3600);
    assert.equal(typeof created.json.accessToken, 'string');
    assert.deepEqual(Object.keys(created.json).sort(), ['accessToken', 'expiresIn', 'tokenType', 'user']);
    assert.deepEqual(Object.keys(created.json.user).sort(), ['email', 'fullName', 'id']);
    assert.equal(created.json.user.email, email);
    assert.equal(created.json.user.fullName, 'एकल');
    assert.match(created.json.user.id, /^[0-9a-f-]{36}$/i);

    const login = await jsonRequest(ctx.base, '/auth/login', 'POST', { email: ` ${email.toUpperCase()} `, password });
    assert.equal(login.response.status, 200);
    assert.deepEqual(login.json.user, created.json.user);
    assert.equal(login.response.headers.get('cache-control'), 'no-store');

    const me = await jsonRequest(ctx.base, '/auth/me', 'GET', undefined, `Bearer ${login.json.accessToken}`);
    assert.equal(me.response.status, 200);
    assert.deepEqual(me.json, { user: created.json.user });

    const wrong = await jsonRequest(ctx.base, '/auth/login', 'POST', { email, password: 'wrong password 123' });
    const unknown = await jsonRequest(ctx.base, '/auth/login', 'POST', { email: `unknown-${randomUUID()}@example.com`, password });
    assert.equal(wrong.response.status, 401);
    assert.equal(unknown.response.status, 401);
    assert.deepEqual(wrong.json.error, unknown.json.error);
    assert.deepEqual(wrong.json.error, { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.', details: [] });

    const malformed = await jsonRequest(ctx.base, '/auth/login', 'POST', { email, password: 7 });
    assert.equal(malformed.response.status, 400);
    assert.equal(malformed.json.error.code, 'VALIDATION_ERROR');
    const oversized = await jsonRequest(ctx.base, '/auth/login', 'POST', { email, password: 'x'.repeat(20_000) });
    assert.equal(oversized.response.status, 400);
  } finally {
    await ctx.close();
  }
});

test('normalized duplicate emails, including concurrent signup, return 409', async () => {
  const ctx = await setup();
  const email = `duplicate-${randomUUID()}@example.com`;
  ctx.emails.push(email);
  try {
    const [first, second] = await Promise.all([
      jsonRequest(ctx.base, '/auth/signup', 'POST', signupBody(email.toUpperCase())),
      jsonRequest(ctx.base, '/auth/signup', 'POST', signupBody(` ${email} `)),
    ]);
    assert.deepEqual([first.response.status, second.response.status].sort(), [201, 409]);
    const duplicate = first.response.status === 409 ? first : second;
    assert.deepEqual(duplicate.json.error, { code: 'EMAIL_EXISTS', message: 'An account with this email already exists.', details: [] });
    assert.equal(await ctx.prisma.user.count({ where: { email } }), 1);
  } finally {
    await ctx.close();
  }
});

test('login and signup rate limits return 429 and Retry-After', async () => {
  const ctx = await setup({ loginIpLimit: 2, loginEmailLimit: 2, signupIpLimit: 2 });
  try {
    for (let index = 0; index < 2; index++) {
      const result = await jsonRequest(ctx.base, '/auth/login', 'POST', { email: 'missing@example.com', password });
      assert.equal(result.response.status, 401);
    }
    const loginLimit = await jsonRequest(ctx.base, '/auth/login', 'POST', { email: 'missing@example.com', password });
    assert.equal(loginLimit.response.status, 429);
    assert.ok(Number(loginLimit.response.headers.get('retry-after')) > 0);
    assert.deepEqual(loginLimit.json.error, { code: 'RATE_LIMITED', message: 'Too many attempts. Try again later.', details: [] });

    for (let index = 0; index < 2; index++) {
      const result = await jsonRequest(ctx.base, '/auth/signup', 'POST', signupBody('bad@example.com', ' '));
      assert.equal(result.response.status, 400);
    }
    const signupLimit = await jsonRequest(ctx.base, '/auth/signup', 'POST', signupBody('bad@example.com'));
    assert.equal(signupLimit.response.status, 429);
    assert.ok(Number(signupLimit.response.headers.get('retry-after')) > 0);
  } finally {
    await ctx.close();
  }
});

test('login also limits attempts by normalized email', async () => {
  const ctx = await setup({ loginIpLimit: 100, loginEmailLimit: 2 });
  try {
    for (const email of ['MISSING@EXAMPLE.COM', ' missing@example.com ']) {
      const result = await jsonRequest(ctx.base, '/auth/login', 'POST', { email, password });
      assert.equal(result.response.status, 401);
    }
    const limited = await jsonRequest(ctx.base, '/auth/login', 'POST', { email: 'missing@example.com', password });
    assert.equal(limited.response.status, 429);
    assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  } finally {
    await ctx.close();
  }
});

test('signup also limits attempts by normalized email', async () => {
  const ctx = await setup({ signupIpLimit: 100, signupEmailLimit: 2 });
  try {
    for (const email of ['SAME@EXAMPLE.COM', ' same@example.com ']) {
      const result = await jsonRequest(ctx.base, '/auth/signup', 'POST', signupBody(email, ' '));
      assert.equal(result.response.status, 400);
    }
    const limited = await jsonRequest(ctx.base, '/auth/signup', 'POST', signupBody('same@example.com'));
    assert.equal(limited.response.status, 429);
    assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
  } finally { await ctx.close(); }
});

test('password whitespace is preserved exactly', async () => {
  const ctx = await setup();
  const email = `spaces-${randomUUID()}@example.com`;
  ctx.emails.push(email);
  try {
    const created = await jsonRequest(ctx.base, '/auth/signup', 'POST', signupBody(email, 'Sam', '  spaced password  '));
    assert.equal(created.response.status, 201);
    const exact = await jsonRequest(ctx.base, '/auth/login', 'POST', { email, password: '  spaced password  ' });
    const trimmed = await jsonRequest(ctx.base, '/auth/login', 'POST', { email, password: 'spaced password' });
    assert.equal(exact.response.status, 200);
    assert.equal(trimmed.response.status, 401);
  } finally {
    await ctx.close();
  }
});

test('existing accounts with a short password can still log in', async () => {
  const ctx = await setup();
  const email = `legacy-${randomUUID()}@example.com`;
  ctx.emails.push(email);
  try {
    await ctx.prisma.user.create({ data: { email, fullName: 'Existing User', passwordHash: await hashPassword('short') } });
    const login = await jsonRequest(ctx.base, '/auth/login', 'POST', { email, password: 'short' });
    assert.equal(login.response.status, 200);
    assert.equal(login.json.user.email, email);
  } finally { await ctx.close(); }
});

test('/me rejects absent, invalid, expired, wrong-claim, and disabled-user tokens', async () => {
  const ctx = await setup();
  const email = `token-${randomUUID()}@example.com`;
  ctx.emails.push(email);
  try {
    const created = await jsonRequest(ctx.base, '/auth/signup', 'POST', signupBody(email));
    assert.equal(created.response.status, 201);
    const userId = created.json.user.id;
    const badTokens = [
      undefined,
      'Bearer malformed',
      `Bearer ${await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer(ctx.config.jwtIssuer).setAudience(ctx.config.jwtAudience).setExpirationTime('1h').sign(new TextEncoder().encode('different-test-secret-with-at-least-32-bytes'))}`,
      `Bearer ${await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer(ctx.config.jwtIssuer).setAudience(ctx.config.jwtAudience).setExpirationTime(Math.floor(Date.now() / 1000) - 60).sign(ctx.config.jwtSecret)}`,
      `Bearer ${await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer('wrong-issuer').setAudience(ctx.config.jwtAudience).setExpirationTime('1h').sign(ctx.config.jwtSecret)}`,
      `Bearer ${await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer(ctx.config.jwtIssuer).setAudience('wrong-audience').setExpirationTime('1h').sign(ctx.config.jwtSecret)}`,
      `Bearer ${await new SignJWT({}).setProtectedHeader({ alg: 'HS384' }).setSubject(userId).setIssuer(ctx.config.jwtIssuer).setAudience(ctx.config.jwtAudience).setExpirationTime('1h').sign(ctx.config.jwtSecret)}`,
    ];
    for (const token of badTokens) {
      const result = await jsonRequest(ctx.base, '/auth/me', 'GET', undefined, token);
      assert.equal(result.response.status, 401);
      assert.equal(result.json.error.code, 'UNAUTHORIZED');
    }
    await ctx.prisma.user.update({ where: { id: userId }, data: { disabledAt: new Date() } });
    const disabled = await jsonRequest(ctx.base, '/auth/me', 'GET', undefined, `Bearer ${created.json.accessToken}`);
    assert.equal(disabled.response.status, 401);
    await ctx.prisma.user.delete({ where: { id: userId } });
    const deleted = await jsonRequest(ctx.base, '/auth/me', 'GET', undefined, `Bearer ${created.json.accessToken}`);
    assert.equal(deleted.response.status, 401);
  } finally {
    await ctx.close();
  }
});

test('startup requires a database URL and a strong token secret', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  assert.throws(() => loadConfig({ DATABASE_URL: testDatabaseUrl }), /JWT_SECRET/);
  assert.throws(() => loadConfig({ DATABASE_URL: testDatabaseUrl, JWT_SECRET: 'short' }), /JWT_SECRET/);
});

test('development seed is idempotent and never overwrites a password or name', async () => {
  const ctx = await setup();
  const email = `seed-${randomUUID()}@example.com`;
  ctx.emails.push(email);
  try {
    const first = await seedDevelopmentAccount(ctx.prisma, { fullName: 'Seed Person', email: email.toUpperCase(), password });
    const before = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    const second = await seedDevelopmentAccount(ctx.prisma, { fullName: 'Changed Name', email: ` ${email} `, password: 'changed password 123' });
    const after = await ctx.prisma.user.findUniqueOrThrow({ where: { email } });
    assert.equal(first, 'created');
    assert.equal(second, 'already-exists');
    assert.equal(after.fullName, before.fullName);
    assert.equal(after.passwordHash, before.passwordHash);
  } finally {
    await ctx.close();
  }
});
