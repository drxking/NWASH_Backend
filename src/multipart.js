import Busboy from 'busboy';
import { ApiError } from './http.js';

export async function parseIssueMultipart(req, storage, limits) {
  if (!req.is('multipart/form-data')) throw new ApiError('VALIDATION_ERROR', [{ field: 'Content-Type', reason: 'multipart/form-data required' }]);
  const claimedLength = Number(req.get('Content-Length'));
  if (Number.isFinite(claimedLength) && claimedLength > limits.maxRequestBytes) throw new ApiError('PAYLOAD_TOO_LARGE');
  let parser;
  try {
    parser = Busboy({ headers: req.headers, limits: { fieldNameSize: 140, fieldSize: limits.maxMetadataBytes, fields: 1, files: limits.maxPhotos + limits.maxAudio, fileSize: Math.max(limits.maxPhotoBytes, limits.maxAudioBytes), parts: limits.maxPhotos + limits.maxAudio + 1, headerPairs: 30 } });
  } catch {
    throw new ApiError('VALIDATION_ERROR', [{ field: 'Content-Type', reason: 'Invalid multipart boundary' }]);
  }
  const files = [];
  const tasks = [];
  let metadataRaw;
  let failure;
  let received = 0;
  const fail = (error) => { if (!failure) failure = error; };
  return await new Promise((resolve, reject) => {
    parser.on('field', (name, value, info) => {
      if (name !== 'metadata' || metadataRaw !== undefined) fail(new ApiError('VALIDATION_ERROR', [{ field: name, reason: 'Exactly one metadata part required' }]));
      else metadataRaw = value;
      if (info.valueTruncated || info.nameTruncated) fail(new ApiError('PAYLOAD_TOO_LARGE', [{ field: 'metadata', reason: 'Metadata limit exceeded' }]));
    });
    parser.on('file', (fieldName, stream, info) => {
      if (!/^media:[A-Za-z0-9_-]{1,128}$/.test(fieldName) || info.nameTruncated) {
        fail(new ApiError('VALIDATION_ERROR', [{ field: fieldName, reason: 'Unexpected media part' }]));
        stream.resume();
        return;
      }
      const task = storage.stage(stream, fieldName, info.mimeType).then((file) => files.push(file)).catch(fail);
      tasks.push(task);
    });
    parser.on('partsLimit', () => fail(new ApiError('PAYLOAD_TOO_LARGE', [{ field: 'multipart', reason: 'Too many parts' }])));
    parser.on('filesLimit', () => fail(new ApiError('PAYLOAD_TOO_LARGE', [{ field: 'multipart', reason: 'Too many files' }])));
    parser.on('fieldsLimit', () => fail(new ApiError('VALIDATION_ERROR', [{ field: 'metadata', reason: 'Extra field' }])));
    parser.on('error', () => fail(new ApiError('VALIDATION_ERROR', [{ field: 'multipart', reason: 'Malformed multipart body' }])));
    parser.on('close', async () => {
      await Promise.allSettled(tasks);
      if (failure) return reject(Object.assign(failure, { stagedFiles: files }));
      if (metadataRaw === undefined) return reject(Object.assign(new ApiError('VALIDATION_ERROR', [{ field: 'metadata', reason: 'Missing metadata' }]), { stagedFiles: files }));
      return resolve({ metadataRaw, files });
    });
    req.on('aborted', () => { fail(new ApiError('VALIDATION_ERROR', [{ field: 'request', reason: 'Upload interrupted' }])); parser.destroy(); });
    req.on('close', () => {
      if (!req.complete && !parser.destroyed) {
        fail(new ApiError('VALIDATION_ERROR', [{ field: 'request', reason: 'Upload interrupted' }]));
        parser.destroy();
      }
    });
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > limits.maxRequestBytes && !failure) {
        fail(new ApiError('PAYLOAD_TOO_LARGE'));
        req.unpipe(parser);
        parser.destroy();
        req.resume();
      }
    });
    req.pipe(parser);
  });
}
