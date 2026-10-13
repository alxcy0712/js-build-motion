import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

const sha = data => createHash('sha256').update(data).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const evidence = (asset, kind) => asset.technical.evidence.find(e => e.kind === kind);
function pngChunk(type, data = Buffer.alloc(0)) {
  const tag = Buffer.from(type), result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); tag.copy(result, 4); data.copy(result, 8); result.writeUInt32BE(crc32(Buffer.concat([tag, data])), result.length - 4); return result;
}
function rgbaPng() {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(3); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0, 128, 64, 32, 128, 255, 255, 255, 255]))), pngChunk('IEND')]);
}
function smallPng(palette = false) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(32); ihdr.writeUInt32BE(32, 4); ihdr[8] = 8; ihdr[9] = palette ? 3 : 2; ihdr[12] = palette ? 0 : 1;
  const scanlines = [];
  if (palette) for (let y = 0; y < 32; y++) scanlines.push(Buffer.from([0, ...Array.from({ length: 32 }, (_, x) => (x + y) % 2)]));
  else for (const [left, top, dx, dy] of [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]) {
    const width = Math.ceil((32 - left) / dx); for (let y = top; y < 32; y += dy) scanlines.push(Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 255)]));
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', ihdr), ...(palette ? [pngChunk('PLTE', Buffer.from([128, 64, 32, 255, 255, 255])), pngChunk('tRNS', Buffer.from([0, 255]))] : []), pngChunk('IDAT', deflateSync(Buffer.concat(scanlines))), pngChunk('IEND')]);
}
function smallJpeg(rgb = false) {
  const segment = (marker, data) => { const tag = Buffer.from([255, marker, 0, 0]); tag.writeUInt16BE(data.length + 2, 2); return Buffer.concat([tag, data]); };
  const components = rgb ? [82, 71, 66] : [1], frame = Buffer.from([8, 0, 32, 0, 32, components.length, ...components.flatMap(id => [id, 0x11, 0])]);
  const counts = [1, ...Array(15).fill(0)], tables = Buffer.from([0, ...counts, 0, 0x10, ...counts, 0]);
  const scan = (start, end, bits) => Buffer.concat([segment(0xda, Buffer.from([components.length, ...components.flatMap(id => [id, 0]), start, end, 0])), Buffer.alloc(bits / 8)]);
  const adobe = Buffer.concat([Buffer.from('Adobe'), Buffer.from([0, 100, 0, 0, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([255, 216]), ...(rgb ? [segment(0xee, adobe)] : []), segment(0xdb, Buffer.from([0, ...Array(64).fill(1)])), segment(rgb ? 0xc0 : 0xc2, frame), segment(0xc4, tables), ...(rgb ? [scan(0, 63, 16 * 3 * 2)] : [scan(0, 0, 16), scan(1, 63, 16)]), Buffer.from([255, 217])]);
}
function exifJpeg(bytes, orientation) {
  const payload = Buffer.alloc(32); Buffer.from('Exif\0\0II').copy(payload); payload.writeUInt16LE(42, 8); payload.writeUInt32LE(8, 10); payload.writeUInt16LE(1, 14); payload.writeUInt16LE(0x112, 16); payload.writeUInt16LE(3, 18); payload.writeUInt32LE(1, 20); payload.writeUInt16LE(orientation, 24);
  const marker = Buffer.alloc(4); marker[0] = 255; marker[1] = 225; marker.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([bytes.subarray(0, 2), marker, payload, bytes.subarray(2)]);
}
function record(asset, map) {
  const d = asset.technical.ocr, region = map.regions[0];
  return { version: '0.3', id: `observation-${randomUUID()}`, assetId: asset.assetId, assetVersion: asset.assetVersion, byteSha256: asset.source.sha256,
    method: 'fixed fictional OCR region', locator: { kind: 'ocr', evidenceId: d.textEvidenceId, mapEvidenceId: d.mapEvidenceId, rasterEvidenceId: d.rasterEvidenceId,
      regionId: region.id, byteStart: region.byteStart, byteEnd: region.byteEnd }, coverage: 'full', coverageScope: 'region-ocr-text',
    statement: 'Only this recognized region text was read.', basis: 'observed', confidence: 0.5, limitations: ['OCR recognition can omit or misread source text.'], evidenceRefs: [d.textEvidenceId, d.mapEvidenceId, d.rasterEvidenceId] };
}

/** The callback enters the real bound video CLI. Every fixture is independent of existing projects. */
export async function checkOcrNative({ scratch, skill, run, check, denied }) {
  const groups = [], root = join(scratch, 'ocr workspace'), core = join(root, '.skill'), project = join(root, 'projects/ocr-film'), other = join(root, 'projects/ocr-other'), selected = join(scratch, 'ocr sources');
  const gate = async (name, action) => { await check(name, action); groups.push(name); };
  const control = (args, expected = 0) => run(root, [join(core, 'scripts/video.mjs'), ...args], expected);
  const catalog = (args, expected = 0) => JSON.parse(control(['ocr-film', 'catalog', ...args], expected));
  const verify = id => catalog(['--verify', id]).manifest;
  const imported = source => JSON.parse(control(['ocr-film', 'import', '--source', source]));
  const setPolicy = (ocr = {}, common = {}) => save(join(project, 'inputs/inspect-policy.json'), { ...initialManifest.policy, ...common, ocr: { ...initialManifest.policy.ocr, ...ocr } });
  let selectedImport, initialReceipt, initialManifest, initialAsset, baseJpeg;

  await gate('OCR 真实统一入口、双语/空白/PNG/JPEG 与完整固定四证据', async () => {
    mkdirSync(root, { recursive: true }); cpSync(skill, core, { recursive: true }); mkdirSync(selected);
    const { Canvas, FontLibrary } = await import(pathToFileURL(join(skill, 'engine/node_modules/skia-canvas/lib/index.mjs')).href);
    FontLibrary.use('IndependentNativeOcr', [join(skill, 'engine/assets/fonts/LXGWWenKai-Regular.ttf')]);
    const canvas = new Canvas(1001, 301, { gpu: false }), ctx = canvas.getContext('2d'); ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1001, 301); ctx.fillStyle = 'black'; ctx.font = '72px IndependentNativeOcr'; ctx.fillText('中文 ALPHA 123', 40, 155);
    writeFileSync(join(selected, 'renamed.data'), await canvas.toBuffer('png')); baseJpeg = await canvas.toBuffer('jpeg'); writeFileSync(join(selected, 'native.jpg'), baseJpeg);
    ctx.fillStyle = 'white'; ctx.fillRect(0, 0, 1001, 301); writeFileSync(join(selected, 'blank.png'), await canvas.toBuffer('png'));
    ctx.clearRect(0, 0, 1001, 301); writeFileSync(join(selected, 'transparent.png'), await canvas.toBuffer('png')); writeFileSync(join(selected, 'alpha.png'), rgbaPng());
    writeFileSync(join(selected, 'palette-trns.png'), smallPng(true)); writeFileSync(join(selected, 'adam7.png'), smallPng()); writeFileSync(join(selected, 'gray-progressive.jpg'), smallJpeg()); writeFileSync(join(selected, 'rgb-baseline.jpg'), smallJpeg(true));
    for (const orientation of [1, 2, 3, 4, 5, 6, 7, 8]) writeFileSync(join(selected, `exif-${orientation}.jpg`), exifJpeg(baseJpeg, orientation));
    for (const slug of ['ocr-film', 'ocr-other']) control(['start', slug, '--idea', '虚构离线 OCR 门禁']);
    selectedImport = imported(selected); initialReceipt = catalog(['--import', selectedImport.importId]); initialManifest = verify(initialReceipt.catalogId); initialAsset = initialManifest.assets.find(a => a.source.path === 'renamed.data');
    assert.equal(initialManifest.version, '0.4'); assert.equal(initialManifest.policy.version, '0.4'); assert.equal(initialReceipt.status, 'succeeded'); assert.equal(initialManifest.assets.length, 17);
    for (const a of initialManifest.assets) {
      assert.equal(a.technical.status, 'supported', `${a.source.path}: ${a.technical.reason}`); const d = a.technical.ocr; assert.ok(d); assert.ok(['completed', 'no-text'].includes(d.status), `${a.source.path}: ${d.reason}`);
      const map = json(join(project, evidence(a, 'ocr-map').path));
      assert.equal(map.source.sha256, a.source.sha256); assert.equal(map.source.bytes, a.source.bytes); assert.equal(map.policySha256, a.inspection.policySha256);
      for (const [kind, field] of [['ocr-raster', 'raster'], ['ocr-tsv', 'rawTsv'], ['text', 'text']]) { const e = evidence(a, kind), bytes = readFileSync(join(project, e.path)); assert.equal(map[field].evidenceId, e.id); assert.equal(map[field].sha256, sha(bytes)); assert.equal(map[field].bytes, bytes.length); }
      assert.equal(map.raster.width, map.source.width); assert.equal(map.raster.height, map.source.height); assert.equal(map.raster.transform, 'identity'); assert.equal(map.raster.orientationApplied, false); assert.equal(a.usability.semanticMatch.result, 'unknown'); assert.equal(a.usability.rightsScope.result, 'unknown');
    }
    for (const name of ['renamed.data', 'native.jpg']) { const a = initialManifest.assets.find(a => a.source.path === name), text = readFileSync(join(project, evidence(a, 'text').path), 'utf8'); assert.match(text, /ALPHA/); assert.match(text.replace(/\s/g, ''), /中文/); }
    for (const name of ['blank.png', 'transparent.png']) { const a = initialManifest.assets.find(a => a.source.path === name), map = json(join(project, evidence(a, 'ocr-map').path)); assert.equal(a.technical.ocr.status, 'no-text'); assert.equal(evidence(a, 'text').bytes, 0); assert.deepEqual(map.regions, []); const ppm = readFileSync(join(project, evidence(a, 'ocr-raster').path)); assert.equal(ppm.subarray(Buffer.byteLength('P6\n1001 301\n255\n')).every(b => b === 255), true); }
    const alpha = initialManifest.assets.find(a => a.source.path === 'alpha.png'), ppm = readFileSync(join(project, evidence(alpha, 'ocr-raster').path)); assert.deepEqual(ppm, Buffer.concat([Buffer.from('P6\n3 1\n255\n'), Buffer.from([255, 255, 255, 191, 159, 143, 255, 255, 255])]));
    for (const name of ['palette-trns.png', 'adam7.png', 'gray-progressive.jpg', 'rgb-baseline.jpg']) { const a = initialManifest.assets.find(a => a.source.path === name), bytes = readFileSync(join(project, evidence(a, 'ocr-raster').path)); assert.equal(a.technical.ocr.status, 'no-text'); assert.deepEqual(bytes, Buffer.concat([Buffer.from('P6\n32 32\n255\n'), Buffer.alloc(32 * 32 * 3, name.endsWith('.jpg') ? 128 : 255)])); }
    const baseRaster = readFileSync(join(project, evidence(initialManifest.assets.find(a => a.source.path === 'native.jpg'), 'ocr-raster').path));
    for (let i = 1; i <= 8; i++) assert.deepEqual(readFileSync(join(project, evidence(initialManifest.assets.find(a => a.source.path === `exif-${i}.jpg`), 'ocr-raster').path)), baseRaster);
    assert.equal(JSON.parse(control(['ocr-film', 'catalog', '--schema', 'ocr-map'])).$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(JSON.parse(control(['ocr-film', 'catalog', '--schema', 'observation'])).$schema, 'http://json-schema.org/draft-07/schema#'); assert.equal(readdirSync(join(project, 'out/.tmp')).some(n => n.startsWith('catalog-sandbox-')), false);
  });

  await gate('OCR 区域观察、preview 旧观察、空区域与错误身份范围拒绝', () => {
    const map = json(join(project, evidence(initialAsset, 'ocr-map').path)), observed = record(initialAsset, map), path = join(project, 'inputs/ocr-observation.json'); save(path, observed);
    const accepted = catalog(['--observation', 'inputs/ocr-observation.json']); assert.deepEqual(verify(accepted.catalogId).observations.at(-1), observed);
    const before = readFileSync(join(project, 'assets/catalog.json'));
    for (const change of [{ byteSha256: 'f'.repeat(64) }, { confidence: 90 }, { locator: { ...observed.locator, regionId: 'unknown-region' } }, { locator: { ...observed.locator, mapEvidenceId: observed.locator.evidenceId } }, { evidenceRefs: [observed.locator.evidenceId] }, { locator: { ...observed.locator, byteEnd: observed.locator.byteEnd + 1 } }]) {
      save(path, { ...observed, id: `observation-${randomUUID()}`, ...change }); const failed = catalog(['--observation', 'inputs/ocr-observation.json'], 1); assert.equal(failed.indexCommitted, false); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before);
    }
    const text = evidence(initialAsset, 'text'), preview = evidence(initialAsset, 'preview');
    const legacy = { version: '0.1', id: `observation-${randomUUID()}`, assetId: initialAsset.assetId, assetVersion: initialAsset.assetVersion, byteSha256: initialAsset.source.sha256, method: 'legacy text bypass', locator: { kind: 'text', evidenceId: text.id, byteStart: 0, byteEnd: text.bytes, lineStart: 1, lineEnd: 1, x: null, y: null, width: null, height: null, streamIndex: null, timeBase: null, pts: null, sampleRate: null, sampleStart: null, sampleEnd: null }, coverage: 'full', statement: 'Fictional evidence.', basis: 'observed', confidence: null, limitations: [], evidenceRefs: [text.id] };
    save(path, legacy); assert.match(catalog(['--observation', 'inputs/ocr-observation.json'], 1).error, /OCR|LOCATOR/);
    const image = { ...legacy, id: `observation-${randomUUID()}`, locator: { ...legacy.locator, kind: 'image', evidenceId: preview.id, byteStart: null, byteEnd: null, lineStart: null, lineEnd: null, x: 0, y: 0, width: preview.width, height: preview.height }, evidenceRefs: [preview.id] }; save(path, image); verify(catalog(['--observation', 'inputs/ocr-observation.json']).catalogId);
    const blank = initialManifest.assets.find(a => a.source.path === 'blank.png'), empty = { ...observed, id: `observation-${randomUUID()}`, assetId: blank.assetId, assetVersion: blank.assetVersion, byteSha256: blank.source.sha256, locator: { kind: 'ocr', evidenceId: blank.technical.ocr.textEvidenceId, mapEvidenceId: blank.technical.ocr.mapEvidenceId, rasterEvidenceId: blank.technical.ocr.rasterEvidenceId, regionId: 'ocr-word-1', byteStart: 0, byteEnd: 1 }, evidenceRefs: [blank.technical.ocr.textEvidenceId, blank.technical.ocr.mapEvidenceId, blank.technical.ocr.rasterEvidenceId] }; save(path, empty); assert.equal(catalog(['--observation', 'inputs/ocr-observation.json'], 1).indexCommitted, false);
  });

  await gate('OCR 同源去重、新 import 同字节修订与 disabled 保留原证据', () => {
    const frozen = readFileSync(join(project, initialReceipt.manifestPath)), duplicate = catalog(['--import', selectedImport.importId]); assert.deepEqual(verify(duplicate.catalogId).assets, initialManifest.assets);
    const fresh = imported(selected), changed = catalog(['--import', fresh.importId, '--path', 'renamed.data', '--asset', initialAsset.assetId]), versions = verify(changed.catalogId).assets.filter(a => a.assetId === initialAsset.assetId); assert.equal(versions.length, 2); assert.deepEqual(versions[0], initialAsset); assert.equal(versions[1].source.sha256, initialAsset.source.sha256); assert.notEqual(versions[1].assetVersion, initialAsset.assetVersion);
    setPolicy({ enabled: false }); const disabledImport = imported(selected), disabled = catalog(['--import', disabledImport.importId, '--path', 'native.jpg']), asset = verify(disabled.catalogId).assets.at(-1); assert.equal(asset.technical.ocr.status, 'disabled'); assert.equal(asset.technical.status, 'supported'); assert.ok(evidence(asset, 'preview')); assert.equal(asset.technical.evidence.some(e => e.kind.startsWith('ocr-')), false);
    assert.deepEqual(readFileSync(join(project, initialReceipt.manifestPath)), frozen); verify(initialReceipt.catalogId); setPolicy();
  });

  await gate('OCR source/raster/TSV/text/map 同长度替换及丢失派生完整性拒绝', () => {
    for (const relative of [initialAsset.source.fixedPath, ...['ocr-raster', 'ocr-tsv', 'text', 'ocr-map'].map(kind => evidence(initialAsset, kind).path)]) {
      const path = join(project, relative), bytes = readFileSync(path), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; writeFileSync(path, changed);
      try { assert.match(control(['ocr-film', 'catalog', '--verify', initialReceipt.catalogId], 1), /CHANGED|INVALID|验证|Error/); }
      finally { writeFileSync(path, bytes); } verify(initialReceipt.catalogId);
    }
    const mapPath = join(project, evidence(initialAsset, 'ocr-map').path), bytes = readFileSync(mapPath), before = readFileSync(join(project, 'assets/catalog.json')); rmSync(mapPath);
    try { assert.match(control(['ocr-film', 'catalog', '--verify', initialReceipt.catalogId], 1), /ENOENT|Error/); const failed = catalog(['--import', selectedImport.importId], 1); assert.equal(failed.indexCommitted, false); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before); }
    finally { writeFileSync(mapPath, bytes); } verify(initialReceipt.catalogId);
  });

  await gate('OCR 本地限额 partial 保留 preview，全局限额保留 index', () => {
    for (const [ocr, pattern] of [[{ maxOcrSourceBytes: 1 }, /SOURCE_LIMIT/], [{ maxOcrTsvBytes: 1 }, /BINARY|TSV|OUTPUT/], [{ maxOcrMapBytes: 1 }, /MAP_LIMIT/]]) {
      setPolicy(ocr); const fresh = imported(selected), r = catalog(['--import', fresh.importId, '--path', 'renamed.data']), a = verify(r.catalogId).assets.at(-1); assert.equal(a.technical.status, 'partial', a.technical.reason); assert.ok(evidence(a, 'preview')); assert.ok(['failed', 'skipped'].includes(a.technical.ocr.status)); assert.match(a.technical.ocr.reason, pattern); assert.equal(a.technical.evidence.some(e => e.kind.startsWith('ocr-')), false);
    }
    const before = readFileSync(join(project, 'assets/catalog.json')); setPolicy({ maxOcrImagesPerAttempt: 0 }); const fresh = imported(selected), failed = catalog(['--import', fresh.importId, '--path', 'renamed.data'], 1); assert.equal(failed.indexCommitted, false); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before); setPolicy();
  });

  await gate('OCR 外部 native 缺失/身份变化 partial 与 packed 模型/锁完整性拒绝分层', async () => {
    const lockPath = join(core, 'engine/ocr-dependencies.lock.json'), original = readFileSync(lockPath), { sealCore } = await import(pathToFileURL(join(core, 'scripts/core.mjs')).href);
    try {
      for (const [slug, mutate] of [['ocr-native-missing', lock => { const tool = lock.tools.tesseract, previous = tool.executable, missing = '/opt/homebrew/Cellar/tesseract/0.fixture/bin/tesseract'; tool.executable = missing; for (const f of tool.files) if (f.path === previous) f.path = missing; for (const a of tool.aliases) if (a.realpath === previous) { if (a.path === previous) a.path = missing; a.realpath = missing; } }], ['ocr-native-changed', lock => { const tool = lock.tools.tesseract; tool.files.find(f => f.path === tool.executable).sha256 = 'f'.repeat(64); }]]) {
        const lock = JSON.parse(original); mutate(lock); save(lockPath, lock); sealCore(); control(['start', slug, '--idea', '虚构 native 身份失败']); const imp = JSON.parse(control([slug, 'import', '--source', join(selected, 'renamed.data')])), r = JSON.parse(control([slug, 'catalog', '--import', imp.importId])), a = JSON.parse(control([slug, 'catalog', '--verify', r.catalogId])).manifest.assets[0]; assert.equal(a.technical.status, 'partial', a.technical.reason); assert.equal(a.technical.ocr.status, 'failed'); assert.ok(evidence(a, 'preview')); assert.equal(a.technical.evidence.some(e => e.kind.startsWith('ocr-')), false);
      }
    } finally { writeFileSync(lockPath, original); sealCore(); }
    for (const relative of ['assets/ocr/tessdata/chi_sim.traineddata', 'ocr-dependencies.lock.json']) {
      const path = join(project, '.engine', relative), bytes = readFileSync(path), changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1; writeFileSync(path, changed);
      try { assert.match(control(['ocr-film', 'catalog', '--schema', 'ocr-map'], 1), /RUNTIME_CHANGED/); }
      finally { writeFileSync(path, bytes); }
    }
    verify(initialReceipt.catalogId);
  });

  await gate('OCR 实际离线沙箱、固定 env、原件/四证据/模型/另一片及后代边界', async () => {
    const external = join(scratch, 'ocr-unselected.txt'), escape = join(scratch, 'ocr-escape'); writeFileSync(external, 'fictional');
    const attempts = [`fs.readFileSync(${JSON.stringify(external)})`, `fs.readFileSync(${JSON.stringify(join(other, 'director.json'))})`, `fs.readFileSync(${JSON.stringify(join(core, 'SKILL.md'))})`,
      ...[join(project, initialAsset.source.fixedPath), join(project, initialReceipt.manifestPath), ...['ocr-raster', 'ocr-tsv', 'text', 'ocr-map'].map(kind => join(project, evidence(initialAsset, kind).path)), join(project, '.engine/assets/ocr/tessdata/eng.traineddata'), escape].map(path => `fs.writeFileSync(${JSON.stringify(path)},'x')`)];
    const probe = `const fs=require('node:fs');${attempts.map(denied).join(';')};`; let connections = 0; const server = createServer(socket => { connections++; socket.destroy(); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const code = `${probe}const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(probe)}],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);process.stdout.write(r.stdout);if(process.env.HOME||process.env.NODE_OPTIONS||process.env.TESSDATA_PREFIX||process.env.DYLD_LIBRARY_PATH||process.env.JBM_OCR_SECRET)process.exit(17);require('node:net').connect({host:'127.0.0.1',port:${server.address().port}}).on('connect',()=>process.exit(17)).on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('NETWORK_DENIED:'+e.code)});`;
      const launch = `const {runBoundCommand,importCommandOptions}=await import(${JSON.stringify(pathToFileURL(join(project, '.engine/workspace.mjs')).href)});process.env.JBM_OCR_SECRET='fictional';process.env.TESSDATA_PREFIX='fictional';process.env.DYLD_LIBRARY_PATH='fictional';process.exitCode=await runBoundCommand(${JSON.stringify(project)},[process.execPath,'-e',${JSON.stringify(code)}],importCommandOptions(['catalog','--schema','ocr-map']));`;
      const output = run(root, ['--input-type=module', '-e', launch]); assert.equal((output.match(/DENIED:/g) ?? []).length, attempts.length * 2 + 1); assert.equal(connections, 0); assert.match(output, /NETWORK_DENIED/); assert.equal(existsSync(escape), false);
    } finally { await new Promise(resolve => server.close(resolve)); }
    verify(initialReceipt.catalogId);
  });

  for (const signal of ['SIGTERM', 'SIGKILL']) await gate(`OCR 真实统一入口 ${signal} 中断与新 attempt 恢复`, async () => {
    setPolicy(); const source = join(scratch, `ocr interrupt ${signal}`); mkdirSync(source); for (let i = 0; i < 20; i++) writeFileSync(join(source, `image-${String(i).padStart(2, '0')}.png`), readFileSync(join(selected, 'renamed.data')));
    const imp = imported(source), before = readFileSync(join(project, 'assets/catalog.json')), runs = join(project, 'runs'), known = new Set(readdirSync(runs));
    const child = spawn(process.execPath, [join(core, 'scripts/video.mjs'), 'ocr-film', 'catalog', '--import', imp.importId], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; }); const closed = new Promise(resolve => child.once('close', (status, exitSignal) => resolve({ status, exitSignal })));
    try {
      let active, lastReceipt; const started = Date.now(), deadline = started + 60000;
      while (!active && Date.now() < deadline) {
        for (const name of readdirSync(runs).filter(n => n.startsWith('catalog-attempt-') && !known.has(n))) try { const r = json(join(runs, name, 'receipt.json')); lastReceipt = { attemptId: r.attemptId, phase: r.phase, status: r.status }; if (r.phase === 'inspecting' && r.status === 'running') active = r; } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!active && (child.exitCode !== null || child.signalCode !== null)) break;
        if (!active) await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(active, `OCR_INTERRUPT_NOT_ACTIVE:${signal}:${JSON.stringify({ elapsedMs: Date.now() - started, lastReceipt: lastReceipt ?? null, exitCode: child.exitCode, signal: child.signalCode })}\n${stdout}${stderr}`); if (signal === 'SIGKILL') process.kill(-child.pid, signal); else child.kill(signal); const result = await closed;
      if (signal === 'SIGTERM') { assert.equal(result.status, 1, stdout + stderr); assert.equal(JSON.parse(stdout).status, 'interrupted'); } else assert.equal(result.exitSignal, 'SIGKILL'); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before);
      assert.equal(catalog(['--import', imp.importId, '--path', 'image-00.png']).status, 'succeeded'); assert.equal(json(join(runs, active.attemptId, 'receipt.json')).status, 'interrupted'); assert.equal(existsSync(join(runs, 'catalog.lock')), false); verify(initialReceipt.catalogId);
    } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } await closed; }
  });
  return groups;
}
