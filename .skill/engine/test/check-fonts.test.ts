import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkFonts } from '../../scripts/check-fonts.mjs';

test('font preflight accepts pinned files during unsealed source maintenance and aggregates missing/wrong versions', () => {
  const skill = mkdtempSync(join(tmpdir(), 'font-preflight-'));
  try {
    mkdirSync(join(skill, 'engine/assets/fonts'), { recursive: true });
    const files = Array.from({ length: 5 }, (_, i) => {
      const data = Buffer.from(`independent font version ${i}`), path = `assets/fonts/fixture-${i}.ttf`;
      writeFileSync(join(skill, 'engine', path), data);
      return { path, sha256: createHash('sha256').update(data).digest('hex') };
    });
    const manifest = { packageId: 'unsealed-source-is-allowed', files: [...files, { path: 'src/changed.ts', sha256: 'old source' }] };
    writeFileSync(join(skill, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(skill, 'engine/changed.ts'), 'legitimate source maintenance');
    assert.equal(checkFonts(skill).fonts.length, 5);
    rmSync(join(skill, 'engine', files[0]!.path));
    const wrong = join(skill, 'engine', files[1]!.path); writeFileSync(wrong, 'old version');
    const before = readFileSync(wrong), actual = createHash('sha256').update(before).digest('hex');
    assert.throws(() => checkFonts(skill), error => {
      const message = String(error);
      assert.ok(message.includes(`${files[0]!.path}: expected=${files[0]!.sha256}; actual=missing`));
      assert.ok(message.includes(`${files[1]!.path}: expected=${files[1]!.sha256}; actual=${actual}`));
      assert.match(message, /README.md#字体与原生依赖恢复/); return true;
    });
    assert.deepEqual(readFileSync(wrong), before);
    writeFileSync(join(skill, 'manifest.json'), JSON.stringify({ ...manifest, files: files.slice(1) }));
    assert.throws(() => checkFonts(skill), /CHECK_FONT_MANIFEST_INVALID/);
  } finally { rmSync(skill, { recursive: true, force: true }); }
});
