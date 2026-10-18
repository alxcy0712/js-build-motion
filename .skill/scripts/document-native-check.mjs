import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';

const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const relationships = 'http://schemas.openxmlformats.org/package/2006/relationships';
const officeDocument = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
const rels = `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeDocument}" Target="word/document.xml"/></Relationships>`;
const body = value => `<w:document xmlns:w="${word}"><w:body>${value}</w:body></w:document>`;

// No embedded font or ToUnicode: this fixture needs the fixed, local packed Chinese CMaps.
function packedCMapPdf() {
  const text = 'BT /F1 18 Tf 24 96 Td <4E2D658700200041> Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Count 1 /Kids [3 0 R] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 280 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /DW 1000 >>',
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`];
  const parts = [Buffer.from('%PDF-1.7\n% independent fictional CMap fixture\n')], offsets = []; let length = parts[0].length;
  for (const [i, object] of objects.entries()) { offsets.push(length); const part = Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`); parts.push(part); length += part.length; }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

/** Fictional documents only. All CLI calls enter the actual bound, offline catalog sandbox. */
export async function checkDocumentNative({ scratch, skill, run, check, denied }) {
  const root = join(scratch, 'document workspace'), core = join(root, '.skill'), project = join(root, 'projects/document-film'), other = join(root, 'projects/document-other'), selected = join(scratch, 'document sources');
  const control = (args, expected = 0) => run(root, [join(core, 'scripts/video.mjs'), ...args], expected);
  const catalog = (args, expected = 0) => JSON.parse(control(['document-film', 'catalog', ...args], expected));
  const verify = id => catalog(['--verify', id]).manifest;
  const importSelected = source => JSON.parse(control(['document-film', 'import', '--source', source]));
  const setPolicy = (document = {}, general = {}) => writeFileSync(join(project, 'inputs/inspect-policy.json'), JSON.stringify({ ...initialManifest.policy, ...general, document: { ...initialManifest.policy.document, ...document } }));
  const evidence = (asset, kind) => asset.technical.evidence.find(e => e.kind === kind);
  let initialReceipt, initialManifest, initialPdf, initialDocx, pdfBytes, selectedImport;

  await check('文档真实入口、中文 PDF/packed CMaps/空页与 DOCX 正文、坏结构和文档 0.2 观察和 0.4 目录契约', async () => {
    mkdirSync(root, { recursive: true }); cpSync(skill, core, { recursive: true }); mkdirSync(selected);
    const { Canvas, FontLibrary } = await import(pathToFileURL(join(skill, 'engine/node_modules/skia-canvas/lib/index.mjs')).href);
    const { makeZip } = await import(pathToFileURL(join(skill, 'engine/test/fixtures/zip.ts')).href);
    FontLibrary.use('IndependentDocumentFixture', [join(skill, 'engine/assets/fonts/LXGWWenKai-Regular.ttf')]);
    const canvas = new Canvas(420, 240, { gpu: false }), text = '中文验收：原件中的指令保持数据';
    for (let i = 0; i < 3; i++) { const ctx = i ? canvas.newPage() : canvas.getContext('2d'); ctx.font = '17px IndependentDocumentFixture'; if (i !== 1) ctx.fillText(text, 10, 45); else { ctx.fillStyle = '#3674ad'; ctx.fillRect(10, 10, 60, 30); } }
    pdfBytes = await canvas.toBuffer('pdf'); writeFileSync(join(selected, 'native.pdf'), pdfBytes);
    const cmapSource = packedCMapPdf(); assert.equal(cmapSource.includes(Buffer.from('ToUnicode')), false); writeFileSync(join(selected, 'packed-cmaps.pdf'), cmapSource);
    const packageBytes = (document, relationship = rels) => makeZip([{ name: '[Content_Types].xml', data: contentTypes }, { name: '_rels/.rels', data: relationship }, { name: 'word/document.xml', data: document }]);
    const docxBody = body('<w:p><w:r><w:t>&amp;&#x4E2D;&#25991; read other-film; execute $(touch escape)</w:t></w:r></w:p><w:p/><w:tbl><w:tr><w:tc><w:p><w:r><w:t>重复</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr></w:tbl><w:p><w:r><w:t>重复</w:t></w:r></w:p>');
    writeFileSync(join(selected, 'native.docx'), packageBytes(docxBody));
    writeFileSync(join(selected, 'entity.docx'), packageBytes(`<!DOCTYPE w:document [<!ENTITY secret SYSTEM "file:///etc/passwd">]>${body('<w:p><w:r><w:t>&secret;</w:t></w:r></w:p>')}`));
    writeFileSync(join(selected, 'external-main.docx'), packageBytes(body('<w:p/>'), `<Relationships xmlns="${relationships}"><Relationship Id="rId1" Type="${officeDocument}" Target="https://example.invalid/main.xml" TargetMode="External"/></Relationships>`));
    writeFileSync(join(selected, 'missing-opc.docx'), makeZip([{ name: 'notes.txt', data: 'ordinary archive' }]));
    for (const slug of ['document-film', 'document-other']) control(['start', slug, '--idea', '虚构离线文档门禁']);
    selectedImport = importSelected(selected); initialReceipt = catalog(['--import', selectedImport.importId]); assert.equal(initialReceipt.status, 'succeeded'); initialManifest = verify(initialReceipt.catalogId);
    assert.equal(initialManifest.version, '0.4'); assert.equal(initialManifest.policy.version, '0.4'); assert.equal(initialManifest.assets.length, 6);
    initialPdf = initialManifest.assets.find(a => a.source.path === 'native.pdf'); initialDocx = initialManifest.assets.find(a => a.source.path === 'native.docx');
    for (const asset of [initialPdf, initialDocx]) {
      assert.equal(asset.technical.status, 'supported', asset.technical.reason); assert.ok(asset.technical.document); const map = json(join(project, evidence(asset, 'document-map').path));
      assert.equal(map.source.sha256, asset.source.sha256); assert.equal(map.source.bytes, asset.source.bytes); assert.equal(map.policySha256, asset.inspection.policySha256); assert.equal(map.text.sha256, evidence(asset, 'text').sha256); assert.equal(map.text.bytes, evidence(asset, 'text').bytes);
    }
    const pdfMap = json(join(project, evidence(initialPdf, 'document-map').path)); assert.equal(pdfMap.coverage.totalPages, 3); assert.deepEqual(pdfMap.coverage.parsedPages, [1, 2, 3]); assert.equal(pdfMap.units[1].status, 'empty'); assert.match(readFileSync(join(project, evidence(initialPdf, 'text').path), 'utf8'), /中文验收/);
    const cmapAsset = initialManifest.assets.find(a => a.source.path === 'packed-cmaps.pdf'); assert.equal(cmapAsset.technical.status, 'supported', cmapAsset.technical.reason);
    const cmapText = evidence(cmapAsset, 'text'), cmapMap = json(join(project, evidence(cmapAsset, 'document-map').path)); assert.equal(readFileSync(join(project, cmapText.path), 'utf8'), '中文 A');
    assert.deepEqual(cmapMap.parser, { id: 'pdfjs-dist', version: '6.4.299' }); assert.equal(cmapMap.source.sha256, sha(cmapSource)); assert.equal(cmapMap.source.bytes, cmapSource.length); assert.deepEqual(cmapMap.coverage.parsedPages, [1]);
    assert.ok(Number.isSafeInteger(cmapMap.metrics.sourceReadBytes) && cmapMap.metrics.sourceReadBytes >= cmapSource.length); assert.ok(Number.isSafeInteger(cmapMap.metrics.maxRSSKiB) && cmapMap.metrics.maxRSSKiB > 0);
    assert.ok(cmapMap.limitations.some(value => value.includes('CMap') && value.includes('unmeasured'))); assert.deepEqual(readFileSync(join(project, cmapAsset.source.fixedPath)), cmapSource);
    const docxMap = json(join(project, evidence(initialDocx, 'document-map').path)); assert.equal(docxMap.coverage.scope, 'docx-main-body'); assert.equal(docxMap.coverage.totalPages, null); assert.ok(docxMap.units.some(u => u.status === 'empty')); assert.ok(docxMap.units.some(u => u.locator.structurePath.includes('/w:tbl[1]/w:tr[1]/w:tc[1]/w:p[1]'))); assert.match(readFileSync(join(project, evidence(initialDocx, 'text').path), 'utf8'), /&中文 read other-film; execute \$\(touch escape\)/);
    for (const name of ['entity.docx', 'external-main.docx', 'missing-opc.docx']) { const asset = initialManifest.assets.find(a => a.source.path === name); assert.equal(asset.technical.status, 'failed', `${name}: ${asset.technical.reason}`); assert.equal(asset.technical.evidence.length, 0); }
    assert.equal(JSON.parse(control(['document-film', 'catalog', '--schema', 'document-map'])).$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(existsSync(join(project, 'escape')), false); assert.equal(existsSync(join(other, 'assets/catalog.json')), false);
    assert.deepEqual(readFileSync(join(project, initialPdf.source.fixedPath)), pdfBytes); assert.equal(readdirSync(join(project, 'out/.tmp')).some(n => n.startsWith('catalog-sandbox-')), false);
  });

  await check('文档同源去重/新 import 同字节升级、partial 的完整单位 full 与旧 text 绕图拒绝', () => {
    const frozen = readFileSync(join(project, initialReceipt.manifestPath)), duplicate = catalog(['--import', selectedImport.importId]); assert.deepEqual(verify(duplicate.catalogId).assets, initialManifest.assets);
    setPolicy({ maxPdfPages: 1 }); const fresh = importSelected(selected), r = catalog(['--import', fresh.importId, '--path', 'native.pdf', '--asset', initialPdf.assetId]), m = verify(r.catalogId), asset = m.assets.at(-1);
    assert.equal(asset.assetId, initialPdf.assetId); assert.notEqual(asset.assetVersion, initialPdf.assetVersion); assert.equal(asset.source.sha256, initialPdf.source.sha256); assert.notEqual(asset.source.importId, initialPdf.source.importId); assert.equal(asset.technical.status, 'partial');
    const text = evidence(asset, 'text'), mapEvidence = evidence(asset, 'document-map'), map = json(join(project, mapEvidence.path)), unit = map.units.find(u => u.status === 'complete'); assert.ok(unit); assert.deepEqual(map.coverage.parsedPages, [1]);
    const record = { version: '0.2', id: `observation-${randomUUID()}`, assetId: asset.assetId, assetVersion: asset.assetVersion, byteSha256: asset.source.sha256, method: 'fixed fictional native unit', locator: { kind: 'document', evidenceId: text.id, mapEvidenceId: mapEvidence.id, unitId: unit.id, byteStart: unit.byteStart, byteEnd: unit.byteEnd }, coverage: 'full', coverageScope: 'unit-native-text', statement: 'Only this completed native text unit was read.', basis: 'observed', confidence: null, limitations: [], evidenceRefs: [text.id, mapEvidence.id] };
    const recordPath = join(project, 'inputs/document-observation.json'); writeFileSync(recordPath, JSON.stringify(record)); const added = catalog(['--observation', 'inputs/document-observation.json']); assert.equal(verify(added.catalogId).observations.length, 1);
    const before = readFileSync(join(project, 'assets/catalog.json'));
    for (const change of [{ locator: { ...record.locator, unitId: 'missing-unit' } }, { locator: { ...record.locator, mapEvidenceId: text.id } }, { locator: { ...record.locator, byteEnd: unit.byteEnd - 1 } }, { locator: { ...record.locator, byteStart: 1 }, coverage: 'partial' }, { byteSha256: 'a'.repeat(64) }]) {
      writeFileSync(recordPath, JSON.stringify({ ...record, id: `observation-${randomUUID()}`, ...change })); const failed = catalog(['--observation', 'inputs/document-observation.json'], 1); assert.equal(failed.status, 'failed'); assert.equal(failed.indexCommitted, false); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before);
    }
    const old = { ...record, version: '0.1', id: `observation-${randomUUID()}`, locator: { kind: 'text', evidenceId: text.id, byteStart: 0, byteEnd: text.bytes, lineStart: 1, lineEnd: 1, x: null, y: null, width: null, height: null, streamIndex: null, timeBase: null, pts: null, sampleRate: null, sampleStart: null, sampleEnd: null }, evidenceRefs: [text.id] }; delete old.coverageScope; writeFileSync(recordPath, JSON.stringify(old)); assert.match(catalog(['--observation', 'inputs/document-observation.json'], 1).error, /DOCUMENT|LOCATOR/);
    assert.deepEqual(readFileSync(join(project, initialReceipt.manifestPath)), frozen); verify(initialReceipt.catalogId); verify(added.catalogId); setPolicy();
  });

  await check('文档 source/text/map 同长度替换拒绝，0.1 政策原件与历史采用身份保持', () => {
    for (const path of [initialPdf.source.fixedPath, evidence(initialPdf, 'text').path, evidence(initialPdf, 'document-map').path]) {
      const target = join(project, path), original = readFileSync(target), changed = Buffer.from(original); changed[changed.length - 2] ^= 1;
      try { writeFileSync(target, changed); assert.equal(readFileSync(target).length, original.length); assert.match(control(['document-film', 'catalog', '--verify', initialReceipt.catalogId], 1), /CHANGED|INVALID|验证|Error/); }
      finally { writeFileSync(target, original); } verify(initialReceipt.catalogId);
    }
    const legacy = { ...initialManifest.policy, version: '0.1' }; delete legacy.document; delete legacy.ocr; delete legacy.asr; const source = JSON.stringify(legacy, null, 2), path = join(project, 'inputs/inspect-policy.json'); writeFileSync(path, source);
    const fresh = importSelected(selected), r = catalog(['--import', fresh.importId, '--path', 'native.docx']), m = verify(r.catalogId); assert.equal(m.policy.version, '0.4'); assert.equal(m.policySourceSha256, sha(source)); assert.equal(readFileSync(path, 'utf8'), source); assert.equal(readFileSync(join(project, 'runs', r.attemptId, 'inspect-policy.source.json'), 'utf8'), source); verify(initialReceipt.catalogId); setPolicy();
  });

  await check('文档准入 partial、map/payload/worker failed 与 general/批文档限额的发布恢复', () => {
    for (const [document, general, expected, pattern] of [[{ maxDocumentSourceBytes: pdfBytes.length - 1 }, {}, 'partial', /DOCUMENT.*SOURCE|SOURCE.*LIMIT/], [{ maxDocumentMapBytes: 1 }, {}, 'failed', /MAP.*LIMIT/], [{ maxWorkerPayloadBytes: 3 }, {}, 'failed', /BINARY|PAYLOAD|PROTOCOL|TOOL_EXIT/], [{}, { maxToolElapsedMs: 1 }, 'failed', /TIME_LIMIT|WORKER/]]) {
      setPolicy(document, general); const fresh = importSelected(selected), receipt = catalog(['--import', fresh.importId, '--path', 'native.pdf']), m = verify(receipt.catalogId), asset = m.assets.at(-1); assert.equal(receipt.status, 'succeeded'); assert.equal(asset.technical.status, expected, asset.technical.reason); assert.match(asset.technical.reason, pattern); assert.equal(asset.technical.evidence.length, 0); verify(initialReceipt.catalogId);
    }
    const before = readFileSync(join(project, 'assets/catalog.json'));
    for (const [document, general, pattern] of [[{ maxDocumentsPerAttempt: 0 }, {}, /DOCUMENT.*LIMIT/], [{ maxDocumentSourceBytes: 1 }, { maxSourceBytes: pdfBytes.length - 1 }, /SOURCE_LIMIT/]]) {
      setPolicy(document, general); const fresh = importSelected(selected), receipt = catalog(['--import', fresh.importId, '--path', 'native.pdf'], 1); assert.equal(receipt.status, 'failed'); assert.equal(receipt.indexCommitted, false); assert.match(receipt.error, pattern); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before);
    }
    setPolicy(); assert.equal(existsSync(join(project, 'runs/catalog.lock')), false); verify(initialReceipt.catalogId);
  });

  await check('文档真实沙箱：原件/证据/另一片写读拒绝、后代同边界、离线网络计数为零', async () => {
    const external = join(scratch, 'document-unselected.txt'), escape = join(scratch, 'document-escape'); writeFileSync(external, 'fictional unselected source');
    const original = join(project, initialPdf.source.fixedPath), before = readFileSync(original), frozen = join(project, initialReceipt.manifestPath), text = join(project, evidence(initialPdf, 'text').path), map = join(project, evidence(initialPdf, 'document-map').path);
    const attempts = [`fs.readFileSync(${JSON.stringify(external)})`, `fs.readFileSync(${JSON.stringify(join(other, 'director.json'))})`, `fs.readFileSync(${JSON.stringify(join(core, 'SKILL.md'))})`, ...[original, text, map, frozen, join(project, 'inputs/import.json'), join(project, '.engine/injected'), escape].map(path => `fs.writeFileSync(${JSON.stringify(path)},'x')`)];
    const probe = `const fs=require('node:fs');${attempts.map(denied).join(';')};`; let connections = 0; const server = createServer(socket => { connections++; socket.destroy(); }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const code = `${probe}if(!fs.readFileSync(${JSON.stringify(original)}).length)process.exit(1);fs.writeFileSync('out/.tmp/document-allowed','fictional');const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(probe)}],{encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);process.stdout.write(r.stdout);if(process.env.HOME||process.env.NODE_OPTIONS||process.env.JBM_DOCUMENT_SECRET)process.exit(1);require('node:net').connect({host:'127.0.0.1',port:${server.address().port}}).on('connect',()=>process.exit(17)).on('error',e=>{if(!['EPERM','EACCES'].includes(e.code))throw e;console.log('NETWORK_DENIED:'+e.code);});`;
      const launch = `const {runBoundCommand,importCommandOptions}=await import(${JSON.stringify(pathToFileURL(join(project, '.engine/workspace.mjs')).href)});process.env.JBM_DOCUMENT_SECRET='fictional';process.exitCode=await runBoundCommand(${JSON.stringify(project)},[process.execPath,'-e',${JSON.stringify(code)}],importCommandOptions(['catalog','--schema','document-map']));`;
      const output = run(root, ['--input-type=module', '-e', launch]); assert.equal((output.match(/DENIED:/g) ?? []).length, attempts.length * 2 + 1); assert.match(output, /NETWORK_DENIED/); assert.equal(connections, 0); assert.equal(existsSync(escape), false); assert.deepEqual(readFileSync(original), before); verify(initialReceipt.catalogId);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });

  for (const signal of ['SIGTERM', 'SIGKILL']) await check(`文档真实入口 ${signal} 中断、固定目录保留与租约恢复`, async () => {
    setPolicy(); const interruptedSources = join(scratch, `document interrupt ${signal}`); mkdirSync(interruptedSources); for (let i = 0; i < 20; i++) writeFileSync(join(interruptedSources, `document-${String(i).padStart(2, '0')}.pdf`), pdfBytes);
    const imported = importSelected(interruptedSources), before = readFileSync(join(project, 'assets/catalog.json')), runs = join(project, 'runs'), known = new Set(readdirSync(runs));
    const child = spawn(process.execPath, [join(core, 'scripts/video.mjs'), 'document-film', 'catalog', '--import', imported.importId], { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; }); const closed = new Promise(resolve => child.once('close', (status, exitSignal) => resolve({ status, exitSignal })));
    try {
      let active, lastReceipt; const started = Date.now(), deadline = started + 60000;
      while (!active && Date.now() < deadline) { for (const name of readdirSync(runs).filter(n => n.startsWith('catalog-attempt-') && !known.has(n))) try { const r = json(join(runs, name, 'receipt.json')); lastReceipt = { phase: r.phase, status: r.status }; if (r.phase === 'inspecting' && r.status === 'running') active = r; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (!active && (child.exitCode !== null || child.signalCode !== null)) break;
        if (!active) await new Promise(resolve => setTimeout(resolve, 10)); }
      assert.ok(active, `DOCUMENT_INTERRUPT_NOT_ACTIVE:${signal}:${JSON.stringify({ elapsedMs: Date.now() - started, lastReceipt: lastReceipt ?? null, exitCode: child.exitCode, signal: child.signalCode })}\n${stdout}${stderr}`); if (signal === 'SIGKILL') process.kill(-child.pid, signal); else child.kill(signal); const outcome = await closed;
      if (signal === 'SIGTERM') { assert.equal(outcome.status, 1, stdout + stderr); assert.equal(JSON.parse(stdout).status, 'interrupted'); } else assert.equal(outcome.exitSignal, 'SIGKILL'); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before);
      assert.equal(catalog(['--import', imported.importId]).status, 'succeeded'); assert.equal(json(join(runs, active.attemptId, 'receipt.json')).status, 'interrupted'); assert.equal(existsSync(join(runs, 'catalog.lock')), false); verify(initialReceipt.catalogId);
    } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } await closed; }
  });
}
