import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { importOriginals } from '../src/application/import.ts';
import { catalogAssets, verifyCatalog } from '../src/application/catalog.ts';
import { alignAsset, verifyAlignment } from '../src/application/alignment.ts';
import { INSPECT_POLICY_05 } from '../src/project/catalog.ts';
import { ALIGNMENT_POLICY_02, alignmentSubjectSha256 } from '../src/project/alignment.ts';
import { initProject } from '../src/project/scaffold.ts';
import { importJsonText } from '../src/adapters/import-files.ts';
import { PROJECT_ROOT } from '../src/utils/env.ts';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const save = (path: string, value: unknown) => fs.writeFileSync(path, importJsonText(value));
const json = (path: string) => JSON.parse(fs.readFileSync(path, 'utf8'));
async function fixture() {
  const out = resolve(PROJECT_ROOT, '../..', '.research/out'); fs.mkdirSync(out, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(join(out, 'alignment-common-'))), dir = initProject({ slug: 'alignment-common', projectsRoot: join(root, 'projects') }).dir;
  fs.mkdirSync(join(dir, 'inputs'), { recursive: true });
  const selected = join(root, 'selected'); fs.mkdirSync(selected); const wave = Buffer.alloc(38444);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22);
  wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(192000, 28); wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(38400, 40);
  fs.writeFileSync(join(selected, 'stereo.wav'), wave); save(join(dir, 'inputs/inspect-policy.json'), INSPECT_POLICY_05); save(join(dir, 'inputs/alignment-policy.json'), ALIGNMENT_POLICY_02);
  const imported = await importOriginals(dir, selected), receipt = await catalogAssets(dir, { importId: imported.importId }), catalog = await verifyCatalog(dir, receipt.catalogId), asset = catalog.assets[0]!;
  const approval = Buffer.from('Independent fictional delegated script approval.'); fs.writeFileSync(join(dir, 'inputs/approval.txt'), approval);
  const subject = { version: '0.1', kind: 'alignment-script', language: 'en', lineId: 'common-line', text: 'boat' };
  save(join(dir, 'inputs/script.json'), { ...subject, approval: { scope: 'word-alignment', basis: 'delegated', decisionId: 'common-fixture', subjectSha256: alignmentSubjectSha256(subject as any), sourceRef: { path: 'inputs/approval.txt', bytes: approval.length, sha256: sha(approval) } } });
  return { root, dir, asset, selection: { catalogId: catalog.catalogId, assetId: asset.assetId, assetVersion: asset.assetVersion, scriptPath: 'inputs/script.json' } };
}
async function emptyProvider<T>(action: () => Promise<T>) {
  const spawn = childProcess.spawn, calls: Buffer[] = [];
  try {
    childProcess.spawn = ((executable: string, argv: string[], options: any) => {
      if (String(executable).endsWith('/assets/asr/bin/whisper-cli')) {
        calls.push(fs.readFileSync(argv[argv.indexOf('-f') + 1]!));
        const model = argv[argv.indexOf('-m') + 1], language = argv[argv.indexOf('-l') + 1];
        const raw = { systeminfo: 'independent empty provider', model: { type: 'base', multilingual: true, vocab: 51865,
          audio: { ctx: 1500, state: 512, head: 8, layer: 6 }, text: { ctx: 448, state: 512, head: 8, layer: 6 }, mels: 80, ftype: 1 }, params: { model, language, translate: false }, result: { language }, transcription: [] };
        return spawn(process.execPath, ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(raw))})`], options);
      }
      return spawn(executable, argv, options);
    }) as typeof spawn; syncBuiltinESMExports(); return { result: await action(), calls };
  } finally { childProcess.spawn = spawn; syncBuiltinESMExports(); }
}
test('alignment .2 reuses the common canonical waveform while catalog ASR is disabled', async () => {
  const f = await fixture(); try {
    assert.equal(f.asset.technical.asr?.status, 'disabled'); assert.equal(f.asset.technical.audioInput?.status, 'completed');
    const audio = f.asset.technical.evidence.find(entry => entry.kind === 'audio-canonical')!, frozen = fs.readFileSync(join(f.dir, audio.path));
    const { result: receipt, calls } = await emptyProvider(() => alignAsset(f.dir, f.selection)), manifest = await verifyAlignment(f.dir, receipt.alignmentId);
    assert.equal(receipt.version, '0.2'); assert.equal(manifest.version, '0.2'); assert.equal(manifest.audio.samples, 3200); assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], frozen); assert.deepEqual(fs.readFileSync(join(f.dir, manifest.audio.path)), frozen);
    assert.equal((manifest.source as any).input.samples, 9600); assert.equal((manifest.source as any).input.channels, 2);
    assert.equal((manifest.source as any).audioEvidenceId, audio.id); assert.equal(json(join(f.dir, 'assets/alignment.json')).version, '0.2');
    assert.equal(json(join(f.dir, manifest.map.path)).coverage.listening, 'unverified');
    const moved = join(f.root, 'relocated'); fs.renameSync(f.dir, moved); assert.deepEqual(await verifyAlignment(moved, receipt.alignmentId), manifest);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test('alignment .2 detects common canonical replacement before preparing and preserves current index', async () => {
  const f = await fixture(); try {
    const { result: first } = await emptyProvider(() => alignAsset(f.dir, f.selection));
    const index = fs.readFileSync(join(f.dir, 'assets/alignment.json')), audio = f.asset.technical.evidence.find(entry => entry.kind === 'audio-canonical')!, path = join(f.dir, audio.path), bytes = fs.readFileSync(path);
    await assert.rejects(emptyProvider(() => alignAsset(f.dir, f.selection, { hooks: { afterProvider: async () => {
      const altered = Buffer.from(bytes); altered[altered.length - 1] ^= 1; fs.writeFileSync(path, altered);
    } } })), /INPUT_CHANGED/);
    assert.deepEqual(fs.readFileSync(join(f.dir, 'assets/alignment.json')), index); fs.writeFileSync(path, bytes); await verifyAlignment(f.dir, first.alignmentId);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
