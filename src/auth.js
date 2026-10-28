import express from 'express';
import { Prisma } from '@prisma/client';
import argon2 from 'argon2';
import { jwtVerify, SignJWT } from 'jose';
import { hashPassword, normalizeEmail, normalizeFullName, validPassword } from './security.js';
import { RateLimiter } from './rate-limit.js';
import { sendError, logServerError } from './http.js';

const EXPIRES_IN = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const userSelect = { id: true, email: true, fullName: true };

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

async function session(user, config) {
  const accessToken = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer(config.jwtIssuer)
    .setAudience(config.jwtAudience)
    .setExpirationTime(`${EXPIRES_IN}s`)
    .sign(config.jwtSecret);
  return { accessToken, tokenType: 'Bearer', expiresIn: EXPIRES_IN, user };
}

export async function installAuthRoutes(app, prisma, config, limiter = new RateLimiter()) {
  const dummyHash = await hashPassword('dummy-password-used-for-missing-accounts');
  const router = express.Router();
  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(express.json({ limit: '16kb', strict: true }));
  router.use((error, _req, res, next) => {
    if (error) return sendError(res, 'VALIDATION_ERROR');
    next();
  });

  router.post('/login', async (req, res) => {
    const body = req.body;
    const email = isObject(body) ? normalizeEmail(body.email) : null;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const ipRetry = limiter.check(`login:ip:${ip}`, config.loginIpLimit, config.loginWindowMs);
    const emailRetry = email ? limiter.check(`login:email:${email}`, config.loginEmailLimit, config.loginWindowMs) : 0;
    if (ipRetry || emailRetry) return sendError(res, 'RATE_LIMITED', [], Math.max(ipRetry, emailRetry));
    if (!isObject(body) || !hasExactKeys(body, ['email', 'password']) || !email || typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 128) {
      return sendError(res, 'VALIDATION_ERROR');
    }
    try {
      const user = await prisma.user.findUnique({ where: { email }, select: { ...userSelect, passwordHash: true, disabledAt: true } });
      const matches = await argon2.verify(user?.passwordHash ?? dummyHash, body.password);
      if (!user || user.disabledAt || !matches) return sendError(res, 'INVALID_CREDENTIALS');
      return res.status(200).json(await session({ id: user.id, email: user.email, fullName: user.fullName }, config));
    } catch {
      logServerError(req, 'INTERNAL_ERROR');
      return sendError(res, 'INTERNAL_ERROR');
    }
  });

  router.post('/signup', async (req, res) => {
    const body = req.body;
    const email = isObject(body) ? normalizeEmail(body.email) : null;
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const ipRetry = limiter.check(`signup:ip:${ip}`, config.signupIpLimit, config.signupWindowMs);
    const emailRetry = email ? limiter.check(`signup:email:${email}`, config.signupEmailLimit, config.signupWindowMs) : 0;
    if (ipRetry || emailRetry) return sendError(res, 'RATE_LIMITED', [], Math.max(ipRetry, emailRetry));
    const fullName = isObject(body) ? normalizeFullName(body.fullName) : null;
    if (!isObject(body) || !hasExactKeys(body, ['fullName', 'email', 'password']) || !email || !fullName || !validPassword(body.password)) {
      return sendError(res, 'VALIDATION_ERROR');
    }
    try {
      const passwordHash = await hashPassword(body.password);
      const user = await prisma.$transaction(async (tx) => tx.user.create({
        data: { fullName, email, passwordHash },
        select: userSelect,
      }));
      return res.status(201).json(await session(user, config));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return sendError(res, 'EMAIL_EXISTS');
      }
      logServerError(req, 'INTERNAL_ERROR');
      return sendError(res, 'INTERNAL_ERROR');
    }
  });

  router.get('/me', authenticate(prisma, config), async (req, res) => {
    return res.status(200).json({ user: req.authUser });
  });

  router.use((_error, req, res, _next) => {
    logServerError(req, 'INTERNAL_ERROR');
    return sendError(res, 'INTERNAL_ERROR');
  });
  app.use('/api/v1/auth', router);
}

export function authenticate(prisma, config) {
  return async (req, res, next) => {
    const authorization = req.get('Authorization');
    if (!authorization || !/^Bearer [^\s]+$/.test(authorization)) return sendError(res, 'UNAUTHORIZED');
    let subject;
    try {
      const token = authorization.slice('Bearer '.length);
      const { payload } = await jwtVerify(token, config.jwtSecret, {
        algorithms: ['HS256'],
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      });
      if (typeof payload.exp !== 'number') return sendError(res, 'UNAUTHORIZED');
      subject = payload.sub;
    } catch {
      return sendError(res, 'UNAUTHORIZED');
    }
    if (!subject || !UUID.test(subject)) return sendError(res, 'UNAUTHORIZED');
    try {
      const user = await prisma.user.findUnique({ where: { id: subject }, select: { ...userSelect, disabledAt: true } });
      if (!user || user.disabledAt) return sendError(res, 'UNAUTHORIZED');
      req.authUser = { id: user.id, email: user.email, fullName: user.fullName };
      return next();
    } catch {
      logServerError(req, 'INTERNAL_ERROR');
      return sendError(res, 'INTERNAL_ERROR');
    }
  };
}
