import { createHash, createHmac, randomBytes } from 'node:crypto';
import { SignJWT } from 'jose';
import parsePhoneNumber from 'libphonenumber-js/max';
import { sendError } from './http.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export function normalizePhone(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^\+[\d ()-]+$/.test(value.trim())) return null;
  const phone = parsePhoneNumber(value.trim(), { extract: false });
  return phone?.isValid() && !phone.ext ? phone.number : null;
}
export function normalizeDevice(value, config) {
  if (!object(value) || Object.keys(value).sort().join() !== 'identifier,identifierType,platform' || typeof value.identifier !== 'string') return null;
  const id = value.identifier.toLowerCase();
  if (!(value.platform === 'android' && value.identifierType === 'android_id' && /^[a-f0-9]{16}$/.test(id) && id !== '0000000000000000') &&
      !(value.platform === 'ios' && value.identifierType === 'idfv' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) && id !== '00000000-0000-0000-0000-000000000000')) return null;
  if (!config.deviceHmacSecret || Buffer.byteLength(config.deviceHmacSecret) < 32) return null;
  return { platform: value.platform, identifierType: value.identifierType, keyVersion: config.deviceHmacVersion,
    identifierHmac: createHmac('sha256', config.deviceHmacSecret).update(`${value.platform}:${value.identifierType}:${id}`).digest('hex') };
}
export const publicUser = u => u.phoneNumber ? { id: u.id, fullName: u.fullName, phoneNumber: u.phoneNumber, address: u.address } : { id: u.id, email: u.email, fullName: u.fullName };
export async function createSession(db, user, config, deviceId = null) {
  const refreshToken = random();
  const row = await db.authSession.create({ data: { userId: user.id, deviceId, refreshHash: digest(refreshToken), expiresAt: new Date(Date.now() + 30 * 86400000) } });
  const accessToken = await new SignJWT({ sid: row.id }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(user.id).setIssuedAt().setIssuer(config.jwtIssuer).setAudience(config.jwtAudience).setExpirationTime('1h').sign(config.jwtSecret);
  // Legacy clients retain their exact response shape.
  return { accessToken, tokenType: 'Bearer', expiresIn: 3600, user: publicUser(user), ...(deviceId ? { refreshToken } : {}) };
}
function text(v, max) { return typeof v === 'string' && v.trim().length > 0 && [...v.trim()].length <= max ? v.trim() : null; }
function invalid(res) { return sendError(res, 'VALIDATION_ERROR'); }
export function installPhoneAuth(router, db, config, limiter, auth) {
  const ready = res => {
    if (!config.deviceHmacSecret || Buffer.byteLength(config.deviceHmacSecret) < 32) { sendError(res, 'SERVICE_UNAVAILABLE'); return false; }
    return true;
  };
  const limit = (req, res, phone, purpose, cooldown = false) => {
    const key = createHmac('sha256', config.jwtSecret).update(phone || '').digest('hex');
    const waits = [limiter.check(`${purpose}:ip:${req.ip}`, 20, 900000), limiter.check(`${purpose}:phone:${key}`, cooldown ? 1 : 10, cooldown ? 60000 : 900000)];
    const wait = Math.max(...waits);
    if (wait) { sendError(res, 'RATE_LIMITED', [], wait); return false; } return true;
  };
  router.post(['/signup', '/login'], async (req, res, next) => {
    if (object(req.body) && Object.hasOwn(req.body, 'email')) {
      if (!config.legacyAuthEnabled) return sendError(res, 'AUTH_FAILED');
      return next();
    }
    const b = req.body;
    const phone = normalizePhone(b?.phoneNumber);
    if (!limit(req, res, phone, 'phone-login')) return;
    if (!object(b) || !phone || !object(b.device)) return invalid(res);
    if (!ready(res)) return;
    const device = normalizeDevice(b?.device, config);
    const signup = req.path === '/signup';
    const allowed = signup ? ['fullName', 'phoneNumber', 'address', 'device'] : ['phoneNumber', 'device'];
    if (!object(b) || Object.keys(b).some(k => !allowed.includes(k)) || !phone || !device || (signup && (!text(b.fullName, 100) || !text(b.address, 500)))) return invalid(res);
    if (signup) {
      const result = await db.$transaction(async tx => {
        const user = await tx.user.create({ data: { phoneNumber: phone, fullName: text(b.fullName, 100), address: text(b.address, 500) } });
        const binding = await tx.deviceBinding.create({ data: { userId: user.id, ...device } });
        return createSession(tx, user, config, binding.id);
      });
      return res.status(201).json(result);
    }
    const result = await db.$transaction(async tx => {
      const user = await tx.user.findUnique({ where: { phoneNumber: phone } });
      if (!user || user.disabledAt) return { error: 'AUTH_FAILED' };
      const binding = await tx.deviceBinding.findFirst({ where: { userId: user.id, ...device, revokedAt: null } });
      if (!binding) return { error: 'DEVICE_VERIFICATION_REQUIRED' };
      const updated = await tx.deviceBinding.updateMany({ where: { id: binding.id, revokedAt: null }, data: { lastSeenAt: new Date() } });
      if (!updated.count) return { error: 'AUTH_FAILED' };
      return createSession(tx, user, config, binding.id);
    });
    return result.error ? sendError(res, result.error) : res.json(result);
  });
  // Existing accounts link explicitly through their authenticated session; never merge profile matches.
  router.post('/phone/link', auth, async (req, res) => {
    const b = req.body;
    const phone = normalizePhone(b?.phoneNumber);
    if (!limit(req, res, phone, 'phone-link')) return;
    if (!object(b) || Object.keys(b).sort().join() !== 'address,device,phoneNumber' || !phone || !text(b.address, 500)) return invalid(res);
    if (!ready(res)) return;
    const device = normalizeDevice(b.device, config);
    if (!device) return invalid(res);
    const result = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${req.authUser.id}::uuid FOR UPDATE`;
      const owner = await tx.user.findUnique({ where: { id: req.authUser.id } });
      if (!owner || owner.disabledAt || (owner.phoneNumber && owner.phoneNumber !== phone)) return { error: 'AUTH_FAILED' };
      const user = await tx.user.update({ where: { id: owner.id }, data: { phoneNumber: phone, address: text(b.address, 500) } });
      const binding = await tx.deviceBinding.upsert({ where: { userId_keyVersion_identifierHmac: { userId: user.id, keyVersion: device.keyVersion, identifierHmac: device.identifierHmac } }, create: { userId: user.id, ...device }, update: { revokedAt: null, lastSeenAt: new Date() } });
      return createSession(tx, user, config, binding.id);
    });
    return result.error ? sendError(res, result.error) : res.json(result);
  });
  router.post('/logout', auth, async (req, res) => {
    await db.authSession.update({ where: { id: req.authSession.id }, data: { revokedAt: new Date() } });
    res.status(204).end();
  });
  router.post('/forget-device', auth, async (req, res) => {
    if (!req.authSession.deviceId) return invalid(res);
    await db.$transaction(async tx => {
      await tx.deviceBinding.update({ where: { id: req.authSession.deviceId }, data: { revokedAt: new Date() } });
      await tx.authSession.updateMany({ where: { deviceId: req.authSession.deviceId, userId: req.authUser.id }, data: { revokedAt: new Date() } });
    });
    res.status(204).end();
  });
  router.post('/refresh', async (req, res) => {
    if (!limit(req, res, typeof req.body?.refreshToken === 'string' ? req.body.refreshToken : '', 'refresh')) return;
    const token = req.body?.refreshToken;
    if (typeof token !== 'string' || !/^[\w-]{43}$/.test(token) || Object.keys(req.body).length !== 1) return invalid(res);
    const result = await db.$transaction(async tx => {
      const s = await tx.authSession.findUnique({ where: { refreshHash: digest(token) }, include: { user: true } });
      if (!s || s.user.disabledAt || s.revokedAt || s.expiresAt <= new Date() || !s.deviceId) return null;
      const binding = await tx.deviceBinding.findFirst({ where: { id: s.deviceId, revokedAt: null } });
      if (!binding) return null;
      const locked = await tx.deviceBinding.updateMany({ where: { id: binding.id, revokedAt: null }, data: { lastSeenAt: new Date() } });
      if (!locked.count) return null;
      const claimed = await tx.authSession.updateMany({ where: { id: s.id, revokedAt: null }, data: { revokedAt: new Date() } });
      return claimed.count ? createSession(tx, s.user, config, s.deviceId) : null;
    });
    return result ? res.json(result) : sendError(res, 'AUTH_FAILED');
  });
}
