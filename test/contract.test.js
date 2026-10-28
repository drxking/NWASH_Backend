import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMetadata, matchFiles, fingerprint, encodeCursor, decodeCursor } from '../src/issue-contract.js';
import { verifyMedia } from '../src/media-validation.js';

const limits = { maxPhotos: 20, maxAudio: 10 };
const base = {
  clientIssueId: '1793193119352-190i1858',
  clientCreatedAt: '2026-10-28T12:00:00.000Z',
  clientUpdatedAt: '2026-10-28T12:10:00.000Z',
  description: 'Water leak',
  locationStatus: 'none',
  attachments: [],
};

test('metadata rejects guest ownership and invalid location while preserving old timestamps', () => {
  const old = parseMetadata(JSON.stringify({ ...base, clientCreatedAt: '2020-01-01T00:00:00Z' }), limits);
  assert.equal(old.clientCreatedAt, '2020-01-01T00:00:00.000Z');
  assert.throws(() => parseMetadata(JSON.stringify({ ...base, ownerId: 'guest' }), limits), /Invalid request/);
  assert.throws(() => parseMetadata(JSON.stringify({ ...base, locationStatus: 'captured', location: { latitude: 1, longitude: 1, accuracy: 5, timestamp: 1793188800 } }), limits), /Invalid request/);
  assert.throws(() => parseMetadata(JSON.stringify({ ...base, description: ' ' }), limits), /Invalid request/);
});

test('canonical fingerprint ignores metadata and part ordering', () => {
  const attachments = [
    { clientAttachmentId: 'p', kind: 'photo', createdAt: base.clientCreatedAt },
    { clientAttachmentId: 'a', kind: 'audio', createdAt: base.clientCreatedAt, durationMs: 900 },
  ];
  const one = parseMetadata(JSON.stringify({ ...base, attachments }), limits);
  const two = parseMetadata(JSON.stringify({ attachments: [...attachments].reverse(), locationStatus: 'none', description: 'Water leak', clientUpdatedAt: base.clientUpdatedAt, clientCreatedAt: base.clientCreatedAt, clientIssueId: base.clientIssueId }), limits);
  const filesOne = [{ fieldName: 'media:p', sha256: '1' }, { fieldName: 'media:a', sha256: '2' }];
  const filesTwo = [...filesOne].reverse();
  assert.equal(fingerprint(one, matchFiles(one, filesOne, base.clientIssueId)), fingerprint(two, matchFiles(two, filesTwo, base.clientIssueId)));
  assert.throws(() => matchFiles(one, [{ fieldName: 'media:p' }, { fieldName: 'media:p' }], base.clientIssueId), /Invalid request/);
});

test('cursor round-trips creation time and id', () => {
  const id = '8a27f475-f32b-41e7-9f19-f2e9d4bc5e60';
  const cursor = encodeCursor({ clientCreatedAt: new Date(base.clientCreatedAt), id });
  assert.deepEqual(decodeCursor(cursor), { date: base.clientCreatedAt, id });
  assert.throws(() => decodeCursor('not-a-cursor'), /Invalid request/);
});

test('real phone-like media fixtures pass, corrupted and mislabeled content fails', async () => {
  for (const [name, kind, declaredMime] of [['photo.jpg', 'photo', 'image/jpeg'], ['photo.png', 'photo', 'image/png'], ['voice.m4a', 'audio', 'audio/mp4']]) {
    const stagedPath = new URL(`./fixtures/${name}`, import.meta.url).pathname;
    assert.equal(await verifyMedia({ stagedPath, kind, declaredMime, fieldName: 'media:x' }), declaredMime);
  }
  const directory = mkdtempSync(join(tmpdir(), 'nwash-media-'));
  try {
    const path = join(directory, 'bad');
    writeFileSync(path, await readFile(new URL('./fixtures/photo.png', import.meta.url)));
    await assert.rejects(verifyMedia({ stagedPath: path, kind: 'photo', declaredMime: 'image/jpeg', fieldName: 'media:x' }), /Unsupported or invalid media/);
    writeFileSync(path, Buffer.alloc(0));
    await assert.rejects(verifyMedia({ stagedPath: path, kind: 'photo', declaredMime: 'image/png', fieldName: 'media:x' }), /Unsupported or invalid media/);
    const box = (type, payload) => {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(payload.length + 8);
      header.write(type, 4, 'ascii');
      return Buffer.concat([header, payload]);
    };
    const videoHeif = Buffer.concat([
      box('ftyp', Buffer.concat([Buffer.from('hevc'), Buffer.alloc(4), Buffer.from('mif1')])),
      box('meta', Buffer.concat([Buffer.alloc(4), box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from('pict')]))])),
      box('mdat', Buffer.from('image-data')),
    ]);
    writeFileSync(path, videoHeif);
    await assert.rejects(verifyMedia({ stagedPath: path, kind: 'photo', declaredMime: 'image/heif', fieldName: 'media:x' }), /Unsupported or invalid media/);
    const stillHeic = Buffer.concat([
      box('ftyp', Buffer.concat([Buffer.from('mif1'), Buffer.alloc(4), Buffer.from('heic'), Buffer.from('hevc')])),
      box('meta', Buffer.concat([Buffer.alloc(4), box('hdlr', Buffer.concat([Buffer.alloc(8), Buffer.from('pict')]))])),
      box('mdat', Buffer.from('image-data')),
    ]);
    writeFileSync(path, stillHeic);
    await assert.rejects(verifyMedia({ stagedPath: path, kind: 'photo', declaredMime: 'image/heic', fieldName: 'media:x' }), /Unsupported or invalid media/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
