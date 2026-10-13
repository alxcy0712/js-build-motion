import { crc32 } from 'node:zlib';
import { ocrLimits } from '../project/catalog.ts';
import type { NativeToolIdentity, OcrImageHeader, OcrLimits } from '../project/ocr.ts';
import { readFixed, runInspectionTool, type InspectContext } from './inspection.ts';

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const invalid = (format: 'PNG' | 'JPEG', reason: string): never => { throw new Error(`OCR_${format}_INVALID: ${reason}`); };
const unsupported = (reason: string): never => { throw new Error(`OCR_FORMAT_UNSUPPORTED: ${reason}`); };
function dimensions(format: OcrImageHeader['format'], width: number, height: number, limits: OcrLimits): OcrImageHeader {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff) throw new Error('OCR_HEADER_INVALID: dimensions');
  if (width > limits.maxOcrEdge || height > limits.maxOcrEdge) throw new Error('OCR_EDGE_LIMIT');
  if (width * height > limits.maxOcrSourcePixels) throw new Error('OCR_PIXEL_LIMIT');
  if (Buffer.byteLength(`P6\n${width} ${height}\n255\n`) + 3 * width * height > limits.maxOcrRasterBytes) throw new Error('OCR_RASTER_LIMIT');
  return { format, width, height };
}
function pngHeader(data: Buffer, limits: OcrLimits): OcrImageHeader {
  if (!data.subarray(0, 8).equals(pngSignature)) invalid('PNG', 'signature');
  let position = 8, entries = 0, color = -1, depth = 0, palette = 0, idatBytes = 0, idat = false, idatEnded = false;
  let header: OcrImageHeader | undefined;
  const seen = new Set<string>(), singleton = new Set(['IHDR', 'PLTE', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sRGB', 'sBIT', 'bKGD', 'hIST', 'pHYs', 'tIME', 'eXIf', 'cICP', 'mDCV', 'cLLI']);
  const beforePalette = new Set(['cHRM', 'gAMA', 'iCCP', 'sRGB', 'sBIT']);
  const beforeData = new Set([...beforePalette, 'PLTE', 'tRNS', 'bKGD', 'hIST', 'pHYs']);
  while (position < data.length) {
    if (++entries > limits.maxImageStructureEntries) throw new Error('OCR_STRUCTURE_LIMIT');
    if (position + 12 > data.length) invalid('PNG', 'truncated chunk');
    const length = data.readUInt32BE(position), end = position + 12 + length;
    if (length > 0x7fffffff || end > data.length) invalid('PNG', 'chunk length');
    const kind = data.toString('latin1', position + 4, position + 8), payload = data.subarray(position + 8, end - 4);
    if (!/^[A-Za-z]{2}[A-Z][A-Za-z]$/.test(kind)) invalid('PNG', 'chunk type');
    if (crc32(data.subarray(position + 4, end - 4)) !== data.readUInt32BE(end - 4)) invalid('PNG', 'CRC');
    if (entries === 1 && kind !== 'IHDR' || singleton.has(kind) && seen.has(kind)) invalid('PNG', 'chunk identity/order');
    if (idat && kind !== 'IDAT') idatEnded = true;
    if (beforeData.has(kind) && idat || beforePalette.has(kind) && seen.has('PLTE')) invalid('PNG', 'chunk order');
    if (['acTL', 'fcTL', 'fdAT'].includes(kind)) unsupported('APNG');
    if (kind === 'IHDR') {
      if (length !== 13) invalid('PNG', 'IHDR length');
      depth = payload[8]!; color = payload[9]!;
      const allowed: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!allowed[color]?.includes(depth) || payload[10] !== 0 || payload[11] !== 0 || ![0, 1].includes(payload[12]!)) invalid('PNG', 'IHDR fields');
      header = dimensions('png_pipe', payload.readUInt32BE(0), payload.readUInt32BE(4), limits);
    } else if (kind === 'PLTE') {
      if ([0, 4].includes(color) || !length || length > 768 || length % 3) invalid('PNG', 'PLTE');
      palette = length / 3;
      if (color === 3 && palette > 2 ** depth || seen.has('tRNS') || seen.has('bKGD')) invalid('PNG', 'palette order/size');
    } else if (kind === 'IDAT') {
      if (idatEnded || color === 3 && !palette) invalid('PNG', 'IDAT order/palette');
      idat = true; idatBytes += length;
    } else if (kind === 'IEND') {
      if (length || !idat || !idatBytes || end !== data.length) invalid('PNG', 'IEND/image count');
      if (depth === 16) unsupported('16-bit PNG');
      return header!;
    } else if (kind === 'tRNS') {
      if (color === 3 ? !palette || !length || length > palette : ![0, 2].includes(color) || length !== (color === 0 ? 2 : 6)) invalid('PNG', 'tRNS');
      if (color !== 3) for (let i = 0; i < length; i += 2) if (payload.readUInt16BE(i) >= 2 ** depth) invalid('PNG', 'tRNS sample');
    } else if (kind === 'bKGD') {
      const size: Record<number, number> = { 0: 2, 2: 6, 3: 1, 4: 2, 6: 6 };
      if (length !== size[color] || color === 3 && (!palette || payload[0]! >= palette)) invalid('PNG', 'bKGD');
      if (color !== 3) for (let i = 0; i < length; i += 2) if (payload.readUInt16BE(i) >= 2 ** depth) invalid('PNG', 'bKGD sample');
    } else if (kind === 'hIST') {
      if (!palette || length !== 2 * palette) invalid('PNG', 'hIST');
    } else if (kind === 'sBIT') {
      const sizes: Record<number, number> = { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 };
      if (length !== sizes[color] || [...payload].some(v => !v || v > (color === 3 ? 8 : depth))) invalid('PNG', 'sBIT');
    } else if (kind === 'gAMA') {
      if (length !== 4 || !payload.readUInt32BE(0)) invalid('PNG', 'gAMA');
    } else if (kind === 'cHRM') {
      if (length !== 32) invalid('PNG', 'cHRM');
    } else if (kind === 'sRGB') {
      if (length !== 1 || payload[0]! > 3 || seen.has('iCCP')) invalid('PNG', 'sRGB');
    } else if (kind === 'iCCP' || kind === 'zTXt' || kind === 'tEXt' || kind === 'iTXt') {
      const zero = payload.indexOf(0);
      if (zero < 1 || zero > 79) invalid('PNG', 'text/profile keyword');
      if (kind === 'iCCP' && seen.has('sRGB') || ['iCCP', 'zTXt'].includes(kind) && (zero + 2 >= length || payload[zero + 1] !== 0)) invalid('PNG', 'profile/compressed text');
      if (kind === 'iTXt' && (zero + 3 > length || ![0, 1].includes(payload[zero + 1]!) || payload[zero + 2] !== 0 || payload.indexOf(0, zero + 3) < 0 || payload.indexOf(0, payload.indexOf(0, zero + 3) + 1) < 0)) invalid('PNG', 'iTXt');
    } else if (kind === 'pHYs') {
      if (length !== 9 || payload[8]! > 1) invalid('PNG', 'pHYs');
    } else if (kind === 'tIME') {
      if (length !== 7 || payload[2]! < 1 || payload[2]! > 12 || payload[3]! < 1 || payload[3]! > 31 || payload[4]! > 23 || payload[5]! > 59 || payload[6]! > 60) invalid('PNG', 'tIME');
    } else if (kind === 'cICP' || kind === 'mDCV' || kind === 'cLLI') {
      if (length !== ({ cICP: 4, mDCV: 24, cLLI: 8 })[kind]) invalid('PNG', 'color metadata length');
    } else if (kind[0]! >= 'A' && kind[0]! <= 'Z') unsupported(`PNG critical chunk ${kind}`);
    seen.add(kind); position = end;
  }
  return invalid('PNG', 'missing IEND');
}
function jpegHeader(data: Buffer, limits: OcrLimits): OcrImageHeader {
  if (data[0] !== 0xff || data[1] !== 0xd8) invalid('JPEG', 'SOI');
  let position = 2, entries = 1, frame = 0, scan = false, entropy = false, restartInterval = 0, nextRestart = 0;
  let header: OcrImageHeader | undefined;
  const components = new Map<number, number>(), quant = new Set<number>(), huffman = new Set<number>(), complete = new Set<number>();
  const progression = new Map<number, (number | null)[]>();
  if (entries > limits.maxImageStructureEntries) throw new Error('OCR_STRUCTURE_LIMIT');
  while (position < data.length) {
    if (entropy) {
      while (position < data.length && data[position] !== 0xff) position++;
      if (position === data.length) break;
    }
    if (data[position++] !== 0xff) invalid('JPEG', 'marker prefix');
    while (data[position] === 0xff) position++;
    if (position >= data.length) invalid('JPEG', 'truncated marker');
    const marker = data[position++]!;
    if (entropy && marker === 0) continue;
    if (++entries > limits.maxImageStructureEntries) throw new Error('OCR_STRUCTURE_LIMIT');
    if (marker >= 0xd0 && marker <= 0xd7) {
      if (!entropy || !restartInterval || marker !== 0xd0 + nextRestart) invalid('JPEG', 'restart marker');
      nextRestart = (nextRestart + 1) % 8; continue;
    }
    entropy = false;
    if (marker === 0xd8) unsupported('multiple JPEG images');
    if (marker === 0xd9) {
      if (!header || !scan || components.size !== complete.size) invalid('JPEG', 'incomplete image');
      if (position !== data.length) {
        if (data.indexOf(Buffer.from([0xff, 0xd8]), position) >= 0) unsupported('multiple JPEG images');
        invalid('JPEG', 'trailing bytes');
      }
      return header;
    }
    if (position + 2 > data.length) invalid('JPEG', 'truncated segment');
    const length = data.readUInt16BE(position), end = position + length;
    if (length < 2 || end > data.length) invalid('JPEG', 'segment length');
    const payload = data.subarray(position + 2, end); position = end;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (frame || payload.length < 6 || payload.length !== 6 + 3 * payload[5]!) invalid('JPEG', 'SOF');
      if (![0xc0, 0xc2].includes(marker)) unsupported('JPEG SOF');
      if (payload[0] !== 8 || ![1, 3].includes(payload[5]!)) unsupported('JPEG precision/components (CMYK/YCCK)');
      header = dimensions('jpeg_pipe', payload.readUInt16BE(3), payload.readUInt16BE(1), limits); frame = marker;
      let blocks = 0;
      for (let i = 6; i < payload.length; i += 3) {
        const id = payload[i]!, sampling = payload[i + 1]!, horizontal = sampling >> 4, vertical = sampling & 15;
        if (components.has(id) || horizontal < 1 || horizontal > 4 || vertical < 1 || vertical > 4 || payload[i + 2]! > 3) invalid('JPEG', 'SOF component');
        blocks += horizontal * vertical; components.set(id, payload[i + 2]!); progression.set(id, Array(64).fill(null));
      }
      if (blocks > 10) invalid('JPEG', 'MCU sampling');
    } else if (marker === 0xdb) {
      let i = 0;
      if (!payload.length) invalid('JPEG', 'empty DQT');
      while (i < payload.length) {
        const info = payload[i++]!, precision = info >> 4, id = info & 15, size = 64 * (precision + 1);
        if (precision > 1 || id > 3 || i + size > payload.length) invalid('JPEG', 'DQT');
        for (let j = i; j < i + size; j += precision + 1) if (!(precision ? payload.readUInt16BE(j) : payload[j])) invalid('JPEG', 'zero quantizer');
        quant.add(id); i += size;
      }
    } else if (marker === 0xc4) {
      let i = 0;
      if (!payload.length) invalid('JPEG', 'empty DHT');
      while (i < payload.length) {
        const info = payload[i++]!, kind = info >> 4, id = info & 15;
        if (kind > 1 || id > 3 || i + 16 > payload.length) invalid('JPEG', 'DHT');
        let symbols = 0, codes = 1;
        for (let j = 0; j < 16; j++) { const count = payload[i + j]!; symbols += count; codes = codes * 2 - count; if (codes <= 0) invalid('JPEG', 'Huffman lengths'); }
        i += 16;
        if (!symbols || symbols > 256 || i + symbols > payload.length) invalid('JPEG', 'Huffman symbols');
        const values = payload.subarray(i, i + symbols);
        if (new Set(values).size !== symbols || [...values].some(v => kind === 0 ? v > 11 : (v & 15) > 10)) invalid('JPEG', 'Huffman symbols');
        huffman.add(info); i += symbols;
      }
    } else if (marker === 0xda) {
      const count = payload[0]!;
      if (!frame || !count || count > components.size || payload.length !== 4 + 2 * count) invalid('JPEG', 'SOS');
      const spectralStart = payload[1 + 2 * count]!, spectralEnd = payload[2 + 2 * count]!, approximation = payload[3 + 2 * count]!, high = approximation >> 4, low = approximation & 15;
      if (frame === 0xc0 ? spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0 : spectralStart > spectralEnd || spectralEnd > 63 || spectralStart === 0 && spectralEnd !== 0 || spectralStart > 0 && count !== 1 || high > 13 || low > 13 || high && high !== low + 1) invalid('JPEG', 'scan parameters');
      const selected = new Set<number>();
      for (let i = 1; i < 1 + 2 * count; i += 2) {
        const id = payload[i]!, tables = payload[i + 1]!, dc = tables >> 4, ac = tables & 15;
        if (!components.has(id) || selected.has(id) || dc > 3 || ac > 3 || !quant.has(components.get(id)!)) invalid('JPEG', 'scan component/table');
        if ((frame === 0xc0 || spectralStart === 0 && high === 0) && !huffman.has(dc) || (frame === 0xc0 || spectralStart > 0) && !huffman.has(0x10 | ac)) invalid('JPEG', 'missing Huffman table');
        if (frame === 0xc0 && complete.has(id)) invalid('JPEG', 'duplicate sequential component');
        if (frame === 0xc2) for (let j = spectralStart; j <= spectralEnd; j++) {
          const previous = progression.get(id)![j];
          if (high === 0 ? previous !== null : previous !== high) invalid('JPEG', 'progressive scan order');
          progression.get(id)![j] = low;
        }
        if (spectralStart === 0) complete.add(id); selected.add(id);
      }
      scan = true; entropy = true; nextRestart = 0;
    } else if (marker === 0xdd) {
      if (payload.length !== 2) invalid('JPEG', 'DRI'); restartInterval = payload.readUInt16BE(0);
    } else if (marker >= 0xe0 && marker <= 0xef || marker === 0xfe) {
      if (marker === 0xe2 && payload.subarray(0, 4).equals(Buffer.from('MPF\0'))) unsupported('MPF/MPO');
    } else if ([0xc8, 0xcc, 0xdc, 0xde, 0xdf].includes(marker)) unsupported('JPEG coding extension');
    else invalid('JPEG', 'unknown marker');
  }
  return invalid('JPEG', 'missing EOI');
}

/** Inspect container structure before any native decoding allocation. */
export function preflightOcrImage(sourceBytes: Buffer, format: OcrImageHeader['format'], limits: OcrLimits): OcrImageHeader {
  if (sourceBytes.length > limits.maxOcrSourceBytes) throw new Error('OCR_SOURCE_LIMIT');
  if (format === 'png_pipe') return pngHeader(sourceBytes, limits);
  if (format === 'jpeg_pipe') return jpegHeader(sourceBytes, limits);
  return unsupported('image signature');
}

/** Decode one encoded-direction frame. The caller accounts and publishes the returned PPM. */
export async function decodeOcrRaster(source: string, header: OcrImageHeader, context: InspectContext, native: NativeToolIdentity): Promise<{ width: number; height: number; ppm: Buffer }> {
  const limits = ocrLimits(context.policy), { width, height } = dimensions(header.format, header.width, header.height, limits);
  if (!['png_pipe', 'jpeg_pipe'].includes(header.format)) throw new Error('OCR_HEADER_INVALID: format');
  if (context.sourceBytes !== undefined && context.sourceBytes > limits.maxOcrSourceBytes) throw new Error('OCR_SOURCE_LIMIT');
  async function identity(retain = false) {
    try { return await readFixed(source, limits.maxOcrSourceBytes, context.signal, bytes => { context.counts.sourceReadBytes += bytes; }, retain); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('CATALOG_FILE_CHANGED') || message.startsWith('CATALOG_READ_LIMIT') && context.sourceSha256) throw new Error(`CATALOG_SOURCE_CHANGED: ${message}`);
      if (message.startsWith('CATALOG_READ_LIMIT')) throw new Error('OCR_SOURCE_LIMIT');
      throw error;
    }
  }
  context.check(); const before = await identity(true);
  if (context.sourceBytes !== undefined && before.bytes !== context.sourceBytes || context.sourceSha256 && before.sha256 !== context.sourceSha256) throw new Error('CATALOG_SOURCE_CHANGED: raster input');
  const actualHeader = preflightOcrImage(before.data, header.format, limits);
  if (actualHeader.width !== width || actualHeader.height !== height) throw new Error('OCR_RASTER_GEOMETRY_INVALID: source/header dimensions');
  before.data = Buffer.alloc(0);
  const expected = 4 * width * height, rgba = Buffer.allocUnsafe(expected); let offset = 0;
  const run = await runInspectionTool({ executable: native.executable, version: `${native.version}/ocr-raster@0.1`,
    argv: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-max_alloc', '67108864', '-probesize', '4194304', '-analyzeduration', '5000000',
      '-protocol_whitelist', 'file', '-format_whitelist', header.format, '-f', header.format, '-max_streams', '1', '-threads', '1', '-noautorotate',
      '-c:v', header.format === 'png_pipe' ? 'png' : 'mjpeg', '-i', source, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
      '-fps_mode', 'passthrough', '-threads', '1', '-c:v', 'rawvideo', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
    cwd: context.temporaryDir, policy: { ...context.policy, maxToolElapsedMs: Math.min(30000, context.policy.maxToolElapsedMs), maxToolOutputBytes: Math.min(1048576, context.policy.maxToolOutputBytes) },
    signal: context.signal, ocr: true, binaryLimit: expected,
    binary: async chunk => {
      context.check(); context.signal.throwIfAborted();
      if (context.counts.derivedBytes + chunk.length > context.policy.maxDerivedBytes) throw new Error('CATALOG_DERIVED_LIMIT');
      context.counts.derivedBytes += chunk.length; chunk.copy(rgba, offset); offset += chunk.length;
    }, onRun: value => { context.tools.push(value); context.counts.toolOutputBytes += value.stdoutBytes + value.stderrBytes; } });
  context.check(); context.signal.throwIfAborted();
  if (run.error?.startsWith('CATALOG_') && !/^CATALOG_(?:TOOL_|BINARY_LIMIT)/.test(run.error)) throw new Error(run.error);
  const after = await identity(); if (before.bytes !== after.bytes || before.sha256 !== after.sha256) throw new Error('CATALOG_SOURCE_CHANGED: raster input');
  if (run.error) throw new Error(`OCR_RASTER_TOOL_FAILED: ${run.error}`);
  if (offset !== expected) throw new Error('OCR_RASTER_GEOMETRY_INVALID: decoded RGBA length');
  const prefix = Buffer.from(`P6\n${width} ${height}\n255\n`), ppm = Buffer.allocUnsafe(prefix.length + 3 * width * height); prefix.copy(ppm);
  for (let i = 0, j = prefix.length; i < expected; i += 4, j += 3) {
    if (!(i % 262144)) { context.check(); context.signal.throwIfAborted(); }
    const alpha = rgba[i + 3]!;
    for (let channel = 0; channel < 3; channel++) ppm[j + channel] = Math.floor((rgba[i + channel]! * alpha + 255 * (255 - alpha) + 127) / 255);
  }
  context.check(); return { width, height, ppm };
}
