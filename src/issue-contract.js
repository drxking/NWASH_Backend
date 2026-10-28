import { createHash } from 'node:crypto';
import { ApiError } from './http.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hasKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (field, reason) => { throw new ApiError('VALIDATION_ERROR', [{ field, reason }]); };

function date(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) fail(field, 'ISO 8601 timestamp required');
  return new Date(value).toISOString();
}

export function parseMetadata(raw, limits) {
  let value;
  try { value = JSON.parse(raw); } catch { fail('metadata', 'Invalid JSON'); }
  if (!object(value) || !hasKeys(value, ['clientIssueId', 'clientCreatedAt', 'clientUpdatedAt', 'description', 'locationStatus', 'locationSource', 'location', 'attachments'])) fail('metadata', 'Unexpected or invalid fields');
  const clientIssueId = value.clientIssueId;
  if (typeof clientIssueId !== 'string' || !idPattern.test(clientIssueId)) fail('clientIssueId', 'Use 1–128 ASCII letters, digits, underscore, or hyphen');
  const clientCreatedAt = date(value.clientCreatedAt, 'clientCreatedAt');
  const clientUpdatedAt = date(value.clientUpdatedAt, 'clientUpdatedAt');
  if (typeof value.description !== 'string' || value.description.length > 10000) fail('description', 'Must be a string of at most 10000 characters');
  if (!['none', 'unavailable', 'captured'].includes(value.locationStatus)) fail('locationStatus', 'Must be none, unavailable, or captured');
  let location = null;
  let locationSource = null;
  if (value.locationStatus === 'captured') {
    if (!object(value.location) || !hasKeys(value.location, ['latitude', 'longitude', 'accuracy', 'timestamp'])) fail('location', 'Invalid location');
    const { latitude, longitude, accuracy, timestamp } = value.location;
    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180 || !Number.isFinite(accuracy) || accuracy < 0 || !Number.isSafeInteger(timestamp) || timestamp < 100000000000 || timestamp > 8640000000000000) fail('location', 'Coordinates, accuracy, or millisecond timestamp are invalid');
    if (value.locationSource !== undefined && value.locationSource !== null && value.locationSource !== 'manual') fail('locationSource', 'Must be manual when provided');
    location = { latitude, longitude, accuracy, timestamp };
    locationSource = value.locationSource || null;
  } else if (value.location !== undefined && value.location !== null || value.locationSource !== undefined && value.locationSource !== null) {
    fail('location', 'Location is allowed only when captured');
  }
  if (!Array.isArray(value.attachments)) fail('attachments', 'Must be an array');
  const seen = new Set();
  let photos = 0;
  let audio = 0;
  const attachments = value.attachments.map((item, index) => {
    if (!object(item) || !hasKeys(item, ['clientAttachmentId', 'kind', 'createdAt', 'durationMs'])) fail(`attachments[${index}]`, 'Unexpected or invalid fields');
    if (typeof item.clientAttachmentId !== 'string' || !idPattern.test(item.clientAttachmentId) || seen.has(item.clientAttachmentId)) fail(`attachments[${index}].clientAttachmentId`, 'Invalid or duplicate attachment id');
    seen.add(item.clientAttachmentId);
    if (!['photo', 'audio'].includes(item.kind)) fail(`attachments[${index}].kind`, 'Must be photo or audio');
    if (item.kind === 'photo') {
      photos++;
      if (item.durationMs !== undefined && item.durationMs !== null) fail(`attachments[${index}].durationMs`, 'Only audio may have durationMs');
    } else {
      audio++;
      if (item.durationMs !== undefined && item.durationMs !== null && (!Number.isFinite(item.durationMs) || item.durationMs < 0)) fail(`attachments[${index}].durationMs`, 'Must be a finite nonnegative number');
    }
    return { clientAttachmentId: item.clientAttachmentId, kind: item.kind, createdAt: date(item.createdAt, `attachments[${index}].createdAt`), durationMs: item.kind === 'audio' ? item.durationMs ?? null : null };
  });
  if (photos > limits.maxPhotos || audio > limits.maxAudio) throw new ApiError('PAYLOAD_TOO_LARGE', [{ field: 'attachments', reason: 'Attachment count exceeded' }]);
  if (!value.description.trim() && !attachments.length) fail('description', 'Description or at least one attachment required');
  return { clientIssueId, clientCreatedAt, clientUpdatedAt, description: value.description, locationStatus: value.locationStatus, locationSource, location, attachments };
}

export function matchFiles(metadata, files, headerKey) {
  if (headerKey !== metadata.clientIssueId) fail('Idempotency-Key', 'Must equal clientIssueId');
  const expected = new Set(metadata.attachments.map((item) => item.clientAttachmentId));
  if (files.length !== expected.size) fail('attachments', 'Each declared attachment needs exactly one file');
  const byId = new Map();
  for (const file of files) {
    const id = file.fieldName.startsWith('media:') ? file.fieldName.slice(6) : '';
    if (!expected.has(id) || byId.has(id)) fail(file.fieldName, 'Undeclared or duplicate file part');
    byId.set(id, file);
  }
  for (const item of metadata.attachments) {
    const file = byId.get(item.clientAttachmentId);
    if (!file) fail(item.clientAttachmentId, 'Missing file part');
    file.kind = item.kind;
  }
  return byId;
}

export function fingerprint(metadata, filesById) {
  const canonical = {
    clientIssueId: metadata.clientIssueId,
    clientCreatedAt: metadata.clientCreatedAt,
    clientUpdatedAt: metadata.clientUpdatedAt,
    description: metadata.description,
    locationStatus: metadata.locationStatus,
    locationSource: metadata.locationSource,
    location: metadata.location,
    attachments: [...metadata.attachments].sort((a, b) => a.clientAttachmentId < b.clientAttachmentId ? -1 : a.clientAttachmentId > b.clientAttachmentId ? 1 : 0).map((item) => ({ ...item, sha256: filesById.get(item.clientAttachmentId).sha256 })),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function issueResponse(row) {
  return {
    id: row.id,
    clientIssueId: row.clientIssueId,
    clientCreatedAt: row.clientCreatedAt.toISOString(),
    clientUpdatedAt: row.clientUpdatedAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    description: row.description,
    locationStatus: row.locationStatus,
    locationSource: row.locationSource,
    location: row.locationStatus === 'captured' ? { latitude: row.latitude, longitude: row.longitude, accuracy: row.accuracy, timestamp: Number(row.locationTimestamp) } : null,
    attachments: row.attachments.map((item) => ({
      id: item.id,
      clientAttachmentId: item.clientAttachmentId,
      kind: item.kind,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      sha256: item.sha256,
      createdAt: item.createdAt.toISOString(),
      durationMs: item.durationMs,
      contentPath: `/api/v1/issues/${row.id}/attachments/${item.id}/content`,
    })),
  };
}

export function encodeCursor(row) {
  return Buffer.from(JSON.stringify([row.clientCreatedAt.toISOString(), row.id])).toString('base64url');
}

export function decodeCursor(value) {
  if (typeof value !== 'string' || value.length > 200) fail('cursor', 'Invalid cursor');
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !uuidPattern.test(parsed[1])) fail('cursor', 'Invalid cursor');
    return { date: date(parsed[0], 'cursor'), id: parsed[1] };
  } catch { fail('cursor', 'Invalid cursor'); }
}
