import { createHmac } from 'node:crypto';

export function loadConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  if (!env.JWT_SECRET?.trim() || Buffer.byteLength(env.JWT_SECRET, 'utf8') < 32) {
    throw new Error('JWT_SECRET must contain at least 32 bytes');
  }
  const port = Number(env.PORT ?? 8000);
  const trustProxyHops = Number(env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port');
  if (!Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 3) {
    throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 3');
  }
  const positive = (key, fallback) => {
    const value = Number(env[key] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive integer`);
    return value;
  };
  return {
    deviceHmacSecret: env.DEVICE_HMAC_SECRET || createHmac('sha256', env.JWT_SECRET).update('nwash/device-recognition/v1').digest('hex'),
    deviceHmacVersion: env.DEVICE_HMAC_VERSION || (env.DEVICE_HMAC_SECRET ? 'v1' : 'jwt-v1'),
    legacyAuthEnabled: env.LEGACY_AUTH_ENABLED !== 'false',
    databaseUrl: env.DATABASE_URL,
    jwtSecret: new TextEncoder().encode(env.JWT_SECRET),
    jwtIssuer: env.JWT_ISSUER || 'nwash-api',
    jwtAudience: env.JWT_AUDIENCE || 'nwash-mobile',
    host: env.HOST || '0.0.0.0',
    port,
    uploadDir: env.UPLOAD_DIR || './uploads',
    trustProxyHops,
    loginIpLimit: 10,
    loginEmailLimit: 5,
    loginWindowMs: 15 * 60 * 1000,
    signupIpLimit: 5,
    signupEmailLimit: 5,
    signupWindowMs: 60 * 60 * 1000,
    uploadIpLimit: positive('UPLOAD_IP_LIMIT', 30),
    uploadUserLimit: positive('UPLOAD_USER_LIMIT', 60),
    uploadWindowMs: 60 * 60 * 1000,
    maxPhotos: positive('MAX_PHOTOS', 20),
    maxAudio: positive('MAX_AUDIO', 10),
    maxPhotoBytes: positive('MAX_PHOTO_BYTES', 15 * 1024 * 1024),
    maxAudioBytes: positive('MAX_AUDIO_BYTES', 30 * 1024 * 1024),
    maxRequestBytes: positive('MAX_REQUEST_BYTES', 200 * 1024 * 1024),
    maxMetadataBytes: positive('MAX_METADATA_BYTES', 128 * 1024),
  };
}
