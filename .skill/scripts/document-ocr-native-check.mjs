import assert from 'node:assert/strict';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const sha = b => createHash('sha256').update(b).digest('hex'), json = p => JSON.parse(readFileSync(p, 'utf8'));
const save = (p, value) => writeFileSync(p, JSON.stringify(value, null, 2) + '\n'), wait = ms => new Promise(r => setTimeout(r, ms));
function scanPdf(rgb, width, height, external = false) {
  const image = deflateSync(rgb), content = Buffer.from(`q ${width} 0 0 ${height} 0 0 cm /Im Do Q`);
  const stream = (dictionary, data) => Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]);
  const objects = [Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'), Buffer.from('<< /Type /Pages /Count 1 /Kids [3 0 R] >>'),
    Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im 4 0 R >> >> /Contents 5 0 R >>`),
    stream(`/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode${external ? ' /#46 (external.bin)' : ''}`, image), stream('', content)];
  const parts = [Buffer.from('%PDF-1.7\n% fictional independent scan fixture\n')], offsets = []; let bytes = parts[0].length;
  for (const [i, obj] of objects.entries()) { offsets.push(bytes); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), obj, Buffer.from('\nendobj\n')]); parts.push(part); bytes += part.length; }
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${bytes}\n%%EOF\n`)); return Buffer.concat(parts);
}
function imageDocx(makeZip, png, badOrphan = false) {
  const base = 'http://schemas.openxmlformats.org/', office = base + 'officeDocument/2006/relationships', word = base + 'wordprocessingml/2006/main';
  const drawing = '<w:drawing><wp:inline><a:graphic><a:graphicData uri="' + base + 'drawingml/2006/picture"><pic:pic><pic:blipFill><a:blip r:embed="image1"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
  const doc = `<w:document xmlns:w="${word}" xmlns:r="${office}" xmlns:wp="${base}drawingml/2006/wordprocessingDrawing" xmlns:a="${base}drawingml/2006/main" xmlns:pic="${base}drawingml/2006/picture"><w:body><w:p><w:r><w:t>正文</w:t>${drawing}</w:r></w:p><w:p><w:r>${drawing}</w:r></w:p></w:body></w:document>`;
  return makeZip([{ name: '[Content_Types].xml', data: `<Types xmlns="${base}package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Default Extension="png" ContentType="image/png"/></Types>` },
    { name: '_rels/.rels', data: `<Relationships xmlns="${base}package/2006/relationships"><Relationship Id="main" Type="${office}/officeDocument" Target="word/document.xml"/></Relationships>` },
    { name: 'word/document.xml', data: doc }, { name: 'word/_rels/document.xml.rels', data: `<Relationships xmlns="${base}package/2006/relationships"><Relationship Id="image1" Type="${office}/image" Target="media/image.png"/></Relationships>` },
    { name: 'word/media/image.png', data: png }, ...(badOrphan ? [{ name: 'word/media/orphan.png', data: png, crc: 0 }] : [])]);
}

/** Fixed original-source pixel oracles through the real offline catalog entry. */
export async function checkDocumentOcrNative({ scratch, skill, check }) {
  const root = join(scratch, 'document OCR workspace'), core = join(root, '.skill'), project = join(root, 'projects/document-ocr-film'), selected = join(scratch, 'document OCR sources');
  const signalBaseline = join(scratch, 'document OCR signal baseline');
  const records = join(dirname(scratch), 'document-ocr-native-evidence', randomUUID()); mkdirSync(records, { recursive: true }); mkdirSync(root); mkdirSync(selected);
  const packageId = json(join(skill, 'manifest.json')).packageId, groups = [], host = { node: process.version, platform: process.platform, arch: process.arch };
  save(join(records, 'identity.json'), { packageId, host, scope: ['selected-pdf-page-pixels', 'selected-docx-embedded-source-pixels'], accuracy: 'unmeasured', crossHostPixels: 'unmeasured', hardRSS: 'unmeasured' });
  let ordinal = 0; const log = value => appendFileSync(join(records, 'commands.jsonl'), JSON.stringify(value) + '\n');
  const collect = (cwd, argv, expected = 0) => {
    const id = `command-${String(++ordinal).padStart(4, '0')}`, start = Date.now();
    const result = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: 210000, maxBuffer: 32 * 1024 * 1024, detached: true, killSignal: 'SIGKILL' });
    if (result.pid) try { process.kill(-result.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    const stdout = result.stdout ?? '', stderr = result.stderr ?? ''; writeFileSync(join(records, id + '.stdout.log'), stdout); writeFileSync(join(records, id + '.stderr.log'), stderr);
    log({ id, packageId, host, cwd, executable: process.execPath, argv, exitCode: result.status, signal: result.signal, elapsedMs: Date.now() - start,
      stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutSha256: sha(stdout), stderrSha256: sha(stderr), status: !result.error && result.status === expected ? 'passed' : 'failed', error: result.error?.message ?? null });
    if (result.error) throw result.error; assert.equal(result.status, expected, `${argv.join(' ')}\n${stderr}\n${stdout}`); return stdout;
  };
  const control = (argv, expected = 0) => collect(root, [join(core, 'scripts/video.mjs'), ...argv], expected);
  const catalog = (argv, expected = 0) => JSON.parse(control(['document-ocr-film', 'catalog', ...argv], expected));
  const verify = id => catalog(['--verify', id]).manifest, importSource = source => JSON.parse(control(['document-ocr-film', 'import', '--source', source]));
  const gate = async (name, action) => { const start = Date.now(); try { await check(name, action); groups.push(name); log({ kind: 'gate', packageId, name, status: 'passed', elapsedMs: Date.now() - start }); }
    catch (e) { log({ kind: 'gate', packageId, name, status: 'failed', error: String(e.stack ?? e) }); throw e; } };
  const evidence = (asset, id) => asset.technical.evidence.find(e => e.id === id), unitMap = (asset, ordinal = 1) => {
    const selection = json(join(project, evidence(asset, asset.technical.documentOcr.mapEvidenceId).path)), unit = selection.units.find(u => u.ordinal === ordinal);
    return json(join(project, evidence(asset, unit.mapEvidenceId).path));
  };
  let policy, defaults, first, manifest, imported, png, pdf, ppm, domain;
  const setPolicy = patch => save(join(project, 'inputs/inspect-policy.json'), { ...policy, ...patch });
  try {
    await gate('Document OCR 真实双语扫描PDF与DOCX同part双occurrence的全像素oracle', async () => {
      cpSync(skill, core, { recursive: true }); const { Canvas, FontLibrary } = await import(pathToFileURL(join(core, 'engine/node_modules/skia-canvas/lib/index.mjs')).href);
      const { makeZip } = await import(pathToFileURL(join(core, 'engine/test/fixtures/zip.ts')).href);
      FontLibrary.use('DocumentOcrNativeFixture', [join(core, 'engine/assets/fonts/LXGWWenKai-Regular.ttf')]);
      const width = 1001, height = 301, canvas = new Canvas(width, height, { gpu: false }), ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#000'; ctx.font = '72px DocumentOcrNativeFixture'; ctx.fillText('中文 ALPHA 123', 45, 155);
      const rgba = ctx.getImageData(0, 0, width, height).data, rgb = Buffer.alloc(width * height * 3); for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) rgb[i * 3 + c] = rgba[i * 4 + c];
      ppm = Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), rgb]); png = await canvas.toBuffer('png'); pdf = scanPdf(rgb, width, height);
      writeFileSync(join(selected, 'scan.pdf'), pdf); writeFileSync(join(selected, 'embedded.docx'), imageDocx(makeZip, png)); writeFileSync(join(records, 'source-oracle.ppm'), ppm);
      writeFileSync(join(records, 'image.png'), png); writeFileSync(join(records, 'scan.pdf'), pdf); writeFileSync(join(records, 'embedded.docx'), readFileSync(join(selected, 'embedded.docx')));
      control(['start', 'document-ocr-film', '--idea', '虚构扫描文档OCR宿主验收']); mkdirSync(join(project, 'inputs'), { recursive: true }); domain = await import(pathToFileURL(join(core, 'engine/src/project/catalog.ts')).href); defaults = domain.DEFAULT_INSPECT_POLICY;
      policy = { ...domain.INSPECT_POLICY_06, documentOcr: { ...domain.INSPECT_POLICY_06.documentOcr, enabled: true, dpi: 72, pdfPages: [1], docxImages: [1, 2] } }; setPolicy({}); imported = importSource(selected);
      first = catalog(['--import', imported.importId]); assert.equal(first.version, '0.6'); manifest = verify(first.catalogId); assert.equal(manifest.assets.length, 2);
      for (const asset of manifest.assets) {
        const d = asset.technical.documentOcr; assert.equal(d.status, 'completed', d.reason); assert.equal(d.completedUnits, asset.technical.format === 'pdf' ? 1 : 2);
        for (const n of d.selection) { const map = unitMap(asset, n); assert.deepEqual(readFileSync(join(project, evidence(asset, map.raster.evidenceId).path)), ppm);
          const text = readFileSync(join(project, evidence(asset, map.text.evidenceId).path), 'utf8'); assert.match(text, /ALPHA/); assert.match(text, /123/); assert.match(text, /中/);
          assert.ok(map.regions.length >= 3); assert.equal(map.source.sha256, asset.source.sha256); assert.equal(map.locator.kind, asset.technical.format === 'pdf' ? 'pdf-page' : 'docx-image');
          log({ kind: 'pixel-oracle', format: asset.technical.format, ordinal: n, sourceSha256: asset.source.sha256, rasterSha256: sha(ppm), text, locator: map.locator }); }
      }
      mkdirSync(signalBaseline); for (const name of ['inputs', 'assets', 'runs', 'out']) cpSync(join(project, name), join(signalBaseline, name), { recursive: true });
      const docx = manifest.assets.find(a => a.technical.format === 'docx'); assert.notEqual(unitMap(docx, 1).locator.structurePath, unitMap(docx, 2).locator.structurePath); assert.equal(unitMap(docx, 1).locator.embeddedSha256, unitMap(docx, 2).locator.embeddedSha256);
    });
    await gate('Document OCR 0.6词区域观察与同源政策修订、disabled空选择原生范围', () => {
      const asset = manifest.assets.find(a => a.technical.format === 'pdf'), map = unitMap(asset), region = map.regions[0], mapItem = asset.technical.evidence.find(e => e.kind === 'document-ocr-map');
      const record = { version: '0.6', id: `observation-${randomUUID()}`, assetId: asset.assetId, assetVersion: asset.assetVersion, byteSha256: asset.source.sha256, method: 'fixed fictional OCR word reading',
        locator: { kind: 'document-ocr', evidenceId: map.text.evidenceId, mapEvidenceId: mapItem.id, selectionMapEvidenceId: asset.technical.documentOcr.mapEvidenceId, rasterEvidenceId: map.raster.evidenceId, unitId: map.unitId, regionId: region.id, byteStart: region.byteStart, byteEnd: region.byteEnd },
        coverage: 'full', coverageScope: 'region-ocr-text', statement: 'Read this selected OCR word.', basis: 'observed', confidence: null, limitations: ['OCR accuracy unverified.'], evidenceRefs: [map.text.evidenceId, mapItem.id, asset.technical.documentOcr.mapEvidenceId, map.raster.evidenceId] };
      save(join(project, 'inputs/ocr-observation.json'), record); const added = catalog(['--observation', 'inputs/ocr-observation.json']); assert.equal(verify(added.catalogId).observations.length, 1);
      for (const patch of [{ enabled: false }, { pdfPages: [] }]) { setPolicy({ documentOcr: { ...policy.documentOcr, ...patch } }); const r = catalog(['--import', imported.importId, '--path', 'scan.pdf']), a = verify(r.catalogId).assets.at(-1);
        assert.equal(a.assetId, asset.assetId); assert.notEqual(a.assetVersion, asset.assetVersion); assert.equal(a.technical.documentOcr.status, patch.enabled === false ? 'disabled' : 'skipped'); assert.equal(a.technical.documentOcr.mapEvidenceId, null); assert.equal(a.technical.evidence.filter(e => e.kind.startsWith('document-ocr-')).length, 0); }
      setPolicy({}); verify(first.catalogId);
    });
    await gate('Document OCR PDF外部stream与DOCX未选part坏CRC的真实闭包拒绝', async () => {
      const { makeZip } = await import(pathToFileURL(join(core, 'engine/test/fixtures/zip.ts')).href), bad = join(scratch, 'document OCR malformed'); mkdirSync(bad);
      const header = ppm.indexOf(Buffer.from('\n255\n')) + 5; writeFileSync(join(bad, 'external.pdf'), scanPdf(ppm.subarray(header), 1001, 301, true)); writeFileSync(join(bad, 'bad-crc.docx'), imageDocx(makeZip, png, true));
      const input = importSource(bad), r = catalog(['--import', input.importId]), m = verify(r.catalogId);
      for (const a of m.assets.filter(a => a.inspection.catalogId === r.catalogId)) { assert.equal(a.technical.documentOcr.status, 'failed'); assert.equal(a.technical.documentOcr.completedUnits, 0); assert.equal(a.technical.evidence.filter(e => ['document-ocr-raster', 'document-ocr-tsv', 'document-ocr-text', 'document-ocr-map'].includes(e.kind)).length, 0); }
      verify(first.catalogId);
    });
    await gate('Document OCR 全批单位像素与派生配额保持已提交索引', () => {
      const before = readFileSync(join(project, 'assets/catalog.json'));
      for (const patch of [{ documentOcr: { ...policy.documentOcr, maxUnitsPerAttempt: 1 } }, { documentOcr: { ...policy.documentOcr, maxTotalPixels: 1 } }, { maxDerivedBytes: 1 }]) {
        setPolicy(patch); const fresh = importSource(selected), r = catalog(['--import', fresh.importId], 1); assert.equal(r.status, 'failed'); assert.equal(r.indexCommitted, false); assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before);
      } setPolicy({}); verify(first.catalogId);
    });
    await gate('Document OCR 协调改像素及map/manifest/receipt/index摘要仍由原件oracle拒绝', () => {
      for (const asset of manifest.assets) {
        const map = unitMap(asset), raster = evidence(asset, map.raster.evidenceId), mapItem = asset.technical.evidence.find(e => e.kind === 'document-ocr-map' && json(join(project, e.path)).unitId === map.unitId);
        const paths = [join(project, raster.path), join(project, mapItem.path), join(project, first.manifestPath), join(project, 'runs', first.attemptId, 'receipt.json'), join(project, 'assets/catalog.json')], saved = paths.map(p => readFileSync(p));
        try { const changed = Buffer.from(saved[0]); changed[changed.length - 1] ^= 1; writeFileSync(paths[0], changed); map.raster.sha256 = sha(changed); save(paths[1], map);
          const m = json(paths[2]), r = json(paths[3]), index = json(paths[4]); const replace = assets => { for (const a of assets) if (a.assetVersion === asset.assetVersion) for (const e of a.technical.evidence) {
            if (e.id === raster.id) e.sha256 = sha(changed); if (e.id === mapItem.id) { const b = readFileSync(paths[1]); e.bytes = b.length; e.sha256 = sha(b); } } };
          replace(m.assets); replace(r.assets); save(paths[2], m); r.manifestSha256 = sha(readFileSync(paths[2])); save(paths[3], r); index.catalogs.find(c => c.catalogId === first.catalogId).manifestSha256 = r.manifestSha256; save(paths[4], index);
          control(['document-ocr-film', 'catalog', '--verify', first.catalogId], 1);
        } finally { paths.forEach((p, i) => writeFileSync(p, saved[i])); } verify(first.catalogId);
      }
    });
    await gate('Document OCR 移根像素重放与旧0.4政策继承0.6证据', () => {
      const moved = join(scratch, 'document OCR relocated'); mkdirSync(join(moved, 'projects'), { recursive: true }); cpSync(core, join(moved, '.skill'), { recursive: true }); cpSync(project, join(moved, 'projects/document-ocr-film'), { recursive: true });
      collect(moved, [join(moved, '.skill/scripts/video.mjs'), 'document-ocr-film', 'catalog', '--verify', first.catalogId]); save(join(project, 'inputs/inspect-policy.json'), defaults);
      const r = catalog(['--import', imported.importId, '--path', 'scan.pdf']); assert.equal(r.version, '0.6'); const m = verify(r.catalogId); assert.equal(m.policy.version, '0.4'); assert.ok(m.assets.some(a => a.technical.documentOcr?.status === 'completed')); verify(first.catalogId); setPolicy({});
    });
    cpSync(project, join(records, 'history-project'), { recursive: true, filter: p => !p.startsWith(join(project, '.engine')) });
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) await gate(`Document OCR 真实worker期间${signal}与耐久恢复`, async () => {
      for (const name of ['inputs', 'assets', 'runs', 'out']) { rmSync(join(project, name), { recursive: true }); cpSync(join(signalBaseline, name), join(project, name), { recursive: true }); }
      const fresh = importSource(selected), before = readFileSync(join(project, 'assets/catalog.json')), runs = join(project, 'runs'), known = new Set(readdirSync(runs));
      const argv = [join(core, 'scripts/video.mjs'), 'document-ocr-film', 'catalog', '--import', fresh.importId, '--path', 'scan.pdf'], child = spawn(process.execPath, argv, { cwd: root, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; }); let closeResult; const closed = new Promise(r => child.once('close', (exitCode, exitSignal) => { closeResult = { exitCode, exitSignal }; r(closeResult); }));
      let active, lastReceipt, workerPid, lastPsRows = []; try { const deadline = Date.now() + policy.maxElapsedMs;
        while ((!active || !workerPid) && Date.now() < deadline) {
          for (const n of readdirSync(runs).filter(n => n.startsWith('catalog-attempt-') && !known.has(n))) try { const r = json(join(runs, n, 'receipt.json')); lastReceipt = r; if (r.status === 'running' && r.phase === 'inspecting') active = r; } catch (e) { if (e.code !== 'ENOENT') throw e; }
          if (active) { const ps = spawnSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5000, maxBuffer: 8388608 }); if (ps.status !== 0) throw Error('DOCUMENT_OCR_PROCESS_AUDIT_FAILED');
            const rows = ps.stdout.split('\n').map(s => s.trim()).filter(s => s.includes(join(project, '.engine/src/adapters/document-raster-worker.ts')) && s.includes(active.attemptId));
            lastPsRows = rows; if (rows.length) { workerPid = Number(rows[0].match(/^\d+/)[0]); log({ kind: 'active-worker', packageId, signal, attemptId: active.attemptId, workerPid, rows }); } }
          if (closeResult) throw Error('DOCUMENT_OCR_CHILD_CLOSED_BEFORE_WORKER: ' + JSON.stringify({ closeResult, lastReceipt, stdout, stderr }));
          if (!active || !workerPid) await wait(10);
        }
        assert.ok(active && workerPid, JSON.stringify({ lastReceipt, lastPsRows, closeResult, stdout, stderr })); if (signal === 'SIGKILL') process.kill(-child.pid, signal); else child.kill(signal);
        let timer; const result = await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('DOCUMENT_OCR_INTERRUPT_TIMEOUT')), 15000); })]).finally(() => clearTimeout(timer));
        const beforeRecovery = json(join(runs, active.attemptId, 'receipt.json'));
        log({ kind: 'interrupt', packageId, host, cwd: root, executable: process.execPath, argv, signal, ...result, workerPid, attemptId: active.attemptId, beforeRecoveryStatus: beforeRecovery.status, stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), stdoutSha256: sha(stdout), stderrSha256: sha(stderr), stdoutLog: `interrupt-${signal}.stdout.log`, stderrLog: `interrupt-${signal}.stderr.log` });
        if (signal === 'SIGKILL') { assert.equal(result.exitSignal, 'SIGKILL'); assert.equal(result.exitCode, null); }
        else { assert.equal(result.exitCode, 1, stdout + stderr); assert.equal(result.exitSignal, null); const response = JSON.parse(stdout); assert.equal(response.status, 'interrupted'); assert.equal(response.attemptId, active.attemptId); assert.equal(response.indexCommitted, false); assert.equal(beforeRecovery.status, 'interrupted'); assert.equal(beforeRecovery.indexCommitted, false); }
        assert.deepEqual(readFileSync(join(project, 'assets/catalog.json')), before); const recovery = catalog(['--import', imported.importId, '--path', 'scan.pdf']); assert.equal(recovery.status, 'succeeded');
        assert.equal(json(join(runs, active.attemptId, 'receipt.json')).status, 'interrupted'); assert.equal(existsSync(join(runs, 'catalog.lock')), false);
        const goneDeadline = Date.now() + 5000; let alive = true; while (alive && Date.now() < goneDeadline) { try { process.kill(workerPid, 0); } catch (e) { if (e.code !== 'ESRCH') throw e; alive = false; } if (alive) await wait(20); }
        assert.equal(alive, false, 'observed document raster worker persists after recovery'); verify(first.catalogId);
      } finally { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') throw e; } await closed; writeFileSync(join(records, `interrupt-${signal}.stdout.log`), stdout); writeFileSync(join(records, `interrupt-${signal}.stderr.log`), stderr); log({ kind: 'signal-scene', packageId, signal, closeResult, lastPhase: lastReceipt?.phase ?? null, lastPsRows, stdoutSha256: sha(stdout), stderrSha256: sha(stderr) }); cpSync(project, join(records, signal + '-project'), { recursive: true, filter: p => !p.startsWith(join(project, '.engine')) }); }
    });
    save(join(records, 'result.json'), { status: 'passed', packageId, host, groups, sourceOracle: { bytes: ppm.length, sha256: sha(ppm) }, scope: ['selected-pdf-page-pixels', 'selected-docx-embedded-source-pixels'], unmeasured: ['hardRSS', 'library-internalIO', 'cross-hostpixels', 'OCRaccuracy', 'Wordappearance'] }); return { records, groups };
  } finally {
    if (existsSync(project)) cpSync(project, join(records, 'project'), { recursive: true, filter: p => !p.startsWith(join(project, '.engine')) });
    cpSync(selected, join(records, 'sources'), { recursive: true }); save(join(records, 'archive.json'), { packageId, host, records, projectEngine: 'Reconstruct from exact sealed package.' });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const { root, skill, verifyCore } = await import('./core.mjs'); verifyCore(); const out = join(root, '.research/out'); mkdirSync(out, { recursive: true }); const scratch = mkdtempSync(join(out, 'document-ocr-preflight-'));
  try { const result = await checkDocumentOcrNative({ scratch, skill, check: async (name, action) => { await action(); process.stdout.write(`✓ ${name}\n`); } }); process.stdout.write(JSON.stringify(result) + '\n'); }
  finally { rmSync(scratch, { recursive: true, force: true }); }
}
