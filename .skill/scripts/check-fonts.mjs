import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/** Check only the sealed font identities, so source maintenance can run before resealing. */
export function checkFonts(skill) {
  const manifest = JSON.parse(readFileSync(join(skill, 'manifest.json'), 'utf8'));
  const expected = manifest.files.filter(file => /^assets\/fonts\/[^/]+\.(?:ttf|otf|ttc)$/.test(file.path));
  if (expected.length !== 5 || new Set(expected.map(file => file.path)).size !== 5 || expected.some(file => !/^[a-f0-9]{64}$/.test(file.sha256)))
    throw Error('CHECK_FONT_MANIFEST_INVALID: expected the five pinned font identities');
  const fonts = expected.map(file => {
    const path = join(skill, 'engine', file.path); let actual;
    try { actual = createHash('sha256').update(readFileSync(path)).digest('hex'); }
    catch (error) { actual = error.code === 'ENOENT' ? 'missing' : `unreadable: ${error.code ?? error.message}`; }
    return { path: file.path, expected: file.sha256, actual };
  });
  const failures = fonts.filter(file => file.actual !== file.expected);
  if (failures.length) throw Error('CHECK_FONTS_FAILED:\n' + failures.map(file => `${file.path}: expected=${file.expected}; actual=${file.actual}`).join('\n') +
    '\nRestore the fixed originals using README.md#字体与原生依赖恢复 (repository root). This check only reads files.');
  return { ok: true, fonts };
}
