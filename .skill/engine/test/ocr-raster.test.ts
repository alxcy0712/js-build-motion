import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { crc32, deflateSync } from 'node:zlib';
import { DEFAULT_INSPECT_POLICY, emptyCatalogCounts } from '../src/project/catalog.ts';
import { DEFAULT_OCR_LIMITS, type NativeToolIdentity, type OcrLimits } from '../src/project/ocr.ts';
import type { InspectContext } from '../src/adapters/inspection.ts';
import { decodeOcrRaster, preflightOcrImage } from '../src/adapters/ocr-raster.ts';
import { ocrRuntimeIdentity } from '../workspace.mjs';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', '.research/out'); mkdirSync(out, { recursive: true });
const scratch = mkdtempSync(join(out, 'ocr-raster-')); after(() => rmSync(scratch, { recursive: true, force: true }));
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
let sequence = 0;
function chunk(kind: string, payload: Buffer) {
  const result = Buffer.alloc(payload.length + 12); result.writeUInt32BE(payload.length); result.write(kind, 4, 'ascii'); payload.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4); return result;
}
function ihdr(width = 3, height = 1, color = 6, depth = 8, interlace = 0) {
  const data = Buffer.alloc(13); data.writeUInt32BE(width); data.writeUInt32BE(height, 4); data[8] = depth; data[9] = color; data[12] = interlace; return chunk('IHDR', data);
}
function png(parts: Buffer[]) { return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), ...parts]); }
const rgba = [0, 0, 0, 0, 10, 20, 30, 128, 23, 91, 180, 255];
const image = () => png([ihdr(), chunk('IDAT', deflateSync(Buffer.from([0, ...rgba]))), chunk('IEND', Buffer.alloc(0))]);
function limit(changes: Partial<OcrLimits> = {}): OcrLimits { return { ...DEFAULT_OCR_LIMITS, ...changes }; }
function segment(marker: number, payload: Buffer) {
  const data = Buffer.alloc(payload.length + 4); data[0] = 0xff; data[1] = marker; data.writeUInt16BE(payload.length + 2, 2); payload.copy(data, 4); return data;
}
function jpegParts({ width = 3, height = 1, components = 1, frame = 0xc0 } = {}) {
  const sof = Buffer.alloc(6 + 3 * components); sof[0] = 8; sof.writeUInt16BE(height, 1); sof.writeUInt16BE(width, 3); sof[5] = components;
  for (let i = 0; i < components; i++) { sof[6 + 3 * i] = i + 1; sof[7 + 3 * i] = 0x11; }
  const dht = Buffer.concat([Buffer.from([0, 1, ...Array(15).fill(0), 0]), Buffer.from([0x10, 1, ...Array(15).fill(0), 0])]);
  const sos = Buffer.from([components, ...Array.from({ length: components }, (_, i) => [i + 1, 0]).flat(), 0, frame === 0xc2 ? 0 : 63, 0]);
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8), bits = '0'.repeat(blocks * components * (frame === 0xc2 ? 1 : 2));
  const entropy = Buffer.from(Array.from({ length: Math.ceil(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8).padEnd(8, '1'), 2)));
  const parts = [Buffer.from([0xff, 0xd8]), segment(0xdb, Buffer.from([0, ...Array(64).fill(1)])), segment(frame, sof), segment(0xc4, dht), segment(0xda, sos), entropy];
  if (frame === 0xc2) parts.push(segment(0xda, Buffer.from([1, 1, 0, 1, 63, 0])), entropy);
  parts.push(Buffer.from([0xff, 0xd9])); return parts;
}
function exif(orientation: number) {
  const tiff = Buffer.alloc(26); tiff.write('II', 0); tiff.writeUInt16LE(42, 2); tiff.writeUInt32LE(8, 4); tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10); tiff.writeUInt16LE(3, 12); tiff.writeUInt32LE(1, 14); tiff.writeUInt16LE(orientation, 18);
  return segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0'), tiff]));
}
function context(data: Buffer, changes: Record<string, any> = {}): { source: string; context: InspectContext } {
  const dir = join(scratch, String(++sequence)); mkdirSync(dir); const source = join(dir, 'selected image.bin'); writeFileSync(source, data);
  const controller = new AbortController(), policy = { ...DEFAULT_INSPECT_POLICY, ...changes, ocr: { ...DEFAULT_INSPECT_POLICY.ocr, ...changes.ocr } };
  return { source, context: { projectDir: scratch, temporaryDir: dir, evidenceDir: dir, publishedDir: 'fictional', policy,
    counts: emptyCatalogCounts(), tools: [], signal: controller.signal, check: () => controller.signal.throwIfAborted(), sourceBytes: data.length, sourceSha256: hash(data) } };
}
function fakeTool(code: string): NativeToolIdentity {
  const path = join(scratch, `tool-${++sequence}`), data = Buffer.from(`#!${process.execPath}\n${code}\n`); writeFileSync(path, data, { mode: 0o700 });
  return { executable: path, version: 'fictional-decoder@1', files: [{ path, bytes: data.length, sha256: hash(data) }], aliases: [{ path, realpath: path }] };
}
const exactTool = () => fakeTool(`process.stdout.write(Buffer.from(${JSON.stringify(rgba)}));`);
function rgbBody(ppm: Buffer, width = 3, height = 1) { const prefix = Buffer.from(`P6\n${width} ${height}\n255\n`); assert.ok(ppm.subarray(0, prefix.length).equals(prefix)); assert.equal(ppm.length, prefix.length + 3 * width * height); return ppm.subarray(prefix.length); }

test('PNG admits every static color/depth combination <=8-bit and Adam7', () => {
  for (const [color, depths] of [[0, [1, 2, 4, 8]], [2, [8]], [3, [1, 2, 4, 8]], [4, [8]], [6, [8]]] as const) for (const depth of depths) for (const interlace of [0, 1]) {
    const parts = [ihdr(3, 1, color, depth, interlace)]; if (color === 3) parts.push(chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])));
    parts.push(chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 0]))), chunk('IEND', Buffer.alloc(0)));
    assert.deepEqual(preflightOcrImage(png(parts), 'png_pipe', limit()), { format: 'png_pipe', width: 3, height: 1 });
  }
});
test('PNG validates palette, transparency, metadata and contiguous IDAT order', () => {
  const palette = chunk('PLTE', Buffer.from([0, 0, 0, 200, 100, 20])), trans = chunk('tRNS', Buffer.from([0, 128])), compressed = deflateSync(Buffer.from([0, 0x40]));
  const parts = [ihdr(3, 1, 3, 1), palette, trans, chunk('IDAT', compressed.subarray(0, 2)), chunk('IDAT', compressed.subarray(2)), chunk('IEND', Buffer.alloc(0))];
  assert.equal(preflightOcrImage(png(parts), 'png_pipe', limit()).width, 3);
  for (const value of [png([parts[0]!, trans, palette, ...parts.slice(3)]), png([parts[0]!, palette, palette, ...parts.slice(2)]), png([parts[0]!, ...parts.slice(3)]),
    png([parts[0]!, palette, parts[3]!, chunk('tEXt', Buffer.from('key\0literal data')), parts[4]!, parts[5]!]), png([ihdr(), chunk('tRNS', Buffer.from([0])), chunk('IDAT', compressed), parts[5]!])]) assert.throws(() => preflightOcrImage(value, 'png_pipe', limit()), /OCR_PNG_INVALID/);
  assert.throws(() => preflightOcrImage(png([ihdr(1, 1, 3, 1), chunk('PLTE', Buffer.alloc(9)), chunk('IDAT', compressed), parts[5]!]), 'png_pipe', limit()), /OCR_PNG_INVALID/);
  const gamma = Buffer.from([0, 0, 177, 143]);
  assert.throws(() => preflightOcrImage(png([parts[0]!, palette, chunk('gAMA', gamma), ...parts.slice(2)]), 'png_pipe', limit()), /OCR_PNG_INVALID/);
});
test('PNG CRC, chunk bounds/identity, critical extensions and range limits are explicit', () => {
  const original = image(), damaged = Buffer.from(original); damaged[damaged.length - 1] ^= 1;
  for (const value of [damaged, original.subarray(0, -1), Buffer.concat([original, Buffer.from([0])]), png([chunk('IDAT', Buffer.from([0])), ihdr(), chunk('IEND', Buffer.alloc(0))]),
    png([ihdr(), ihdr(), chunk('IDAT', deflateSync(Buffer.from([0]))), chunk('IEND', Buffer.alloc(0))]), png([ihdr(), chunk('IDAT', Buffer.alloc(0)), chunk('IEND', Buffer.alloc(0))]),
    png([ihdr(), chunk('zzzz', Buffer.alloc(0)), chunk('IDAT', Buffer.from([0])), chunk('IEND', Buffer.alloc(0))])]) assert.throws(() => preflightOcrImage(value, 'png_pipe', limit()), /OCR_PNG_INVALID/);
  const huge = Buffer.from(original); huge.writeUInt32BE(0x7fffffff, 33); assert.throws(() => preflightOcrImage(huge, 'png_pipe', limit()), /OCR_PNG_INVALID/);
  assert.throws(() => preflightOcrImage(png([ihdr(), chunk('ABCD', Buffer.alloc(0)), chunk('IDAT', Buffer.from([0])), chunk('IEND', Buffer.alloc(0))]), 'png_pipe', limit()), /OCR_FORMAT_UNSUPPORTED/);
  for (const kind of ['acTL', 'fcTL', 'fdAT']) assert.throws(() => preflightOcrImage(png([ihdr(), chunk(kind, Buffer.alloc(8)), chunk('IDAT', Buffer.from([0])), chunk('IEND', Buffer.alloc(0))]), 'png_pipe', limit()), /OCR_FORMAT_UNSUPPORTED/);
  assert.throws(() => preflightOcrImage(png([ihdr(1, 1, 6, 16), chunk('IDAT', deflateSync(Buffer.alloc(9))), chunk('IEND', Buffer.alloc(0))]), 'png_pipe', limit()), /OCR_FORMAT_UNSUPPORTED/);
  const malformed = Buffer.alloc(13); malformed.writeUInt32BE(1); malformed.writeUInt32BE(1, 4); malformed[8] = 4; malformed[9] = 6;
  assert.throws(() => preflightOcrImage(png([chunk('IHDR', malformed), chunk('IDAT', Buffer.from([0])), chunk('IEND', Buffer.alloc(0))]), 'png_pipe', limit()), /OCR_PNG_INVALID/);
});
test('preflight source, pixel, edge, raster and structure limits accept exact and reject +1', () => {
  const source = image(), header = Buffer.from('P6\n3 1\n255\n'), exact = { maxOcrSourceBytes: source.length, maxOcrSourcePixels: 3, maxOcrEdge: 3, maxOcrRasterBytes: header.length + 9, maxImageStructureEntries: 3 };
  assert.equal(preflightOcrImage(source, 'png_pipe', limit(exact)).width, 3);
  for (const [key, pattern] of [['maxOcrSourceBytes', /OCR_SOURCE_LIMIT/], ['maxOcrSourcePixels', /OCR_PIXEL_LIMIT/], ['maxOcrEdge', /OCR_EDGE_LIMIT/], ['maxOcrRasterBytes', /OCR_RASTER_LIMIT/], ['maxImageStructureEntries', /OCR_STRUCTURE_LIMIT/]] as const)
    assert.throws(() => preflightOcrImage(source, 'png_pipe', limit({ ...exact, [key]: exact[key] - 1 })), pattern);
  for (const width of [0, 0x80000000]) assert.throws(() => preflightOcrImage(png([ihdr(width), chunk('IDAT', Buffer.from([0])), chunk('IEND', Buffer.alloc(0))]), 'png_pipe', limit()), /OCR_HEADER_INVALID/);
  const jpg = Buffer.concat(jpegParts()), count = 6;
  assert.equal(preflightOcrImage(jpg, 'jpeg_pipe', limit({ maxImageStructureEntries: count })).width, 3);
  assert.throws(() => preflightOcrImage(jpg, 'jpeg_pipe', limit({ maxImageStructureEntries: count - 1 })), /OCR_STRUCTURE_LIMIT/);
  assert.equal(preflightOcrImage(jpg, 'jpeg_pipe', limit({ maxOcrSourceBytes: jpg.length, maxOcrSourcePixels: 3, maxOcrEdge: 3, maxOcrRasterBytes: header.length + 9 })).width, 3);
  for (const [key, pattern] of [['maxOcrSourceBytes', /OCR_SOURCE_LIMIT/], ['maxOcrSourcePixels', /OCR_PIXEL_LIMIT/], ['maxOcrEdge', /OCR_EDGE_LIMIT/], ['maxOcrRasterBytes', /OCR_RASTER_LIMIT/]] as const) {
    const values = { maxOcrSourceBytes: jpg.length, maxOcrSourcePixels: 3, maxOcrEdge: 3, maxOcrRasterBytes: header.length + 9 };
    assert.throws(() => preflightOcrImage(jpg, 'jpeg_pipe', limit({ ...values, [key]: values[key] - 1 })), pattern);
  }
});
test('JPEG baseline/progressive, grayscale/RGB, EXIF, stuffed bytes and restart structure', () => {
  for (const components of [1, 3]) assert.deepEqual(preflightOcrImage(Buffer.concat(jpegParts({ components })), 'jpeg_pipe', limit()), { format: 'jpeg_pipe', width: 3, height: 1 });
  assert.equal(preflightOcrImage(Buffer.concat(jpegParts({ frame: 0xc2 })), 'jpeg_pipe', limit()).width, 3);
  for (let orientation = 1; orientation <= 8; orientation++) { const parts = jpegParts(); parts.splice(1, 0, exif(orientation)); assert.equal(preflightOcrImage(Buffer.concat(parts), 'jpeg_pipe', limit()).width, 3); }
  const parts = jpegParts(); parts.splice(-1, 0, Buffer.from([0xff, 0x00])); assert.equal(preflightOcrImage(Buffer.concat(parts), 'jpeg_pipe', limit()).width, 3);
  const restarted = jpegParts(); restarted.splice(4, 0, segment(0xdd, Buffer.from([0, 1]))); restarted.splice(-1, 0, Buffer.from([0xff, 0xd0])); assert.equal(preflightOcrImage(Buffer.concat(restarted), 'jpeg_pipe', limit()).width, 3);
});
test('default source/structure/pixel/edge ceilings admit the boundary and reject excess', () => {
  const original = image(), padding = Buffer.alloc(DEFAULT_OCR_LIMITS.maxOcrSourceBytes - original.length - 12, 97); padding[0] = 107; padding[1] = 0;
  const full = png([ihdr(), chunk('tEXt', padding), chunk('IDAT', deflateSync(Buffer.from([0, ...rgba]))), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(full.length, DEFAULT_OCR_LIMITS.maxOcrSourceBytes); assert.equal(preflightOcrImage(full, 'png_pipe', limit()).width, 3);
  assert.throws(() => preflightOcrImage(Buffer.concat([full, Buffer.from([0])]), 'png_pipe', limit()), /OCR_SOURCE_LIMIT/);
  const extra = Array.from({ length: DEFAULT_OCR_LIMITS.maxImageStructureEntries - 3 }, () => chunk('tEXt', Buffer.from('k\0a'))), parts = [ihdr(), ...extra, chunk('IDAT', deflateSync(Buffer.from([0, ...rgba]))), chunk('IEND', Buffer.alloc(0))];
  assert.equal(preflightOcrImage(png(parts), 'png_pipe', limit()).width, 3); parts.splice(1, 0, chunk('tEXt', Buffer.from('k\0a')));
  assert.throws(() => preflightOcrImage(png(parts), 'png_pipe', limit()), /OCR_STRUCTURE_LIMIT/);
  const declared = (w: number, h: number) => png([ihdr(w, h), chunk('IDAT', deflateSync(Buffer.from([0]))), chunk('IEND', Buffer.alloc(0))]);
  assert.equal(preflightOcrImage(declared(4000, 4000), 'png_pipe', limit()).width * 4000, 16000000);
  assert.throws(() => preflightOcrImage(declared(4000, 4001), 'png_pipe', limit()), /OCR_PIXEL_LIMIT/);
  assert.equal(preflightOcrImage(declared(8192, 1), 'png_pipe', limit()).width, 8192);
  assert.throws(() => preflightOcrImage(declared(8193, 1), 'png_pipe', limit()), /OCR_EDGE_LIMIT/);
});
test('JPEG rejects truncated/illegal segments, marker/table/scan structure and multiple images', () => {
  const original = Buffer.concat(jpegParts());
  for (const value of [original.subarray(0, -1), Buffer.concat([original, Buffer.from([0])]), Buffer.from([0xff, 0xd8, 0xff]), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1]), Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, 0]), Buffer.from([0xff, 0xd8, 0xff, 0xd9])]) assert.throws(() => preflightOcrImage(value, 'jpeg_pipe', limit()), /OCR_JPEG_INVALID/);
  const missingTable = jpegParts(); missingTable.splice(3, 1); assert.throws(() => preflightOcrImage(Buffer.concat(missingTable), 'jpeg_pipe', limit()), /OCR_JPEG_INVALID/);
  const duplicateFrame = jpegParts(); duplicateFrame.splice(3, 0, duplicateFrame[2]!); assert.throws(() => preflightOcrImage(Buffer.concat(duplicateFrame), 'jpeg_pipe', limit()), /OCR_JPEG_INVALID/);
  const badScan = jpegParts(); badScan[4] = segment(0xda, Buffer.from([1, 2, 0, 0, 63, 0])); assert.throws(() => preflightOcrImage(Buffer.concat(badScan), 'jpeg_pipe', limit()), /OCR_JPEG_INVALID/);
  const badDht = jpegParts(); badDht[3] = segment(0xc4, Buffer.from([0, 3, ...Array(15).fill(0), 0, 1, 2])); assert.throws(() => preflightOcrImage(Buffer.concat(badDht), 'jpeg_pipe', limit()), /OCR_JPEG_INVALID/);
  const allOnesDht = jpegParts(); allOnesDht[3] = segment(0xc4, Buffer.from([0, 2, ...Array(15).fill(0), 0, 1])); assert.throws(() => preflightOcrImage(Buffer.concat(allOnesDht), 'jpeg_pipe', limit()), /OCR_JPEG_INVALID/);
  const badDqt = jpegParts(); badDqt[1] = segment(0xdb, Buffer.from([0, ...Array(63).fill(1)])); assert.throws(() => preflightOcrImage(Buffer.concat(badDqt), 'jpeg_pipe', limit()), /OCR_JPEG_INVALID/);
  const badRestart = jpegParts(); badRestart.splice(-1, 0, Buffer.from([0xff, 0xd0])); assert.throws(() => preflightOcrImage(Buffer.concat(badRestart), 'jpeg_pipe', limit()), /OCR_JPEG_INVALID/);
  const badProgression = jpegParts({ frame: 0xc2 }); badProgression.splice(-1, 0, segment(0xda, Buffer.from([1, 1, 0, 1, 63, 0])), Buffer.from([0x7f])); assert.throws(() => preflightOcrImage(Buffer.concat(badProgression), 'jpeg_pipe', limit()), /OCR_JPEG_INVALID/);
  for (const value of [Buffer.concat(jpegParts({ components: 4 })), Buffer.concat(jpegParts({ frame: 0xc1 })), Buffer.concat([original, original])]) assert.throws(() => preflightOcrImage(value, 'jpeg_pipe', limit()), /OCR_FORMAT_UNSUPPORTED/);
  const mpf = jpegParts(); mpf.splice(1, 0, segment(0xe2, Buffer.from('MPF\0fictional'))); assert.throws(() => preflightOcrImage(Buffer.concat(mpf), 'jpeg_pipe', limit()), /OCR_FORMAT_UNSUPPORTED/);
});

test('bounded tool decoding writes exact P6, integer white pixels and raw-only accounting', async () => {
  const { source, context: ctx } = context(image()), result = await decodeOcrRaster(source, preflightOcrImage(image(), 'png_pipe', limit()), ctx, exactTool());
  assert.deepEqual([...rgbBody(result.ppm)], [255, 255, 255, 132, 137, 142, 23, 91, 180]); assert.equal(ctx.counts.derivedBytes, 12); assert.equal(ctx.counts.sourceReadBytes, 2 * image().length);
  const run = ctx.tools[0]!; assert.match(run.version, /\/ocr-raster@0\.1$/); assert.equal(run.binaryBytes, 12); assert.equal(run.stdoutBytes, 0); assert.equal(run.exitCode, 0);
  for (const flag of ['-noautorotate', '-frames:v', '-protocol_whitelist', '-format_whitelist', '-threads', '-max_alloc']) assert.ok(run.argv.includes(flag));
  assert.equal(run.argv[run.argv.indexOf('-frames:v') + 1], '1'); assert.equal(run.argv[run.argv.indexOf('-protocol_whitelist') + 1], 'file'); assert.equal(run.argv.includes('-vf'), false);
});
test('decoder rejects short/overlong raw, exits, diagnostic overflow and time limits', async () => {
  for (const [code, pattern, bytes] of [[`process.stdout.write(Buffer.alloc(11));`, /OCR_RASTER_GEOMETRY_INVALID/, 11], [`process.stdout.write(Buffer.alloc(13));`, /OCR_RASTER_TOOL_FAILED.*BINARY_LIMIT/, 12], [`process.stdout.write(Buffer.alloc(3));process.exitCode=2;`, /OCR_RASTER_TOOL_FAILED.*TOOL_EXIT/, 3]] as const) {
    const { source, context: ctx } = context(image()); await assert.rejects(decodeOcrRaster(source, { format: 'png_pipe', width: 3, height: 1 }, ctx, fakeTool(code)), pattern); assert.equal(ctx.counts.derivedBytes, bytes); assert.equal(ctx.tools.length, 1);
  }
  const diagnostics = context(image(), { maxToolOutputBytes: 32 }); await assert.rejects(decodeOcrRaster(diagnostics.source, { format: 'png_pipe', width: 3, height: 1 }, diagnostics.context, fakeTool('process.stderr.write("x".repeat(128));')), /OCR_RASTER_TOOL_FAILED.*OUTPUT_LIMIT/); assert.equal(diagnostics.context.counts.toolOutputBytes, 32);
  const timeout = context(image(), { maxToolElapsedMs: 10 }); await assert.rejects(decodeOcrRaster(timeout.source, { format: 'png_pipe', width: 3, height: 1 }, timeout.context, fakeTool('setInterval(()=>{},1000);')), /OCR_RASTER_TOOL_FAILED.*TIME_LIMIT/); assert.equal(timeout.context.tools[0]!.signal, 'SIGKILL');
  const missing = context(image()); await assert.rejects(decodeOcrRaster(missing.source, { format: 'png_pipe', width: 3, height: 1 }, missing.context, { ...exactTool(), executable: join(scratch, 'missing-decoder') }), /OCR_RASTER_TOOL_FAILED.*TOOL_ERROR/);
});
test('one-shot global check failures and the fixed native environment survive tool callbacks', async () => {
  const failed = context(image()); let checks = 0; failed.context.check = () => { if (++checks === 2) throw new Error('CATALOG_TIME_LIMIT'); };
  await assert.rejects(decodeOcrRaster(failed.source, { format: 'png_pipe', width: 3, height: 1 }, failed.context, exactTool()), /^Error: CATALOG_TIME_LIMIT$/); assert.equal(failed.context.counts.derivedBytes, 0);
  const selected = context(image()), tool = fakeTool(`if(process.env.OMP_THREAD_LIMIT!=='1'||process.env.HOME||process.env.NODE_OPTIONS)process.exit(3);process.stdout.write(Buffer.from(${JSON.stringify(rgba)}));`);
  await decodeOcrRaster(selected.source, { format: 'png_pipe', width: 3, height: 1 }, selected.context, tool); assert.equal(selected.context.tools[0]!.exitCode, 0);
});
test('decode local limits precede subprocess and general smaller limits remain effective', async () => {
  const cases = [[{ ocr: { maxOcrEdge: 2 } }, /OCR_EDGE_LIMIT/], [{ ocr: { maxOcrSourcePixels: 2 } }, /OCR_PIXEL_LIMIT/], [{ ocr: { maxOcrRasterBytes: 19 } }, /OCR_RASTER_LIMIT/], [{ ocr: { maxOcrSourceBytes: image().length - 1 } }, /SOURCE_CHANGED|SOURCE_LIMIT/], [{ maxSourcePixels: 2 }, /OCR_PIXEL_LIMIT/]] as const;
  for (const [policy, pattern] of cases) { const { source, context: ctx } = context(image(), policy); await assert.rejects(decodeOcrRaster(source, { format: 'png_pipe', width: 3, height: 1 }, ctx, exactTool()), pattern); assert.equal(ctx.tools.length, 0); }
  const exact = context(image(), { ocr: { maxOcrSourcePixels: 3, maxOcrEdge: 3, maxOcrRasterBytes: 20 }, maxDerivedBytes: 19 }); exact.context.counts.derivedBytes = 7;
  await decodeOcrRaster(exact.source, { format: 'png_pipe', width: 3, height: 1 }, exact.context, exactTool()); assert.equal(exact.context.counts.derivedBytes, 19);
  const over = context(image(), { maxDerivedBytes: 18 }); over.context.counts.derivedBytes = 7; await assert.rejects(decodeOcrRaster(over.source, { format: 'png_pipe', width: 3, height: 1 }, over.context, exactTool()), /^Error: CATALOG_DERIVED_LIMIT$/); assert.equal(over.context.counts.derivedBytes, 7);
  const wrongHeader = context(image()); await assert.rejects(decodeOcrRaster(wrongHeader.source, { format: 'png_pipe', width: 0, height: 1 }, wrongHeader.context, exactTool()), /OCR_HEADER_INVALID/);
  const transposed = context(image()); await assert.rejects(decodeOcrRaster(transposed.source, { format: 'png_pipe', width: 1, height: 3 }, transposed.context, exactTool()), /OCR_RASTER_GEOMETRY_INVALID/); assert.equal(transposed.context.tools.length, 0);
});
test('source identities, during-tool mutation and abort keep batch failure semantics', async () => {
  const stale = context(image()); stale.context.sourceSha256 = 'a'.repeat(64); await assert.rejects(decodeOcrRaster(stale.source, { format: 'png_pipe', width: 3, height: 1 }, stale.context, exactTool()), /CATALOG_SOURCE_CHANGED/); assert.equal(stale.context.tools.length, 0);
  const changed = context(image()), mutated = Buffer.from(image()); mutated[20] ^= 1;
  const tool = fakeTool(`require('node:fs').writeFileSync(${JSON.stringify(changed.source)},Buffer.from(${JSON.stringify([...mutated])}));process.stdout.write(Buffer.from(${JSON.stringify(rgba)}));`);
  await assert.rejects(decodeOcrRaster(changed.source, { format: 'png_pipe', width: 3, height: 1 }, changed.context, tool), /CATALOG_SOURCE_CHANGED/); assert.equal(changed.context.counts.derivedBytes, 12);
  const cancelled = context(image()), controller = new AbortController(); cancelled.context.signal = controller.signal; cancelled.context.check = () => controller.signal.throwIfAborted();
  const timer = setTimeout(() => controller.abort(), 30);
  try { await assert.rejects(decodeOcrRaster(cancelled.source, { format: 'png_pipe', width: 3, height: 1 }, cancelled.context, fakeTool('setInterval(()=>{},1000);')), { name: 'AbortError' }); }
  finally { clearTimeout(timer); } assert.equal(cancelled.context.tools[0]!.signal, 'SIGKILL');
});

test('real FFmpeg preserves odd dimensions, PNG alpha/palette/gray and Adam7 pixels', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const native = ocrRuntimeIdentity().tools.ffmpeg;
  const fixtures: { data: Buffer; rgb: number[]; width: number; height: number }[] = [
    { data: image(), rgb: [255, 255, 255, 132, 137, 142, 23, 91, 180], width: 3, height: 1 },
    { data: png([ihdr(3, 1, 3, 1), chunk('PLTE', Buffer.from([0, 0, 0, 200, 100, 20])), chunk('tRNS', Buffer.from([0, 128])), chunk('IDAT', deflateSync(Buffer.from([0, 0x40]))), chunk('IEND', Buffer.alloc(0))]), rgb: [255, 255, 255, 227, 177, 137, 255, 255, 255], width: 3, height: 1 },
    { data: png([ihdr(3, 1, 0, 4), chunk('IDAT', deflateSync(Buffer.from([0, 0x08, 0xf0]))), chunk('IEND', Buffer.alloc(0))]), rgb: [0, 0, 0, 136, 136, 136, 255, 255, 255], width: 3, height: 1 },
    { data: png([ihdr(3, 1, 4), chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0, 128, 255, 255]))), chunk('IEND', Buffer.alloc(0))]), rgb: [255, 255, 255, 127, 127, 127, 255, 255, 255], width: 3, height: 1 }
  ];
  const pixels = Array.from({ length: 9 }, (_, i) => [20 * i, 200 - 10 * i, 15 * i, i % 3 === 0 ? 0 : i % 3 === 1 ? 128 : 255]);
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]], rows: number[] = [];
  for (const [x0, y0, dx, dy] of passes) for (let y = y0!; y < 3; y += dy!) { if (x0! >= 3) continue; rows.push(0); for (let x = x0!; x < 3; x += dx!) rows.push(...pixels[y * 3 + x]!); }
  fixtures.push({ data: png([ihdr(3, 3, 6, 8, 1), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]), rgb: pixels.flatMap(p => p.slice(0, 3).map(v => Math.floor((v * p[3]! + 255 * (255 - p[3]!) + 127) / 255))), width: 3, height: 3 });
  for (const fixture of fixtures) { const { source, context: ctx } = context(fixture.data), header = preflightOcrImage(fixture.data, 'png_pipe', limit()), result = await decodeOcrRaster(source, header, ctx, native); assert.deepEqual([...rgbBody(result.ppm, fixture.width, fixture.height)], fixture.rgb); assert.equal(ctx.counts.derivedBytes, 4 * fixture.width * fixture.height); assert.equal(ctx.counts.sourceReadBytes, fixture.data.length * 2); }
});
test('real JPEG baseline/progressive and EXIF 1-8 retain encoded direction and pixel order', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const native = ocrRuntimeIdentity().tools.ffmpeg;
  for (const data of [Buffer.concat(jpegParts()), Buffer.concat(jpegParts({ components: 3 })), Buffer.concat(jpegParts({ frame: 0xc2 }))]) { const { source, context: ctx } = context(data), result = await decodeOcrRaster(source, preflightOcrImage(data, 'jpeg_pipe', limit()), ctx, native); assert.equal(rgbBody(result.ppm).length, 9); }
  const pixels = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255, 0, 255, 255, 255, 255, 0, 255, 255];
  const pngData = png([ihdr(3, 2), chunk('IDAT', deflateSync(Buffer.from([0, ...pixels.slice(0, 12), 0, ...pixels.slice(12)]))), chunk('IEND', Buffer.alloc(0))]), input = context(pngData);
  const encoded = spawnSync(native.executable, ['-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file', '-f', 'png_pipe', '-i', input.source, '-frames:v', '1', '-threads', '1', '-pix_fmt', 'yuvj444p', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'], { cwd: scratch, timeout: 30000, maxBuffer: 8388608 }); assert.equal(encoded.status, 0, encoded.stderr.toString());
  const baseline = context(encoded.stdout), expected = await decodeOcrRaster(baseline.source, preflightOcrImage(encoded.stdout, 'jpeg_pipe', limit()), baseline.context, native);
  assert.ok(new Set(rgbBody(expected.ppm, 3, 2).toJSON().data).size > 4);
  for (let orientation = 1; orientation <= 8; orientation++) {
    const data = Buffer.concat([encoded.stdout.subarray(0, 2), exif(orientation), encoded.stdout.subarray(2)]), selected = context(data), header = preflightOcrImage(data, 'jpeg_pipe', limit()), actual = await decodeOcrRaster(selected.source, header, selected.context, native);
    assert.equal(actual.width, 3); assert.equal(actual.height, 2); assert.deepEqual(actual.ppm, expected.ppm, `EXIF ${orientation}`);
  }
});
test('real invalid compressed pixels fail after bounded raw admission and preserve source', { skip: process.platform !== 'darwin' || process.arch !== 'arm64' }, async () => {
  const data = png([ihdr(), chunk('IDAT', Buffer.from([0, 0])), chunk('IEND', Buffer.alloc(0))]), selected = context(data), native = ocrRuntimeIdentity().tools.ffmpeg;
  await assert.rejects(decodeOcrRaster(selected.source, preflightOcrImage(data, 'png_pipe', limit()), selected.context, native), /OCR_RASTER_TOOL_FAILED/); assert.deepEqual(readFileSync(selected.source), data); assert.equal(selected.context.counts.derivedBytes, 0); assert.equal(existsSync(join(scratch, 'escape')), false);
});
