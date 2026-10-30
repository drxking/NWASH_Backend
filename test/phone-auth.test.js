import test from 'node:test';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../src/app.js';
import { installAuthRoutes } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { normalizePhone, normalizeDevice } from '../src/phone-auth.js';
import { installApiFallback } from '../src/http.js';
import { RateLimiter } from '../src/rate-limit.js';
if (process.getBuiltinModule('fs').existsSync('.env')) process.loadEnvFile('.env');
const secret = 'test-phone-secret-with-at-least-32-bytes';
const config = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, JWT_SECRET: secret, DEVICE_HMAC_SECRET: secret });
const device = { platform: 'android', identifierType: 'android_id', identifier: 'ABCDEF1234567890' };
test('international phone and device validation', () => {
  assert.equal(normalizePhone(' +977 9812345678 '), '+9779812345678');
  for (const p of ['9812345678', '+000123', '+9779812345678 ext 2', null]) assert.equal(normalizePhone(p), null);
  const fallback = loadConfig({ DATABASE_URL: process.env.TEST_DATABASE_URL, JWT_SECRET: secret });
  assert.equal(fallback.deviceHmacVersion, 'jwt-v1');
  assert.ok(normalizeDevice(device, fallback));
  const ios = { platform: 'ios', identifierType: 'idfv', identifier: '12345678-1234-1234-1234-123456789ABC' };
  assert.deepEqual(normalizeDevice(ios, config), normalizeDevice({ ...ios, identifier: ios.identifier.toLowerCase() }, config));
  assert.deepEqual(normalizeDevice(device, config), normalizeDevice({ ...device, identifier: device.identifier.toLowerCase() }, config));
  for (const d of [{}, { ...device, identifier: '' }, { ...device, platform: 'ios' }, { ...device, identifier: '0000000000000000' }]) assert.equal(normalizeDevice(d, config), null);
});
test('phone/device signup, duplicate race, account isolation and session lifecycle', async () => {
  assert.ok(process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL !== process.env.DATABASE_URL);
  const db = new PrismaClient({ datasources: { db: { url: process.env.TEST_DATABASE_URL } } });
  const { app } = createApp({ prisma: db });
  let now = Date.now();
  await installAuthRoutes(app, db, config, new RateLimiter(() => now));
  installApiFallback(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/auth`;
  const phones = ['+9779812345678', '+9779812345679'];
  await db.user.deleteMany({ where: { phoneNumber: { in: phones } } });
  await db.phoneChallenge.deleteMany({ where: { phoneNumber: { in: phones } } });
  async function post(path, body, token) {
    const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: r.status === 204 ? null : await r.json() };
  }
  const profile = { phoneNumber: phones[0], device, fullName: ' Sam ', address: ' Kathmandu ' };
  try {
    const racers = await Promise.all([post('/signup', profile), post('/signup', { ...profile, phoneNumber: ' +977 9812345678 ' })]);
    assert.deepEqual(racers.map(r => r.status).sort(), [201, 409]);
    const enrolled = racers.find(r => r.status === 201);
    assert.equal(enrolled.body.user.fullName, 'Sam');
    assert.equal(enrolled.body.user.address, 'Kathmandu');
    assert.ok(!JSON.stringify(enrolled.body).includes(device.identifier));
    const stored = await db.user.findUnique({ where: { id: enrolled.body.user.id } });
    assert.equal(stored.phoneVerifiedAt, null);
    const binding = await db.deviceBinding.findFirst({ where: { userId: stored.id } });
    assert.equal(binding.credentialHash, null);
    assert.ok(!JSON.stringify(binding).includes(device.identifier));
    const login = { phoneNumber: phones[0], device: { ...device, identifier: device.identifier.toLowerCase() } };
    assert.equal((await post('/login', login)).status, 200);
    assert.equal((await post('/login', { ...login, device: { ...device, identifier: '1111111111111111' } })).status, 403);
    assert.equal((await post('/login', { ...login, phoneNumber: '+9779812345680' })).status, 401);
    for (const bad of [{ ...login, device: null }, { ...login, device: { ...device, identifier: '' } }, { ...login, phoneNumber: '9812345678' }]) {
      assert.equal((await post('/login', bad)).status, 400);
    }
    const refreshed = await post('/refresh', { refreshToken: enrolled.body.refreshToken });
    assert.equal(refreshed.status, 200);
    assert.equal((await post('/refresh', { refreshToken: enrolled.body.refreshToken })).status, 401);
    assert.equal((await post('/logout', {}, refreshed.body.accessToken)).status, 204);
    assert.equal((await post('/logout', {}, refreshed.body.accessToken)).status, 401);
    now += 900001;
    assert.equal((await post('/login', login)).status, 200);
    const shared = await post('/signup', { ...profile, phoneNumber: phones[1] });
    assert.equal(shared.status, 201);
    assert.notEqual(shared.body.user.id, stored.id);
    const current = await post('/login', login);
    assert.equal((await post('/forget-device', {}, current.body.accessToken)).status, 204);
    assert.equal((await post('/login', login)).status, 403);
    assert.equal((await post('/login', { ...login, phoneNumber: phones[1] })).status, 200);
    assert.equal((await post('/otp/request', {})).status, 404);
    assert.equal((await post('/otp/verify', {})).status, 404);
    const email = `migration-${Date.now()}@example.com`;
    const legacy = await post('/signup', { fullName: 'Existing', email, password: 'legacy password 123' });
    const userId = legacy.body.user.id;
    try {
      const issue = await db.issue.create({ data: { ownerId: userId, clientIssueId: 'migration-issue', clientCreatedAt: new Date(), clientUpdatedAt: new Date(), description: 'Preserve me', locationStatus: 'none', fingerprint: 'a'.repeat(64) } });
      assert.equal((await post('/phone/link', { phoneNumber: phones[1], address: 'City', device }, legacy.body.accessToken)).status, 409);
      await db.user.update({ where: { phoneNumber: phones[1] }, data: { phoneNumber: null } });
      const linked = await post('/phone/link', { phoneNumber: phones[1], address: 'City', device }, legacy.body.accessToken);
      assert.equal(linked.status, 200);
      assert.equal(linked.body.user.id, userId);
      assert.equal((await db.issue.findUnique({ where: { id: issue.id } })).ownerId, userId);
      assert.equal((await db.user.findUnique({ where: { id: userId } })).email, email);
    } finally { await db.user.delete({ where: { id: userId } }); }
    now += 900001;
    for (let i = 0; i < 10; i++) await post('/login', login);
    assert.equal((await post('/login', login)).status, 429);
  } finally {
    await new Promise(r => server.close(r));
    await db.user.deleteMany({ where: { OR: [{ phoneNumber: { in: phones } }, { phoneNumber: null, email: null, fullName: 'Sam' }] } });
    await db.phoneChallenge.deleteMany({ where: { phoneNumber: { in: phones } } });
    await db.$disconnect();
  }
});
