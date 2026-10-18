import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

const sha = value => createHash('sha256').update(value).digest('hex');
const p = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const a = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const s = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const r = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const relationships = values => '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + values.map(([id, type, target, mode]) =>
  `<Relationship Id="${id}" Type="${r}${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ''}/>`).join('') + '</Relationships>';
const types = values => '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' + values.map(([part, type]) =>
  `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.${type}+xml"/>`).join('') + '</Types>';
const shape = (text, placeholder = '') => '<p:sp><p:nvSpPr><p:cNvPr id="1" name="Independent"/><p:cNvSpPr/><p:nvPr>' + placeholder +
  '</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>' + text + '</a:t></a:r></a:p></p:txBody></p:sp>';
const slide = text => `<p:sld xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree>${shape(text)}</p:spTree></p:cSld></p:sld>`;

/** Known fictional XML is constructed independently of the Office adapter and its dedicated fixtures. */
export async function checkOfficeNative({ scratch, skill, run, check }) {
  const root = join(scratch, 'office workspace'), core = join(root, '.skill'), project = join(root, 'projects/office-film');
  const selected = join(scratch, 'office sources'), invalid = join(scratch, 'office invalid sources');
  const control = (args, expected = 0) => run(root, [join(core, 'scripts/video.mjs'), ...args], expected);
  const catalog = (args, expected = 0) => JSON.parse(control(['office-film', 'catalog', ...args], expected));
  const verify = id => catalog(['--verify', id]).manifest;
  const imported = source => JSON.parse(control(['office-film', 'import', '--source', source]));
  const latest = (manifest, name) => manifest.assets.filter(asset => asset.source.path === name).at(-1);
  const evidence = (asset, kind) => asset.technical.evidence.find(value => value.kind === kind);
  const originals = new Map(), badOriginals = new Map();
  const expected = { 'slides.pptx': 'Two EN\n一号中文\n讲者数据', 'sheets.xlsx': '名称\n值Value\n文本Text\n42\n1\n84\nIndependentTable\tA1:B3\n名称\t值Value' };
  let parent, defaultReceipt, defaultManifest, legacyReceipt, legacyManifest, nativeReceipt, nativeManifest, policy07;
  const records = join(dirname(skill), '.research/out/office-native-evidence', randomUUID());
  let failed = false, failure = null;

  try {
  await check('Office 独立已知原件：默认 0.4 与历史 0.6 保持 ZIP 路由和采用身份', async () => {
    mkdirSync(root, { recursive: true }); cpSync(skill, core, { recursive: true }); mkdirSync(selected); mkdirSync(invalid);
    const { makeZip } = await import(pathToFileURL(join(skill, 'engine/test/fixtures/zip.ts')).href);
    const { INSPECT_POLICY_06, INSPECT_POLICY_07 } = await import(pathToFileURL(join(skill, 'engine/src/project/catalog.ts')).href);
    policy07 = INSPECT_POLICY_07;
    const pptx = [
      { name: '[Content_Types].xml', data: types([['ppt/presentation.xml', 'presentationml.presentation.main'], ['ppt/slides/slide1.xml', 'presentationml.slide'], ['ppt/slides/slide2.xml', 'presentationml.slide'], ['ppt/notesSlides/notesSlide1.xml', 'presentationml.notesSlide']]) },
      { name: '_rels/.rels', data: relationships([['main', 'officeDocument', 'ppt/presentation.xml']]) },
      { name: 'ppt/presentation.xml', data: `<p:presentation xmlns:p="${p}" xmlns:r="${r.slice(0, -1)}"><p:sldIdLst><p:sldId id="257" r:id="second"/><p:sldId id="256" r:id="first"/></p:sldIdLst></p:presentation>` },
      { name: 'ppt/_rels/presentation.xml.rels', data: relationships([['first', 'slide', 'slides/slide1.xml'], ['second', 'slide', 'slides/slide2.xml']]) },
      { name: 'ppt/slides/slide1.xml', data: slide('一号中文') },
      { name: 'ppt/slides/slide2.xml', data: slide('Two EN') },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: relationships([['notes', 'notesSlide', '../notesSlides/notesSlide1.xml']]) },
      { name: 'ppt/notesSlides/notesSlide1.xml', data: `<p:notes xmlns:p="${p}" xmlns:a="${a}"><p:cSld><p:spTree>${shape('讲者数据', '<p:ph type="body"/>')}${shape('99', '<p:ph type="sldNum"/>')}</p:spTree></p:cSld></p:notes>` },
    ];
    const xlsx = [
      { name: '[Content_Types].xml', data: types([['xl/workbook.xml', 'spreadsheetml.sheet.main'], ['xl/worksheets/sheet1.xml', 'spreadsheetml.worksheet'], ['xl/sharedStrings.xml', 'spreadsheetml.sharedStrings'], ['xl/tables/table1.xml', 'spreadsheetml.table']]) },
      { name: '_rels/.rels', data: relationships([['main', 'officeDocument', 'xl/workbook.xml']]) },
      { name: 'xl/workbook.xml', data: `<workbook xmlns="${s}" xmlns:r="${r.slice(0, -1)}"><sheets><sheet name="数据" sheetId="1" r:id="sheet"/></sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: relationships([['sheet', 'worksheet', 'worksheets/sheet1.xml'], ['strings', 'sharedStrings', 'sharedStrings.xml']]) },
      { name: 'xl/sharedStrings.xml', data: `<sst xmlns="${s}"><si><t>名称</t></si><si><r><t>值</t></r><r><t>Value</t></r></si></sst>` },
      { name: 'xl/worksheets/sheet1.xml', data: `<worksheet xmlns="${s}" xmlns:r="${r.slice(0, -1)}"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="inlineStr"><is><r><t>文本</t></r><r><t>Text</t></r></is></c><c r="B2"><v>42</v></c></row><row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3"><f>B2*2</f><v>84</v></c></row></sheetData><tableParts count="1"><tablePart r:id="table"/></tableParts></worksheet>` },
      { name: 'xl/worksheets/_rels/sheet1.xml.rels', data: relationships([['table', 'table', '../tables/table1.xml']]) },
      { name: 'xl/tables/table1.xml', data: `<table xmlns="${s}" id="1" name="IndependentTable" displayName="IndependentTable" ref="A1:B3"><tableColumns count="2"><tableColumn id="1" name="名称"/><tableColumn id="2" name="值Value"/></tableColumns></table>` },
    ];
    for (const [name, parts] of [['slides.pptx', pptx], ['sheets.xlsx', xlsx]]) { const data = makeZip(parts.slice().reverse()); originals.set(name, data); writeFileSync(join(selected, name), data); }
    const badPackages = [
      ['crc.pptx', [...pptx, { name: 'ppt/media/unread.bin', data: 'unread bytes', crc: 1 }]],
      ['external.pptx', pptx.map(part => part.name === 'ppt/_rels/presentation.xml.rels' ? { ...part, data: relationships([['first', 'slide', 'slides/slide1.xml'], ['second', 'slide', 'https://example.invalid/slide.xml', 'External']]) } : part)],
      ['entity.xlsx', xlsx.map(part => part.name === 'xl/worksheets/sheet1.xml' ? { ...part, data: '<!DOCTYPE worksheet [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + part.data } : part)],
      ['macro.xlsx', xlsx.map(part => part.name === '[Content_Types].xml' ? { ...part, data: part.data.replace('spreadsheetml.sheet.main+xml', 'spreadsheetml.sheet.macroEnabled.main+xml') } : part)],
    ];
    for (const [name, parts] of badPackages) { const data = makeZip(parts); badOriginals.set(name, data); writeFileSync(join(invalid, name), data); }
    control(['start', '--theme', 'minimal', 'office-film', '--idea', '虚构离线 Office 原生门禁']);
    parent = imported(selected); defaultReceipt = catalog(['--import', parent.importId]); defaultManifest = verify(defaultReceipt.catalogId);
    assert.equal(defaultManifest.policy.version, '0.4'); assert.equal(defaultManifest.assets.length, 2);
    for (const [name, source] of originals) { const asset = latest(defaultManifest, name); assert.equal(asset.technical.format, 'zip'); assert.equal(asset.technical.status, 'requires-unpack'); assert.equal(asset.source.sha256, sha(source)); assert.deepEqual(readFileSync(join(project, asset.source.fixedPath)), source); }
    const policySource = JSON.stringify(INSPECT_POLICY_06, null, 2) + '\n'; writeFileSync(join(project, 'inputs/inspect-policy.json'), policySource);
    legacyReceipt = catalog(['--import', parent.importId]); legacyManifest = verify(legacyReceipt.catalogId);
    assert.equal(legacyManifest.policy.version, '0.6'); assert.equal(legacyManifest.policySourceSha256, sha(policySource));
    assert.equal(readFileSync(join(project, 'runs', legacyReceipt.attemptId, 'inspect-policy.source.json'), 'utf8'), policySource);
    for (const [name, source] of originals) { const asset = latest(legacyManifest, name); assert.equal(asset.technical.format, 'zip'); assert.equal(asset.technical.status, 'requires-unpack'); assert.deepEqual(readFileSync(join(project, asset.source.fixedPath)), source); }
    verify(defaultReceipt.catalogId);
  });

  await check('Office 显式 0.7：正文/notes/table 的已知 UTF8、版本、来源与 map 闭合', () => {
    writeFileSync(join(project, 'inputs/inspect-policy.json'), JSON.stringify(policy07));
    nativeReceipt = catalog(['--import', parent.importId]); nativeManifest = verify(nativeReceipt.catalogId); assert.equal(nativeManifest.policy.version, '0.7');
    for (const [name, source] of originals) {
      const asset = latest(nativeManifest, name), old = latest(legacyManifest, name), text = evidence(asset, 'text'), mapped = evidence(asset, 'document-map');
      assert.ok(['supported', 'partial'].includes(asset.technical.status), asset.technical.reason); assert.equal(asset.assetId, old.assetId); assert.notEqual(asset.assetVersion, old.assetVersion);
      assert.equal(asset.source.sha256, sha(source)); assert.deepEqual(readFileSync(join(project, asset.source.fixedPath)), source);
      const data = readFileSync(join(project, text.path)), mapData = readFileSync(join(project, mapped.path)), map = JSON.parse(mapData);
      assert.equal(data.toString('utf8'), expected[name]); assert.equal(text.sha256, sha(data)); assert.equal(mapped.sha256, sha(mapData));
      assert.equal(map.version, '0.2'); assert.equal(map.source.bytes, source.length); assert.equal(map.source.sha256, sha(source)); assert.equal(map.policySha256, asset.inspection.policySha256);
      assert.equal(map.text.bytes, data.length); assert.equal(map.text.sha256, sha(data)); assert.equal(asset.technical.document.version, '0.2');
      assert.equal(map.coverage.completedUnits, name === 'slides.pptx' ? 3 : 7); assert.ok(map.metrics.maxRSSKiB > 0); assert.equal(map.metrics.sourceReadBytes, source.length * 2);
      for (const unit of map.units) {
        assert.ok(['complete', 'empty'].includes(unit.status)); assert.equal(unit.locator.kind, asset.technical.format);
        assert.ok(data.subarray(unit.byteStart, unit.byteEnd).toString('utf8').length || unit.status === 'empty');
      }
      if (name === 'slides.pptx') { assert.equal(map.units[0].locator.part, 'ppt/slides/slide2.xml'); assert.equal(map.units[0].locator.slide, 1); assert.equal(map.units[2].locator.part, 'ppt/notesSlides/notesSlide1.xml'); }
      else { assert.equal(map.units[5].locator.cell, 'B3'); assert.equal(map.units[6].locator.range, 'A1:B3'); assert.ok(map.coverage.omitted.some(value => value.includes('formula cache uncomputed'))); }
    }
    verify(defaultReceipt.catalogId); verify(legacyReceipt.catalogId);
  });

  await check('Office 真实 worker：非正文 CRC/DTD/已解释外链/宏拒绝，Office/XML 配额保留原件', () => {
    const bad = imported(invalid), receipt = catalog(['--import', bad.importId]), manifest = verify(receipt.catalogId);
    const reasons = { 'crc.pptx': /UNPACK_INTEGRITY_INVALID/, 'external.pptx': /DOCUMENT_EXTERNAL_RELATIONSHIP_REJECTED/, 'entity.xlsx': /DOCUMENT_XML_DTD_REJECTED/, 'macro.xlsx': /DOCUMENT_MACRO_REJECTED/ };
    for (const [name, source] of badOriginals) { const asset = latest(manifest, name); assert.equal(asset.technical.status, 'failed', asset.technical.reason); assert.match(asset.technical.reason, reasons[name]); assert.equal(asset.technical.evidence.length, 0); assert.deepEqual(readFileSync(join(project, asset.source.fixedPath)), source); }
    for (const policy of [{ ...policy07, office: { ...policy07.office, maxSlides: 0 } }, { ...policy07, document: { ...policy07.document, maxXmlPartBytes: 1 } }]) {
      writeFileSync(join(project, 'inputs/inspect-policy.json'), JSON.stringify(policy)); const limited = catalog(['--import', parent.importId, '--path', 'slides.pptx']), fixed = verify(limited.catalogId), asset = latest(fixed, 'slides.pptx');
      assert.equal(asset.technical.status, 'failed', asset.technical.reason); assert.match(asset.technical.reason, /DOCUMENT_PACKAGE_LIMIT:(slides|part-bytes)/); assert.equal(asset.technical.evidence.length, 0); assert.deepEqual(readFileSync(join(project, asset.source.fixedPath)), originals.get('slides.pptx'));
    }
    writeFileSync(join(project, 'inputs/inspect-policy.json'), JSON.stringify(policy07)); verify(nativeReceipt.catalogId);
    assert.equal(existsSync(join(project, 'runs/catalog.lock')), false); assert.equal(readdirSync(join(project, 'out/.tmp')).some(name => name.startsWith('catalog-sandbox-')), false);
  });

  await check('Office 同长度原件/text/map 替换拒绝，恢复后历史 0.4/0.6/0.7 目录有效', () => {
    const asset = latest(nativeManifest, 'slides.pptx');
    for (const path of [asset.source.fixedPath, evidence(asset, 'text').path, evidence(asset, 'document-map').path]) {
      const target = join(project, path), original = readFileSync(target), changed = Buffer.from(original); changed[changed.length - 2] ^= 1;
      try { writeFileSync(target, changed); assert.equal(changed.length, original.length); assert.match(control(['office-film', 'catalog', '--verify', nativeReceipt.catalogId], 1), /CHANGED|INVALID|Error|验证/); }
      finally { writeFileSync(target, original); } verify(nativeReceipt.catalogId);
    }
    verify(defaultReceipt.catalogId); verify(legacyReceipt.catalogId);
    for (const [name, source] of originals) assert.deepEqual(readFileSync(join(project, latest(nativeManifest, name).source.fixedPath)), source);
  });
  } catch (error) { failed = true; failure = error instanceof Error ? error.stack ?? error.message : String(error); throw error; }
  finally {
    try {
      mkdirSync(records, { recursive: true });
      for (const [source, name] of [[selected, 'sources'], [invalid, 'invalid-sources']]) if (existsSync(source)) cpSync(source, join(records, name), { recursive: true });
      if (existsSync(project)) cpSync(project, join(records, 'project'), { recursive: true, filter: path => {
        const name = relative(project, path);
        if (name === 'guide' || name.startsWith('guide' + sep)) return false;
        if (name.startsWith('.engine' + sep)) { const file = name.slice('.engine'.length + 1); return !file.includes(sep) && (file.endsWith('.json') || file === 'workspace.mjs'); }
        return true;
      } });
      const manifest = join(skill, 'manifest.json');
      if (existsSync(manifest)) cpSync(manifest, join(records, 'runtime-source-manifest.json'));
      const files = [];
      function inventory(directory) {
        for (const name of readdirSync(directory).sort()) {
          const path = join(directory, name);
          if (statSync(path).isDirectory()) inventory(path);
          else { const data = readFileSync(path); files.push({ path: relative(records, path).split(sep).join('/'), bytes: data.length, sha256: sha(data) }); }
        }
      }
      inventory(records);
      writeFileSync(join(records, 'archive.json'), JSON.stringify({ version: '0.1', kind: 'office-native-evidence-archive',
        packageId: existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')).packageId : null,
        origin: { cwd: root, projectCwd: project, scratch, skill, host: hostname(), platform: process.platform, arch: process.arch, node: process.version },
        status: failed ? 'failed' : 'passed', error: failure, files,
        limitations: ['Catalog worker request/tool/policy/text/map/coverage/metrics are preserved as emitted. Binary worker result JSON is not persisted by the catalog interface.',
          'Runtime dependencies and duplicate guide files are omitted; reconstruct the fixed runtime from the exact sealed package.'],
      }, null, 2) + '\n');
      process.stdout.write(JSON.stringify({ kind: 'office-native-evidence-archive', records, status: failed ? 'failed' : 'passed' }) + '\n');
    } catch (error) { if (!failed) throw error; process.stderr.write('OFFICE_NATIVE_ARCHIVE_FAILED: ' + (error instanceof Error ? error.message : String(error)) + '\n'); }
  }
}
