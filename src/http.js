import { randomUUID } from 'node:crypto';

const errors = {
  VALIDATION_ERROR: [400, 'Invalid request.'],
  UNAUTHORIZED: [401, 'Unauthorized.'],
  INVALID_CREDENTIALS: [401, 'Invalid email or password.'],
  DEVICE_VERIFICATION_REQUIRED: [403, 'Device requires verification.'],
  AUTH_FAILED: [401, 'Authentication unsuccessful.'],
  PHONE_EXISTS: [409, 'An account with this phone already exists.'],
  NOT_FOUND: [404, 'Not found.'],
  EMAIL_EXISTS: [409, 'An account with this email already exists.'],
  ISSUE_CONTENT_CONFLICT: [409, 'This issue id was already uploaded with different content.'],
  PAYLOAD_TOO_LARGE: [413, 'Upload exceeds the allowed size.'],
  UNSUPPORTED_MEDIA_TYPE: [415, 'Unsupported or invalid media file.'],
  RATE_LIMITED: [429, 'Too many attempts. Try again later.'],
  INTERNAL_ERROR: [500, 'An unexpected error occurred.'],
  SERVICE_UNAVAILABLE: [503, 'Service temporarily unavailable.'],
};

export class ApiError extends Error {
  constructor(code, details = []) {
    super(errors[code]?.[1] || errors.INTERNAL_ERROR[1]);
    this.code = code;
    this.details = details;
  }
}

export function requestContext(req, res, next) {
  req.requestId = randomUUID();
  res.set('X-Request-Id', req.requestId);
  res.on('finish', () => {
    console.log(JSON.stringify({ level: 'info', requestId: req.requestId, method: req.method, route: req.route?.path || '<unmatched>', status: res.statusCode }));
  });
  res.on('close', () => {
    if (!res.writableEnded) console.log(JSON.stringify({ level: 'info', requestId: req.requestId, method: req.method, event: 'client_disconnected' }));
  });
  next();
}

export function sendError(res, code, details = [], retryAfter) {
  const [status, message] = errors[code] || errors.INTERNAL_ERROR;
  if (retryAfter !== undefined) res.set('Retry-After', String(retryAfter));
  return res.status(status).json({ error: { code, message, details }, requestId: res.req.requestId });
}

export function logServerError(req, code) {
  console.error(JSON.stringify({ level: 'error', requestId: req.requestId, code }));
}

export function installApiFallback(app) {
  app.use('/api/v1', (_req, res) => sendError(res, 'NOT_FOUND'));
  app.use((error, req, res, _next) => {
    if (res.headersSent) return res.end();
    logServerError(req, error?.code || 'INTERNAL_ERROR');
    return sendError(res, 'INTERNAL_ERROR');
  });
}
