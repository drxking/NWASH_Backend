import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ApiError } from './http.js';

const keyPattern = /^[0-9a-f-]{36}\.(?:jpg|png|heic|heif|m4a)$/;
const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'audio/mp4': 'm4a' };

async function syncDirectory(path) {
  const descriptor = await open(path, 'r');
  try { await descriptor.sync(); } finally { await descriptor.close(); }
}

export class IssueStorage {
  constructor(root) {
    this.root = resolve(root);
    this.stagingDir = join(this.root, 'staging');
    this.objectsDir = join(this.root, 'objects');
  }

  async initialize() {
    await mkdir(this.stagingDir, { recursive: true });
    await mkdir(this.objectsDir, { recursive: true });
  }

  async checkReady() {
    for (const directory of [this.stagingDir, this.objectsDir]) {
      const path = join(directory, `.ready-${randomUUID()}`);
      const descriptor = await open(path, 'wx');
      try { await descriptor.writeFile('ok'); await descriptor.sync(); } finally { await descriptor.close(); await rm(path, { force: true }); }
    }
  }

  async stage(stream, fieldName, declaredMime) {
    const stagedPath = join(this.stagingDir, randomUUID());
    const digest = createHash('sha256');
    let sizeBytes = 0;
    const hashing = new Transform({
      transform(chunk, _encoding, callback) {
        sizeBytes += chunk.length;
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    try {
      await pipeline(stream, hashing, createWriteStream(stagedPath, { flags: 'wx', flush: true }));
      if (stream.truncated) throw new ApiError('PAYLOAD_TOO_LARGE', [{ field: fieldName, reason: 'File exceeds per-file limit' }]);
      return { stagedPath, fieldName, declaredMime, sizeBytes, sha256: digest.digest('hex') };
    } catch (error) {
      await rm(stagedPath, { force: true });
      throw error;
    }
  }

  async promote(file, mimeType) {
    const storageKey = `${randomUUID()}.${extension[mimeType]}`;
    await rename(file.stagedPath, join(this.objectsDir, storageKey));
    await syncDirectory(this.objectsDir);
    return storageKey;
  }

  // Injection point for a durability check before the database write.
  async beforeCommit() {}

  pathFor(storageKey) {
    if (!keyPattern.test(storageKey)) throw new Error('Invalid server storage key');
    return join(this.objectsDir, storageKey);
  }

  async removeStaged(files) {
    await Promise.all(files.map((file) => rm(file.stagedPath, { force: true })));
  }

  async removePromoted(keys) {
    await Promise.all(keys.map((key) => rm(this.pathFor(key), { force: true })));
  }

  async exists(storageKey, expectedSize) {
    try {
      const info = await stat(this.pathFor(storageKey));
      return info.isFile() && (expectedSize === undefined || info.size === expectedSize);
    } catch { return false; }
  }
}
