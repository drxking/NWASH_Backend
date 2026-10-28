import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssueStorage } from '../src/issue-storage.js';
import { parseIssueMultipart } from '../src/multipart.js';

const limits = { maxPhotos: 20, maxAudio: 10, maxPhotoBytes: 15 * 1024 * 1024, maxAudioBytes: 30 * 1024 * 1024, maxMetadataBytes: 128 * 1024, maxRequestBytes: 200 * 1024 * 1024 };

test('streaming multipart parser stages a named file and bounded metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nwash-parser-'));
  const storage = new IssueStorage(root);
  await storage.initialize();
  try {
    const boundary = 'test-boundary';
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"clientIssueId":"x"}\r\n--${boundary}\r\nContent-Disposition: form-data; name="media:p"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\nabc\r\n--${boundary}--\r\n`);
    const req = new PassThrough();
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
    req.get = (name) => req.headers[name.toLowerCase()];
    req.is = () => true;
    req.complete = true;
    const parsed = parseIssueMultipart(req, storage, limits);
    req.end(body);
    const result = await parsed;
    assert.equal(result.metadataRaw, '{"clientIssueId":"x"}');
    assert.equal(result.files.length, 1);
    assert.equal(result.files[0].fieldName, 'media:p');
    assert.equal(result.files[0].sizeBytes, 3);
    await storage.removeStaged(result.files);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('streaming parser rejects an oversized request before writing files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nwash-parser-'));
  const storage = new IssueStorage(root);
  await storage.initialize();
  try {
    const req = new PassThrough();
    req.headers = { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '500' };
    req.get = (name) => req.headers[name.toLowerCase()];
    req.is = () => true;
    await assert.rejects(parseIssueMultipart(req, storage, { ...limits, maxRequestBytes: 100 }), (error) => error.code === 'PAYLOAD_TOO_LARGE');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('interrupted streaming request removes partially staged files', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nwash-parser-'));
  const storage = new IssueStorage(root);
  await storage.initialize();
  try {
    const boundary = 'test-boundary';
    const req = new PassThrough();
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    req.get = (name) => req.headers[name.toLowerCase()];
    req.is = () => true;
    req.complete = false;
    const parsed = parseIssueMultipart(req, storage, limits);
    req.write(`--${boundary}\r\nContent-Disposition: form-data; name="media:p"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\npartial`);
    req.emit('aborted');
    req.destroy();
    await assert.rejects(parsed);
    assert.deepEqual(await (await import('node:fs/promises')).readdir(storage.stagingDir), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
