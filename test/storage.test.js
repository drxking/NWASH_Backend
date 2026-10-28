import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IssueStorage } from '../src/issue-storage.js';

test('staged bytes are hashed, promoted, durable, and found through server key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nwash-storage-'));
  const storage = new IssueStorage(root);
  await storage.initialize();
  try {
    await storage.checkReady();
    const source = new PassThrough();
    const bytes = await readFile(new URL('./fixtures/photo.png', import.meta.url));
    const staged = storage.stage(source, 'media:p', 'image/png');
    source.end(bytes);
    const file = await staged;
    assert.equal(file.sizeBytes, bytes.length);
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    const key = await storage.promote(file, 'image/png');
    assert.match(key, /^[0-9a-f-]{36}\.png$/);
    assert.equal(await storage.exists(key, bytes.length), true);
    assert.deepEqual(await readFile(storage.pathFor(key)), bytes);
    assert.throws(() => storage.pathFor('../escape.png'));
    await storage.removePromoted([key]);
    assert.equal(await storage.exists(key), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
