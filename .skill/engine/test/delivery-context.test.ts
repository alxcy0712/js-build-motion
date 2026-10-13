import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, symlinkSync, linkSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PROJECT_ROOT } from '../src/utils/env.ts';
import { deliveryDocumentFiles, verifyDeliveryFiles } from '../src/application/delivery-context.ts';

test('evidence uses independent current bytes and rejects equal-size replacement and linked files', async () => {
  const out = resolve(PROJECT_ROOT, '../..', '.research/out'); mkdirSync(out, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(out, 'delivery-file-'))), path = join(dir, 'evidence.json');
  const bytes = Buffer.from('original'), file = { path: 'evidence.json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  try {
    writeFileSync(path, bytes); await verifyDeliveryFiles(dir, [file]);
    writeFileSync(path, 'replaced'); await assert.rejects(verifyDeliveryFiles(dir, [file]), /DELIVERY_FILE_CHANGED/);
    writeFileSync(path, bytes); linkSync(path, join(dir, 'hard.json'));
    await assert.rejects(verifyDeliveryFiles(dir, [file]), /IMPORT_FILE_INVALID/);
    rmSync(join(dir, 'hard.json')); rmSync(path); writeFileSync(join(dir, 'source.json'), bytes); symlinkSync('source.json', path);
    await assert.rejects(verifyDeliveryFiles(dir, [file]), /IMPORT_SYMLINK/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('nested evidence references keep one identity per safe path', () => {
  const file = { path: 'evidence/observation.json', bytes: 3, sha256: 'a'.repeat(64) };
  assert.deepEqual(deliveryDocumentFiles({ observations: [{ evidence: [file] }], checks: [{ evidence: [file] }] }), [file]);
  assert.throws(() => deliveryDocumentFiles({ evidence: [file, { ...file, sha256: 'b'.repeat(64) }] }), /DELIVERY_FILE_CONFLICT/);
  assert.throws(() => deliveryDocumentFiles({ evidence: [{ ...file, path: '../outside.json' }] }), /DELIVERY_FILE_INVALID/);
});
