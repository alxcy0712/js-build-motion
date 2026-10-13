import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rm, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { audioInputRuntimeIdentity } from '../../workspace.mjs';
import { DEFAULT_INSPECT_POLICY, type ToolRun } from '../project/catalog.ts';
import { validateAudioInputRuntime } from '../project/audio-input.ts';
import { VIDEO_PREPARATION_VERSION, PRODUCTION_VIDEO_PREPARATION_VERSION, validatePreparedVideoMap, validateVideoPreparationRequest, videoPreparationLimits,
  productionVideoPreparationLimits, videoAudioSamples, videoFrameSourceIndices, type PreparedVideoMap, type LegacyPreparedVideoMap,
  type ProductionPreparedVideoMap, type ProductionVideoPreparationLimits, type AnyVideoPreparationLimits,
  type VideoPreparationLimits, type VideoPreparationRequest, type LegacyVideoPreparationRequest, type ProductionVideoPreparationRequest } from '../project/video-preparation.ts';
import { NodeImportFiles, sameImportNode } from './import-files.ts';
import { readFixed, runInspectionTool } from './inspection.ts';

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
interface Box { type: string; data: number; end: number }
interface Packet { position: number; bytes: number }
export interface VideoSourceStructure { streamIndex: number; width: number; height: number; timeBase: string;
  pts: string[]; durations: (string | null)[]; packets: Packet[] }
interface ProductionSourceStructure extends VideoSourceStructure { seekPts: string[]; residentBytes: number;
  audio: { streamIndex: number; timeBase: string; startPts: string; maximumDuration: string; sampleRate: number; channels: number } | null }

/** Finite nonfragmented, self-contained ISO BMFF; every sample extent belongs to the one mdat. */
export function preflightVideoSource(data: Buffer, requestedStream: number, supplied = videoPreparationLimits()): VideoSourceStructure {
  const limits = videoPreparationLimits(supplied); if ('version' in limits) throw Error('VIDEO_LEGACY_POLICY_INVALID');
  return sourceStructure(data, requestedStream, limits);
}
function sourceStructure(data: Buffer, requestedStream: number, limits: VideoPreparationLimits, production = false, onCount?: (entries: number) => void): VideoSourceStructure | ProductionSourceStructure {
  let entries = 0;
  const invalid = (reason: string): never => { throw Error('VIDEO_SOURCE_INVALID: ' + reason); };
  const unsupported = (reason: string): never => { throw Error('VIDEO_SOURCE_UNSUPPORTED: ' + reason); };
  const count = (n = 1) => { entries += n; if (entries > limits.maxStructureEntries) throw Error('VIDEO_STRUCTURE_LIMIT'); onCount?.(entries); };
  if (!data.length || data.length > limits.maxSourceBytes) throw Error('VIDEO_SOURCE_BYTES_LIMIT');
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = [];
    while (start < end) {
      count(); if (start + 8 > end) invalid('atom header');
      let bytes = data.readUInt32BE(start), header = 8; const type = data.toString('latin1', start + 4, start + 8);
      if (bytes === 1) { if (start + 16 > end) invalid('large atom header'); const n = data.readBigUInt64BE(start + 8);
        if (n > BigInt(Number.MAX_SAFE_INTEGER)) invalid('unsafe atom extent'); bytes = Number(n); header = 16; }
      if (bytes < header || start + bytes > end) invalid('atom extent');
      result.push({ type, data: start + header, end: start + bytes }); start += bytes;
    }
    return result;
  }
  const one = (list: Box[], type: string): Box => { const selected = list.filter(box => box.type === type);
    if (selected.length !== 1) invalid(type + ' multiplicity'); return selected[0]!; };
  const allowed = (list: Box[], names: string[]) => { if (list.some(box => !names.includes(box.type))) unsupported('atom combination'); };
  function full(box: Box, bytes: number, versions = [0]) {
    if (box.end - box.data !== bytes || !versions.includes(data[box.data]!) || data.readUIntBE(box.data + 1, 3)) unsupported(box.type + ' version/flags/extent');
  }
  function table(box: Box, width: number, versions = [0]) {
    if (box.data + 8 > box.end) invalid('table header'); const n = data.readUInt32BE(box.data + 4); count(n); full(box, 8 + n * width, versions); return n;
  }
  const top = boxes(0, data.length); allowed(top, ['ftyp', 'free', 'wide', 'moov', 'mdat']);
  const ftyp = one(top, 'ftyp'), mdat = one(top, 'mdat'), moov = one(top, 'moov');
  if (ftyp.end - ftyp.data < 8 || (ftyp.end - ftyp.data) % 4 || !['isom', 'iso2', 'mp41', 'mp42', 'qt  '].includes(data.toString('latin1', ftyp.data, ftyp.data + 4))) unsupported('MP4/MOV brand');
  const movie = boxes(moov.data, moov.end); allowed(movie, ['mvhd', 'trak', 'udta']); const mvhd = one(movie, 'mvhd');
  if (mvhd.end - mvhd.data !== 100 || data[mvhd.data] !== 0 || !data.readUInt32BE(mvhd.data + 12)) unsupported('movie header');
  const tracks = movie.filter(box => box.type === 'trak'); if (!tracks.length || tracks.length > 2) unsupported('one video and optional audio track');
  const extents: Packet[] = []; let video: VideoSourceStructure | undefined, audio = 0;
  let sourceAudio: ProductionSourceStructure['audio'] = null, seekPts: string[] = [];
  for (const [index, track] of tracks.entries()) {
    const children = boxes(track.data, track.end); allowed(children, ['tkhd', 'edts', 'mdia']);
    const tkhd = one(children, 'tkhd'); if (tkhd.end - tkhd.data !== 84 || data[tkhd.data] !== 0) unsupported('track header');
    const mdia = one(children, 'mdia'), media = boxes(mdia.data, mdia.end); allowed(media, ['mdhd', 'hdlr', 'minf']);
    const mdhd = one(media, 'mdhd'); full(mdhd, 24); const timescale = data.readUInt32BE(mdhd.data + 12), mediaDuration = data.readUInt32BE(mdhd.data + 16);
    if (!timescale || timescale > 999999999) unsupported('media timescale');
    const hdlr = one(media, 'hdlr'); if (hdlr.end - hdlr.data < 20) invalid('handler');
    const type = data.toString('latin1', hdlr.data + 8, hdlr.data + 12), isVideo = type === 'vide';
    if (!isVideo && (type !== 'soun' || ++audio > 1)) unsupported('track type');
    if (isVideo && video) unsupported('multiple video tracks');
    const minf = one(media, 'minf'), info = boxes(minf.data, minf.end); allowed(info, [isVideo ? 'vmhd' : 'smhd', 'dinf', 'stbl']);
    one(info, isVideo ? 'vmhd' : 'smhd'); const dinf = one(info, 'dinf'), references = boxes(dinf.data, dinf.end); allowed(references, ['dref']);
    const dref = one(references, 'dref'); full(dref, 20); if (data.readUInt32BE(dref.data + 4) !== 1) unsupported('multiple data references');
    const url = one(boxes(dref.data + 8, dref.end), 'url '); if (url.end - url.data !== 4 || data.readUInt32BE(url.data) !== 1) unsupported('external data reference');
    const stbl = one(info, 'stbl'), tables = boxes(stbl.data, stbl.end); allowed(tables, ['stsd', 'stts', 'ctts', 'stsc', 'stsz', 'stco', 'co64', 'stss', 'sgpd', 'sbgp']);
    const stsd = one(tables, 'stsd'); if (stsd.data + 8 > stsd.end || data.readUInt32BE(stsd.data) || data.readUInt32BE(stsd.data + 4) !== 1) unsupported('sample descriptions');
    const descriptions = boxes(stsd.data + 8, stsd.end); allowed(descriptions, [isVideo ? 'avc1' : 'mp4a']); const sample = one(descriptions, isVideo ? 'avc1' : 'mp4a');
    const header = isVideo ? 78 : 28;
    if (sample.end - sample.data < header || data.readUInt16BE(sample.data + 6) !== 1) unsupported('sample header/data reference');
    if (isVideo) {
      const matrix = Array.from({ length: 9 }, (_, i) => data.readUInt32BE(tkhd.data + 40 + i * 4));
      if (JSON.stringify(matrix) !== JSON.stringify([65536, 0, 0, 0, 65536, 0, 0, 0, 1073741824])) unsupported('rotation/track transform');
    } else if (data.readUInt16BE(sample.data + 8) !== 0) unsupported('audio sample version');
    const sampleChildren = boxes(sample.data + header, sample.end); allowed(sampleChildren, isVideo ? ['avcC', 'pasp', 'btrt', 'colr'] : ['esds', 'btrt']);
    const configuration = one(sampleChildren, isVideo ? 'avcC' : 'esds');
    if (configuration.end - configuration.data < (isVideo ? 7 : 4)) invalid('codec configuration');
    if (isVideo && (data[configuration.data] !== 1 || (data[configuration.data + 4]! & 3) !== 3)) unsupported('four-byte H264 NAL lengths');
    const stsz = one(tables, 'stsz'); if (stsz.data + 12 > stsz.end) invalid('sample sizes');
    const fixed = data.readUInt32BE(stsz.data + 4), samples = data.readUInt32BE(stsz.data + 8); count(samples); full(stsz, 12 + (fixed ? 0 : samples * 4));
    if (!samples || isVideo && samples > limits.maxSourceFrames) throw Error('VIDEO_SOURCE_FRAME_LIMIT');
    const sizes = Array.from({ length: samples }, (_, i) => fixed || data.readUInt32BE(stsz.data + 12 + i * 4)); if (sizes.some(n => !n)) invalid('empty sample');
    const stts = one(tables, 'stts'), timing = table(stts, 8), dts: number[] = [], deltas: number[] = []; let time = 0;
    for (let i = 0; i < timing; i++) {
      const p = stts.data + 8 + i * 8, n = data.readUInt32BE(p), delta = data.readUInt32BE(p + 4);
      if (!n || dts.length + n > samples || !delta && !(isVideo && i === timing - 1 && n === 1)) invalid('sample durations');
      for (let j = 0; j < n; j++) { dts.push(time); deltas.push(delta); time += delta; }
    }
    if (dts.length !== samples || time !== mediaDuration) invalid('complete sample timing');
    const offsets = Array<number>(samples).fill(0), ctts = tables.filter(box => box.type === 'ctts');
    if (ctts.length > 1) invalid('composition time multiplicity');
    if (ctts.length) { const box = ctts[0]!, n = table(box, 8, [0, 1]); let ordinal = 0;
      for (let i = 0; i < n; i++) { const p = box.data + 8 + i * 8, amount = data.readUInt32BE(p), delta = data[box.data] ? data.readInt32BE(p + 4) : data.readUInt32BE(p + 4);
        if (!amount || ordinal + amount > samples) invalid('composition timing coverage'); offsets.fill(delta, ordinal, ordinal += amount); }
      if (ordinal !== samples) invalid('complete composition timing'); }
    let mediaTime = 0, epoch = 0; const edits = children.filter(box => box.type === 'edts');
    if (edits.length > 1) invalid('edit multiplicity');
    if (edits.length) { const list = boxes(edits[0]!.data, edits[0]!.end); allowed(list, ['elst']); const edit = one(list, 'elst');
      const amount = production ? data.readUInt32BE(edit.data + 4) : 1; full(edit, 8 + amount * 12);
      if (production && amount === 2) {
        if (!data.readUInt32BE(edit.data + 8) || data.readInt32BE(edit.data + 12) !== -1 || data.readUInt16BE(edit.data + 16) !== 1 || data.readUInt16BE(edit.data + 18)) unsupported('leading empty edit');
        const numerator = BigInt(data.readUInt32BE(edit.data + 8)) * BigInt(timescale), denominator = BigInt(data.readUInt32BE(mvhd.data + 12));
        epoch = Number((numerator * 2n + denominator) / (denominator * 2n));
      } else if (amount !== 1) unsupported('one forward edit and optional leading empty edit');
      const offset = edit.data + 8 + (amount - 1) * 12; mediaTime = data.readInt32BE(offset + 4);
      if (data.readUInt32BE(edit.data + 4) !== amount || !data.readUInt32BE(offset) || mediaTime < 0 || mediaTime > time || data.readUInt16BE(offset + 8) !== 1 || data.readUInt16BE(offset + 10)) unsupported('single forward rate-1 edit'); }
    const chunkOffsets = tables.filter(box => box.type === 'stco' || box.type === 'co64'); if (chunkOffsets.length !== 1) invalid('chunk offsets');
    const offsetBox = chunkOffsets[0]!, width = offsetBox.type === 'stco' ? 4 : 8, chunks = table(offsetBox, width), stsc = one(tables, 'stsc'), n = table(stsc, 12);
    const mappings = Array.from({ length: n }, (_, i) => { const p = stsc.data + 8 + i * 12; return { first: data.readUInt32BE(p), samples: data.readUInt32BE(p + 4), description: data.readUInt32BE(p + 8) }; });
    if (!chunks || !n || mappings[0]!.first !== 1 || mappings.some((m, i) => !m.samples || m.description !== 1 || m.first > chunks || i > 0 && m.first <= mappings[i - 1]!.first)) invalid('sample/chunk mapping');
    const packets: Packet[] = []; let mapping = 0, ordinal = 0;
    for (let i = 0; i < chunks; i++) {
      if (mapping + 1 < n && mappings[mapping + 1]!.first === i + 1) mapping++;
      const p = offsetBox.data + 8 + i * width, raw = width === 4 ? BigInt(data.readUInt32BE(p)) : data.readBigUInt64BE(p);
      if (raw > BigInt(data.length)) invalid('chunk outside source'); let position = Number(raw);
      for (let j = 0; j < mappings[mapping]!.samples; j++) { const bytes = sizes[ordinal++]!;
        if (!bytes || position < mdat.data || position + bytes > mdat.end) invalid('sample outside mdat');
        const packet = { position, bytes }; packets.push(packet); extents.push(packet); position += bytes; }
    }
    if (ordinal !== samples) invalid('complete sample coverage');
    for (const sync of tables.filter(box => box.type === 'stss')) { const n = table(sync, 4); let previous = 0;
      for (let i = 0; i < n; i++) { const value = data.readUInt32BE(sync.data + 8 + i * 4); if (value <= previous || value > samples) invalid('sync sample'); previous = value;
        if (production && isVideo) seekPts.push(String(dts[value - 1]! + offsets[value - 1]! - mediaTime + epoch)); } }
    for (const group of tables.filter(box => box.type === 'sgpd' || box.type === 'sbgp')) {
      if (isVideo || data.toString('latin1', group.data + 4, group.data + 8) !== 'roll') unsupported('sample grouping');
      if (group.type === 'sgpd') { full(group, 18, [1]); if (data.readUInt32BE(group.data + 8) !== 2 || data.readUInt32BE(group.data + 12) !== 1 || data.readInt16BE(group.data + 16) !== -1) unsupported('roll description'); }
      else { full(group, 20); if (data.readUInt32BE(group.data + 8) !== 1 || data.readUInt32BE(group.data + 12) !== samples || data.readUInt32BE(group.data + 16) !== 1) unsupported('roll coverage'); }
    }
    if (isVideo) {
      const width = data.readUInt16BE(sample.data + 24), height = data.readUInt16BE(sample.data + 26);
      if (!width || !height || width * height > limits.maxSourcePixels) throw Error('VIDEO_SOURCE_PIXEL_LIMIT');
      const presentation = dts.map((pts, i) => ({ pts: pts + offsets[i]! - mediaTime + epoch, duration: deltas[i] })).sort((a, b) => a.pts - b.pts);
      if (presentation.some((frame, i) => i > 0 && frame.pts <= presentation[i - 1]!.pts)) invalid('duplicate/decreasing presentation PTS');
      if ((presentation.at(-1)!.pts + presentation.at(-1)!.duration! - presentation[0]!.pts) * 1000 > limits.maxDurationMs * timescale) throw Error('VIDEO_SOURCE_DURATION_LIMIT');
      video = { streamIndex: index, width, height, timeBase: `1/${timescale}`, pts: presentation.map(frame => String(frame.pts)),
        durations: presentation.map(frame => frame.duration ? String(frame.duration) : null), packets };
    } else if (production) {
      // AAC LC's AudioSpecificConfig supplies the decoded rate/layout; mp4a's channel count can be nominal.
      let asc: Buffer | undefined;
      function descriptors(start: number, end: number) {
        while (start < end) {
          const tag = data[start++]!; let size = 0, lengthBytes = 0, byte: number;
          do { if (start >= end || ++lengthBytes > 4) invalid('AAC descriptor length'); byte = data[start++]!; size = size * 128 + (byte & 127); } while (byte & 128);
          if (start + size > end) invalid('AAC descriptor extent');
          if (tag === 3) { if (size < 3) invalid('AAC ES descriptor'); const flags = data[start + 2]!; let p = start + 3;
            if (flags & 128) p += 2; if (flags & 64) { if (p >= start + size) invalid('AAC URL extent'); p += 1 + data[p]!; } if (flags & 32) p += 2;
            if (flags & 64 || p > start + size) unsupported('external AAC descriptor'); descriptors(p, start + size);
          } else if (tag === 4) { if (size < 13 || data[start] !== 64 || (data[start + 1]! >> 2) !== 5) unsupported('AAC decoder config'); descriptors(start + 13, start + size); }
          else if (tag === 5) { if (asc) invalid('multiple AAC config'); asc = Buffer.from(Array.from({ length: size }, (_, i) => data[start + i]!)); }
          else if (tag !== 6) unsupported('AAC descriptor'); start += size;
        }
      }
      if (data.readUInt32BE(configuration.data)) unsupported('AAC esds version'); descriptors(configuration.data + 4, configuration.end);
      if (!asc || asc.length < 2) invalid('AAC specific config'); const bits = asc.readUInt16BE(0), objectType = bits >> 11, rateIndex = (bits >> 7) & 15, channel = (bits >> 3) & 15;
      const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350], channels = [0, 1, 2, 3, 4, 5, 6, 8];
      if (objectType !== 2 || !rates[rateIndex] || !channels[channel]) unsupported('AAC LC frequency/channel config');
      sourceAudio = { streamIndex: index, timeBase: `1/${timescale}`, startPts: String(epoch), maximumDuration: String(time + epoch), sampleRate: rates[rateIndex]!, channels: channels[channel]! };
    }
  }
  for (const metadata of movie.filter(box => box.type === 'udta')) {
    const list = boxes(metadata.data, metadata.end); allowed(list, ['meta']);
    for (const meta of list) { if (meta.data + 4 > meta.end || data.readUInt32BE(meta.data)) unsupported('metadata version');
      const children = boxes(meta.data + 4, meta.end); allowed(children, ['hdlr', 'ilst']);
      for (const list of children.filter(box => box.type === 'ilst')) for (const item of boxes(list.data, list.end)) allowed(boxes(item.data, item.end), ['data', 'mean', 'name']); }
  }
  let position = mdat.data;
  for (const packet of extents.sort((a, b) => a.position - b.position)) { if (packet.position !== position) invalid('complete nonoverlapping mdat coverage'); position += packet.bytes; }
  if (position !== mdat.end || !video || video.streamIndex !== requestedStream) invalid('video stream/sample coverage');
  if (production) return { ...video, seekPts: seekPts.length ? seekPts : [video.pts[0]!], residentBytes: 0, audio: sourceAudio };
  return video;
}

export interface VideoPreparationContext { projectDir: string; temporaryDir: string; limits: AnyVideoPreparationLimits;
  signal?: AbortSignal; check: () => void; onTool?: (run: ToolRun) => void; publishedDir: string }
const input = ['-max_alloc', '67108864', '-probesize', '4194304', '-analyzeduration', '5000000', '-protocol_whitelist', 'file',
  '-format_whitelist', 'mov', '-f', 'mov', '-enable_drefs', '0', '-use_absolute_path', '0', '-max_streams', '2'];
export function videoPreparationArguments(role: 'probe' | 'decode' | 'encode' | 'proxyProbe', source: string, request: VideoPreparationRequest,
  width: number, height: number, frames: number, canonical: string, proxy: string): string[] {
  if (role === 'probe') return ['-v', 'error', ...input, '-show_streams', '-show_frames', '-show_packets', '-select_streams', String(request.streamIndex),
    '-show_entries', 'stream=index,codec_type,codec_name,width,height,pix_fmt,time_base,field_order,color_transfer,color_primaries,sample_aspect_ratio:stream_side_data=rotation:frame=stream_index,pts,best_effort_timestamp,duration,width,height,pix_fmt:packet=stream_index,pos,size', '-of', 'json', source];
  if (role === 'decode') return ['-nostdin', '-hide_banner', '-loglevel', 'info', '-xerror', ...input, '-copyts', '-noautorotate', '-i', source,
    '-map', `0:${request.streamIndex}`, '-an', '-sn', '-dn', '-vf', `scale=${width}:${height}:flags=bilinear,format=rgba,showinfo`,
    '-fps_mode', 'passthrough', '-threads', '1', '-filter_threads', '1', '-c:v', 'rawvideo', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'];
  if (role === 'encode') return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '67108864', '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${width}x${height}`, '-framerate', String(request.fps), '-protocol_whitelist', 'file', '-i', canonical, '-map', '0:0', '-an', '-sn', '-dn',
    '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-bf', '0', '-threads', '1', '-filter_threads', '1',
    '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
  return ['-v', 'error', ...input, '-show_streams', '-show_frames', '-show_entries',
    'stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,time_base:frame=stream_index,pts,duration,width,height,pix_fmt', '-of', 'json', proxy];
}

export interface LegacyVideoPrepared { map: LegacyPreparedVideoMap; rgba: Buffer; proxy: Buffer }
export interface ProductionVideoPrepared { map: ProductionPreparedVideoMap; files: { canonical: string; proxy: string; audio: string | null } }
export async function prepareVideoInput(source: string, value: LegacyVideoPreparationRequest, context: VideoPreparationContext): Promise<LegacyVideoPrepared>;
export async function prepareVideoInput(source: string, value: ProductionVideoPreparationRequest, context: VideoPreparationContext): Promise<ProductionVideoPrepared>;
export async function prepareVideoInput(source: string, value: VideoPreparationRequest, context: VideoPreparationContext): Promise<LegacyVideoPrepared | ProductionVideoPrepared>;
export async function prepareVideoInput(source: string, value: VideoPreparationRequest, context: VideoPreparationContext): Promise<LegacyVideoPrepared | ProductionVideoPrepared> {
  const request = validateVideoPreparationRequest(value);
  if (request.version === '0.1' && 'version' in context.limits) throw Error('VIDEO_LEGACY_POLICY_INVALID');
  return request.version === '0.2' ? prepareProductionVideoInput(source, request, context) : prepareLegacyVideoInput(source, request, context);
}
async function prepareLegacyVideoInput(source: string, value: LegacyVideoPreparationRequest, context: VideoPreparationContext): Promise<LegacyVideoPrepared> {
  const request = structuredClone(validateVideoPreparationRequest(value)) as LegacyVideoPreparationRequest, limits = structuredClone(videoPreparationLimits(context.limits)) as VideoPreparationLimits;
  const files = new NodeImportFiles(context.projectDir), started = performance.now(), frozen = JSON.stringify({ value, limits: context.limits });
  const check = () => { context.signal?.throwIfAborted(); context.check(); if (performance.now() - started > limits.maxElapsedMs) throw Error('VIDEO_ELAPSED_LIMIT');
    if (JSON.stringify({ value, limits: context.limits }) !== frozen) throw Error('VIDEO_INPUT_CHANGED'); };
  check(); files.projectPath(source); files.projectPath(context.temporaryDir);
  const originalNode = await files.inspect(source), original = await readFixed(source, limits.maxSourceBytes, context.signal);
  if (original.sha256 !== request.byteSha256) throw Error('VIDEO_SOURCE_CHANGED');
  const structure = preflightVideoSource(original.data, request.streamIndex, limits);
  if (structure.timeBase !== request.sourceRange.timeBase) throw Error('VIDEO_SOURCE_TIME_BASE_INVALID');
  const scale = Math.min(1, limits.maxProxyEdge / Math.max(structure.width, structure.height));
  const width = Math.floor(structure.width * scale / 2) * 2, height = Math.floor(structure.height * scale / 2) * 2, frameBytes = width * height * 4;
  if (!width || !height || frameBytes * structure.pts.length > limits.maxRgbaBytes) throw Error('VIDEO_RGBA_LIMIT');
  const sourceFrames = structure.pts.map((pts, i) => ({ pts, duration: structure.durations[i]!, rgbaSha256: '0'.repeat(64) }));
  const indices = videoFrameSourceIndices(sourceFrames, request.sourceRange, request.fps);
  if (indices.length > limits.maxProxyFrames || indices.length * frameBytes > limits.maxRgbaBytes) throw Error('VIDEO_RGBA_LIMIT');
  const runtime = validateAudioInputRuntime(audioInputRuntimeIdentity()), runtimeIdentity = JSON.stringify(runtime);
  await files.ensureDirectory(context.temporaryDir); const cwd = files.projectPath(join(context.temporaryDir, `video-${randomUUID()}`)); await mkdir(cwd, { mode: 0o700 });
  const canonicalPath = join(cwd, 'frames.rgba'), proxyPath = join(cwd, 'proxy.mp4');
  async function unchanged() { check(); const current = await readFixed(source, limits.maxSourceBytes, context.signal, undefined, false);
    if (current.bytes !== original.bytes || current.sha256 !== original.sha256 || !sameImportNode(originalNode, await files.inspect(source))) throw Error('VIDEO_SOURCE_CHANGED');
    if (JSON.stringify(audioInputRuntimeIdentity()) !== runtimeIdentity) throw Error('VIDEO_RUNTIME_CHANGED'); check(); }
  async function write(path: string, data: Buffer) { const fd = await open(files.projectPath(path), 'wx', 0o600);
    try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); } }
  async function tool(role: 'probe' | 'decode' | 'encode' | 'proxyProbe', maximum?: number) {
    check(); const chunks: Buffer[] = [], native = runtime.tools[role === 'probe' || role === 'proxyProbe' ? 'ffprobe' : 'ffmpeg'];
    const argv = videoPreparationArguments(role, source, request, width, height, indices.length, canonicalPath, proxyPath);
    const run = await runInspectionTool({ executable: native.executable, version: native.version, argv, cwd,
      policy: { ...DEFAULT_INSPECT_POLICY, maxToolOutputBytes: limits.maxProbeBytes, maxToolElapsedMs: Math.min(limits.maxToolElapsedMs, Math.max(1, Math.floor(limits.maxElapsedMs - (performance.now() - started)))) },
      signal: context.signal, binaryLimit: maximum, ...(maximum === undefined ? {} : { binary: async chunk => { check(); chunks.push(Buffer.from(chunk)); } }), onRun: context.onTool });
    if (run.error) throw Error('VIDEO_TOOL_FAILED: ' + run.error); await unchanged();
    return { run, data: maximum === undefined ? Buffer.from(run.stdout) : Buffer.concat(chunks) };
  }
  try {
    await unchanged(); const probe = await tool('probe'), raw = JSON.parse(probe.data.toString('utf8')), stream = raw.streams?.[0];
    const frames = raw.frames ?? raw.packets_and_frames?.filter((entry: any) => entry.type === 'frame'), packets = raw.packets ?? raw.packets_and_frames?.filter((entry: any) => entry.type === 'packet');
    if (raw.streams?.length !== 1 || stream?.index !== request.streamIndex || stream.codec_type !== 'video' || stream.codec_name !== 'h264' ||
        stream.width !== structure.width || stream.height !== structure.height || stream.pix_fmt !== 'yuv420p' || stream.time_base !== structure.timeBase ||
        ![undefined, 'unknown', 'progressive'].includes(stream.field_order) || ![undefined, 'unknown', 'bt709', 'smpte170m', 'gamma22', 'gamma28'].includes(stream.color_transfer) ||
        ![undefined, 'unknown', 'bt709', 'bt470bg', 'smpte170m', 'smpte240m'].includes(stream.color_primaries) ||
        ![undefined, '0:1', '1:1'].includes(stream.sample_aspect_ratio) || stream.side_data_list?.some((entry: any) => entry.rotation !== undefined && entry.rotation !== 0) ||
        !Array.isArray(frames) || frames.length !== structure.pts.length || !Array.isArray(packets) || packets.length !== structure.packets.length) throw Error('VIDEO_PROBE_INVALID');
    for (const [i, frame] of frames.entries()) if (frame.stream_index !== request.streamIndex || String(frame.pts) !== structure.pts[i] ||
        String(frame.best_effort_timestamp) !== structure.pts[i] || frame.width !== structure.width || frame.height !== structure.height || frame.pix_fmt !== 'yuv420p' ||
        (frame.duration === undefined ? null : String(frame.duration)) !== structure.durations[i]) throw Error('VIDEO_SOURCE_FRAME_ORACLE_INVALID');
    for (const [i, packet] of packets.entries()) if (packet.stream_index !== request.streamIndex || Number(packet.pos) !== structure.packets[i]!.position || Number(packet.size) !== structure.packets[i]!.bytes) throw Error('VIDEO_SOURCE_PACKET_ORACLE_INVALID');
    const decoded = await tool('decode', structure.pts.length * frameBytes);
    const observed = Array.from(decoded.run.stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/g));
    if (decoded.data.length !== structure.pts.length * frameBytes || observed.length !== structure.pts.length ||
        !decoded.run.stderr.includes(`config in time_base: ${structure.timeBase}`) ||
        observed.some((entry, i) => Number(entry[1]) !== i || entry[2] !== structure.pts[i])) throw Error('VIDEO_DECODE_ORACLE_INVALID');
    for (const [i, frame] of sourceFrames.entries()) frame.rgbaSha256 = hash(decoded.data.subarray(i * frameBytes, (i + 1) * frameBytes));
    const rgba = Buffer.alloc(indices.length * frameBytes);
    for (const [i, sourceIndex] of indices.entries()) decoded.data.copy(rgba, i * frameBytes, sourceIndex * frameBytes, (sourceIndex + 1) * frameBytes);
    await write(canonicalPath, rgba); const canonicalNode = await files.inspect(canonicalPath), encode = await tool('encode', limits.maxProxyBytes);
    const afterCanonical = await readFixed(canonicalPath, limits.maxRgbaBytes, context.signal, undefined, false);
    if (!sameImportNode(canonicalNode, await files.inspect(canonicalPath)) || afterCanonical.sha256 !== hash(rgba)) throw Error('VIDEO_CANONICAL_CHANGED');
    if (!encode.data.length) throw Error('VIDEO_PROXY_INVALID'); await write(proxyPath, encode.data);
    const proxyNode = await files.inspect(proxyPath), proxyProbe = await tool('proxyProbe'), proxyRaw = JSON.parse(proxyProbe.data.toString('utf8')), proxyStream = proxyRaw.streams?.[0];
    const [num, den] = String(proxyStream?.time_base).split('/').map(Number), ticks = den! / (num! * request.fps);
    if (proxyRaw.streams?.length !== 1 || proxyStream.codec_type !== 'video' || proxyStream.codec_name !== 'h264' ||
        proxyStream.width !== width || proxyStream.height !== height || proxyStream.r_frame_rate !== `${request.fps}/1` || proxyStream.avg_frame_rate !== `${request.fps}/1` ||
        !Number.isSafeInteger(ticks) || ticks <= 0 || proxyRaw.frames?.length !== indices.length ||
        proxyRaw.frames.some((frame: any, i: number) => frame.stream_index !== 0 || frame.pts !== i * ticks || frame.duration !== ticks || frame.width !== width || frame.height !== height)) throw Error('VIDEO_PROXY_ORACLE_INVALID');
    const afterProxy = await readFixed(proxyPath, limits.maxProxyBytes, context.signal, undefined, false);
    if (!sameImportNode(proxyNode, await files.inspect(proxyPath)) || afterProxy.sha256 !== hash(encode.data)) throw Error('VIDEO_PROXY_CHANGED');
    const map: LegacyPreparedVideoMap = { version: '0.1', kind: 'prepared-video-map', mapperVersion: VIDEO_PREPARATION_VERSION,
      request, limits, policySha256: hash(JSON.stringify(limits)), source: { bytes: original.bytes, sha256: original.sha256 }, runtime,
      sourceVideo: { streamIndex: request.streamIndex, codec: 'h264', timeBase: structure.timeBase, width: structure.width, height: structure.height, pixelFormat: 'yuv420p', rotation: 0, sourceFrames },
      canonical: { path: `${context.publishedDir}/frames.rgba`, bytes: rgba.length, sha256: hash(rgba), width, height, fps: request.fps, frames: indices.length },
      proxy: { path: `${context.publishedDir}/proxy.mp4`, bytes: encode.data.length, sha256: hash(encode.data) },
      frames: indices.map(sourceIndex => ({ sourceIndex, sourcePts: sourceFrames[sourceIndex]!.pts, rgbaSha256: sourceFrames[sourceIndex]!.rgbaSha256 })),
      commands: { probe: probe.run, decode: decoded.run, encode: encode.run, proxyProbe: proxyProbe.run }, cwd,
      coverage: { scope: 'complete-selected-video-frames', complete: true, startPts: request.sourceRange.startPts, endPts: request.sourceRange.endPts, audio: 'muted' } };
    validatePreparedVideoMap(map, limits); await unchanged(); return { map, rgba, proxy: encode.data };
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

/** Rebuild the source oracle and complete derived bytes; historical cwd/argv remain execution facts after relocation. */
export async function verifyPreparedVideoInput(source: string, value: PreparedVideoMap, context: VideoPreparationContext): Promise<void> {
  if (value.version === '0.2') return verifyProductionVideoInput(source, value, context);
  const map = structuredClone(validatePreparedVideoMap(value, context.limits)) as LegacyPreparedVideoMap, files = new NodeImportFiles(context.projectDir), started = performance.now();
  const frozen = JSON.stringify({ value, limits: context.limits }), check = () => { context.signal?.throwIfAborted(); context.check();
    if (performance.now() - started > map.limits.maxElapsedMs) throw Error('VIDEO_ELAPSED_LIMIT');
    if (JSON.stringify({ value, limits: context.limits }) !== frozen) throw Error('VIDEO_INPUT_CHANGED'); };
  check(); files.projectPath(source); const sourceNode = await files.inspect(source);
  const canonical = files.projectPath(join(context.projectDir, map.canonical.path)), proxy = files.projectPath(join(context.projectDir, map.proxy.path));
  const canonicalNode = await files.inspect(canonical), proxyNode = await files.inspect(proxy);
  const actualRgba = await readFixed(canonical, map.limits.maxRgbaBytes, context.signal), actualProxy = await readFixed(proxy, map.limits.maxProxyBytes, context.signal);
  if (actualRgba.bytes !== map.canonical.bytes || actualRgba.sha256 !== map.canonical.sha256 || actualProxy.bytes !== map.proxy.bytes || actualProxy.sha256 !== map.proxy.sha256) throw Error('VIDEO_DERIVED_CHANGED');
  const native = validateAudioInputRuntime(audioInputRuntimeIdentity()); if (JSON.stringify(native) !== JSON.stringify(map.runtime)) throw Error('VIDEO_RUNTIME_CHANGED');
  for (const role of ['probe', 'decode', 'encode', 'proxyProbe'] as const) {
    const run = map.commands[role], program = native.tools[role === 'probe' || role === 'proxyProbe' ? 'ffprobe' : 'ffmpeg'];
    const historicalSource = map.commands.probe.argv.at(-1)!;
    if (!map.cwd.startsWith('/') || map.cwd.includes('\0') || !historicalSource.startsWith('/') || run.executable !== program.executable || run.version !== program.version ||
        JSON.stringify(run.argv) !== JSON.stringify(videoPreparationArguments(role, historicalSource, map.request, map.canonical.width, map.canonical.height,
          map.canonical.frames, join(map.cwd, 'frames.rgba'), join(map.cwd, 'proxy.mp4'))) ||
        run.binaryBytes !== (role === 'decode' ? map.sourceVideo.sourceFrames.length * map.canonical.width * map.canonical.height * 4 : role === 'encode' ? map.proxy.bytes : 0)) throw Error('VIDEO_COMMAND_BINDING_INVALID');
  }
  const replay = await prepareLegacyVideoInput(source, map.request, { ...context, check, limits: map.limits, publishedDir: map.canonical.path.replace(/\/frames\.rgba$/, '') });
  const pts = Array.from(map.commands.decode.stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/g));
  if (JSON.stringify(replay.map.sourceVideo) !== JSON.stringify(map.sourceVideo) || JSON.stringify(replay.map.frames) !== JSON.stringify(map.frames) ||
      map.commands.probe.stdout !== replay.map.commands.probe.stdout || map.commands.proxyProbe.stdout !== replay.map.commands.proxyProbe.stdout ||
      !map.commands.decode.stderr.includes(`config in time_base: ${map.sourceVideo.timeBase}`) || pts.length !== map.sourceVideo.sourceFrames.length ||
      pts.some((entry, i) => Number(entry[1]) !== i || entry[2] !== map.sourceVideo.sourceFrames[i]!.pts) ||
      !replay.rgba.equals(actualRgba.data) || !replay.proxy.equals(actualProxy.data)) throw Error('VIDEO_REPLAY_INVALID');
  check(); const ffmpeg = native.tools.ffmpeg;
  const decoded = await runInspectionTool({ executable: ffmpeg.executable, version: ffmpeg.version, cwd: files.projectPath(context.temporaryDir),
    argv: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', ...input, '-noautorotate', '-i', proxy, '-map', '0:0', '-an', '-sn', '-dn',
      '-fps_mode', 'passthrough', '-threads', '1', '-filter_threads', '1', '-c:v', 'rawvideo', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
    policy: { ...DEFAULT_INSPECT_POLICY, maxToolOutputBytes: map.limits.maxProbeBytes,
      maxToolElapsedMs: Math.min(map.limits.maxToolElapsedMs, Math.max(1, Math.floor(map.limits.maxElapsedMs - (performance.now() - started)))) },
    signal: context.signal, binaryLimit: map.canonical.bytes, binary: async () => { check(); }, onRun: context.onTool });
  if (decoded.error || decoded.binaryBytes !== map.canonical.bytes) throw Error('VIDEO_PROXY_DECODE_INVALID');
  const afterSource = await readFixed(source, map.limits.maxSourceBytes, context.signal, undefined, false),
    afterCanonical = await readFixed(canonical, map.limits.maxRgbaBytes, context.signal, undefined, false),
    afterProxy = await readFixed(proxy, map.limits.maxProxyBytes, context.signal, undefined, false);
  if (afterSource.sha256 !== map.source.sha256 || afterCanonical.sha256 !== actualRgba.sha256 || afterProxy.sha256 !== actualProxy.sha256 ||
      !sameImportNode(sourceNode, await files.inspect(source)) || !sameImportNode(canonicalNode, await files.inspect(canonical)) ||
      !sameImportNode(proxyNode, await files.inspect(proxy))) throw Error('VIDEO_INPUT_CHANGED');
  if (JSON.stringify(audioInputRuntimeIdentity()) !== JSON.stringify(native)) throw Error('VIDEO_RUNTIME_CHANGED'); check();
}

function resource(resource: string, required: number, available: number, remedy: string): never {
  throw Error(`VIDEO_RESOURCE_LIMIT: ${resource} requires ${required} bytes/entries; available/limit ${available}; ${remedy}`);
}
const nodeIdentity = (s: Awaited<ReturnType<Awaited<ReturnType<typeof open>>['stat']>>) => ({ kind: s.isFile() ? 'file' as const : 'special' as const,
  dev: String(s.dev), ino: String(s.ino), nlink: String(s.nlink), size: Number(s.size), mtimeNs: String(s.mtimeNs), ctimeNs: String(s.ctimeNs) });

/** Full sample-table closure with bounded metadata; mdat bytes are identity-hashed separately. */
export async function preflightVideoFile(source: string, requestedStream: number, context: Pick<VideoPreparationContext, 'projectDir' | 'limits' | 'signal' | 'check'>): Promise<ProductionSourceStructure> {
  const limits = productionVideoPreparationLimits(context.limits), files = new NodeImportFiles(context.projectDir), path = files.projectPath(source), before = await files.inspect(path);
  if (before.kind !== 'file' || before.nlink !== '1' || !before.size) throw Error('VIDEO_SOURCE_INVALID: independent nonempty file required');
  if (before.size > limits.maxSourceBytes) resource('source', before.size, limits.maxSourceBytes, 'adopt a larger source/import/catalog policy or split the original into independently imported segments');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), parts: { start: number; data: Buffer }[] = []; let metadataBytes = 0;
  const check = () => { context.signal?.throwIfAborted(); context.check(); };
  async function read(position: number, bytes: number) {
    check(); const data = Buffer.alloc(bytes); let offset = 0;
    while (offset < bytes) { check(); const result = await handle.read(data, offset, bytes - offset, position + offset); if (!result.bytesRead) throw Error('VIDEO_SOURCE_INVALID: truncated metadata'); offset += result.bytesRead; }
    return data;
  }
  try {
    if (!sameImportNode(before, nodeIdentity(await handle.stat({ bigint: true })))) throw Error('VIDEO_SOURCE_CHANGED');
    for (let position = 0; position < before.size;) {
      if (position + 8 > before.size) throw Error('VIDEO_SOURCE_INVALID: atom header');
      let data = await read(position, 8), bytes = data.readUInt32BE(0), header = 8;
      if (bytes === 1) { if (position + 16 > before.size) throw Error('VIDEO_SOURCE_INVALID: large atom header'); data = await read(position, 16); header = 16;
        const large = data.readBigUInt64BE(8); if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('VIDEO_SOURCE_INVALID: unsafe atom extent'); bytes = Number(large); }
      if (bytes < header || position + bytes > before.size) throw Error('VIDEO_SOURCE_INVALID: atom extent');
      const type = data.toString('latin1', 4, 8), retained = type === 'ftyp' || type === 'moov' ? bytes : header;
      if (metadataBytes + retained > limits.maxMetadataBytes) resource('metadata', metadataBytes + retained, limits.maxMetadataBytes, 'split the original or adopt a larger metadata policy');
      if (metadataBytes + retained + (parts.length + 1) * 128 > limits.maxResidentBytes) resource('metadata resident working set', metadataBytes + retained + (parts.length + 1) * 128, limits.maxResidentBytes, 'split the original or adopt a larger resident policy');
      if (parts.length + 1 > limits.maxStructureEntries) resource('atom entries', parts.length + 1, limits.maxStructureEntries, 'split the original or adopt a larger structure policy');
      if (retained !== header) data = await read(position, retained); parts.push({ start: position, data }); metadataBytes += retained; position += bytes;
    }
    function slice(position: number, length: number) {
      check(); if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || length < 0) throw Error('VIDEO_SOURCE_INVALID: metadata extent');
      let left = 0, right = parts.length;
      while (left < right) { const middle = (left + right) >>> 1; if (parts[middle]!.start <= position) left = middle + 1; else right = middle; }
      const part = parts[left - 1]; if (!part || position + length > part.start + part.data.length) throw Error('VIDEO_SOURCE_INVALID: metadata outside retained atoms');
      return part.data.subarray(position - part.start, position - part.start + length);
    }
    const methods = { length: before.size, readUInt32BE: (p: number) => slice(p, 4).readUInt32BE(0), readUInt16BE: (p: number) => slice(p, 2).readUInt16BE(0),
      readUIntBE: (p: number, n: number) => slice(p, n).readUIntBE(0, n), readBigUInt64BE: (p: number) => slice(p, 8).readBigUInt64BE(0),
      readInt32BE: (p: number) => slice(p, 4).readInt32BE(0), readInt16BE: (p: number) => slice(p, 2).readInt16BE(0),
      toString: (encoding: BufferEncoding, start: number, end: number) => slice(start, end - start).toString(encoding) };
    const view = new Proxy(methods, { get: (target, key) => typeof key === 'string' && /^\d+$/.test(key) ? slice(Number(key), 1)[0] : Reflect.get(target, key) }) as unknown as Buffer;
    let residentBytes = metadataBytes;
    const structure = sourceStructure(view, requestedStream, { ...limits, maxSourceFrames: Number.MAX_SAFE_INTEGER, maxDurationMs: Number.MAX_SAFE_INTEGER, maxProxyFrames: Number.MAX_SAFE_INTEGER }, true,
      entries => { check(); residentBytes = metadataBytes + entries * 512; if (residentBytes > limits.maxResidentBytes) resource('expanded metadata working set', residentBytes, limits.maxResidentBytes, 'split the original or adopt a larger resident/metadata policy'); }) as ProductionSourceStructure;
    if (!sameImportNode(before, nodeIdentity(await handle.stat({ bigint: true }))) || !sameImportNode(before, await files.inspect(path))) throw Error('VIDEO_SOURCE_CHANGED');
    return { ...structure, residentBytes };
  } finally { await handle.close(); }
}

function seconds(pts: string, timeBase: string): string {
  const [num, den] = timeBase.split('/').map(BigInt), value = BigInt(pts) * num! * 1000000000n / den!, positive = value < 0n ? -value : value;
  return (value < 0n ? '-' : '') + String(positive / 1000000000n) + '.' + String(positive % 1000000000n).padStart(9, '0');
}
function wavHeader(samples: number): Buffer {
  const bytes = samples * 4; if (!Number.isSafeInteger(bytes) || bytes + 36 > 0xffffffff) resource('classic WAV bytes', bytes + 44, 0xffffffff + 8, 'shorten the range or prepare separate audio segments');
  const h = Buffer.alloc(44); h.write('RIFF'); h.writeUInt32LE(bytes + 36, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22); h.writeUInt32LE(48000, 24); h.writeUInt32LE(192000, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(bytes, 40); return h;
}

async function prepareProductionVideoInput(source: string, value: ProductionVideoPreparationRequest, context: VideoPreparationContext): Promise<ProductionVideoPrepared> {
  const request = structuredClone(value), limits = structuredClone(productionVideoPreparationLimits(context.limits)), files = new NodeImportFiles(context.projectDir), started = performance.now();
  const frozen = JSON.stringify({ value, limits: context.limits }), check = () => { context.signal?.throwIfAborted(); context.check();
    if (performance.now() - started > limits.maxElapsedMs) throw Error(`VIDEO_ELAPSED_LIMIT: elapsed ${Math.ceil(performance.now() - started)}ms; limit ${limits.maxElapsedMs}ms; shorten/split the selection or adopt a larger elapsed budget`);
    if (JSON.stringify({ value, limits: context.limits }) !== frozen) throw Error('VIDEO_INPUT_CHANGED'); };
  check(); files.projectPath(source); files.projectPath(context.temporaryDir); const sourceNode = await files.inspect(source);
  if (sourceNode.size > limits.maxSourceBytes) resource('source', sourceNode.size, limits.maxSourceBytes, 'adopt a larger source/import/catalog policy or split the original');
  const original = await readFixed(source, limits.maxSourceBytes, context.signal, () => check(), false);
  if (original.sha256 !== request.byteSha256) throw Error('VIDEO_SOURCE_CHANGED');
  const structure = await preflightVideoFile(source, request.streamIndex, { ...context, limits, check });
  if (structure.timeBase !== request.sourceRange.timeBase) throw Error('VIDEO_SOURCE_TIME_BASE_INVALID');
  const width = request.output.width ?? structure.width, height = request.output.height ?? structure.height, frameBytes = width * height * 4;
  if (!width || !height || width % 2 || height % 2 || width > structure.width || height > structure.height || width * structure.height !== height * structure.width) throw Error('VIDEO_OUTPUT_SIZE_INVALID');
  if (!Number.isSafeInteger(frameBytes) || frameBytes * 2 > limits.maxResidentBytes) resource('frame working set', frameBytes * 2, limits.maxResidentBytes, 'request explicit smaller delivery dimensions or adopt a larger resident policy');
  const fullEnd = String(BigInt(structure.pts.at(-1)!) + BigInt(structure.durations.at(-1) ?? '0'));
  const start = BigInt(request.sourceRange.startPts), end = BigInt(request.sourceRange.endPts);
  if (start < BigInt(structure.pts[0]!) || end > BigInt(fullEnd)) throw Error('VIDEO_SOURCE_FRAMES_INVALID');
  let first = 0; while (first + 1 < structure.pts.length && BigInt(structure.pts[first + 1]!) <= start) first++;
  let last = first + 1; while (last < structure.pts.length && BigInt(structure.pts[last]!) < end) last++;
  const [num, den] = structure.timeBase.split('/').map(BigInt), frameCount = ((end - start) * num! * BigInt(request.fps) + den! - 1n) / den!;
  if (frameCount > BigInt(Math.floor(limits.maxRgbaBytes / frameBytes))) resource('selected RGBA', Number(frameCount) * frameBytes, limits.maxRgbaBytes, 'shorten/split the range or adopt a larger disk cache policy');
  const selectedWorkingBytes = frameCount * 120n + BigInt(last - first) * 160n;
  if (selectedWorkingBytes > BigInt(limits.maxMapBytes)) resource('selected frame map', Number(selectedWorkingBytes), limits.maxMapBytes, 'shorten/split the range or adopt a larger map policy');
  const resident = BigInt(structure.residentBytes) + selectedWorkingBytes + BigInt(frameBytes * 2);
  if (resident > BigInt(limits.maxResidentBytes)) resource('metadata, selected map and two-frame working set', Number(resident), limits.maxResidentBytes, 'shorten/split the source/selection, request smaller delivery dimensions, or adopt a larger resident policy');
  const sourceFrames = structure.pts.slice(first, last).map((pts, i) => ({ pts, duration: structure.durations[first + i]!, rgbaSha256: '0'.repeat(64) }));
  const indices = videoFrameSourceIndices(sourceFrames, request.sourceRange, request.fps, Math.floor(limits.maxRgbaBytes / frameBytes), fullEnd);
  const canonicalBytes = indices.length * frameBytes, scale = Math.min(1, limits.maxProxyEdge / Math.max(width, height)), proxyWidth = Math.floor(width * scale / 2) * 2, proxyHeight = Math.floor(height * scale / 2) * 2;
  if (!proxyWidth || !proxyHeight) throw Error('VIDEO_PROXY_SIZE_INVALID');
  const runtime = validateAudioInputRuntime(audioInputRuntimeIdentity()), frozenRuntime = JSON.stringify(runtime);
  await files.ensureDirectory(context.temporaryDir); const cwd = files.projectPath(join(context.temporaryDir, `video-${randomUUID()}`)); await mkdir(cwd, { mode: 0o700 });
  const canonical = join(cwd, 'frames.rgba'), proxy = join(cwd, 'proxy.mp4'), audio = join(cwd, 'source-audio.wav'); let completed = false;
  async function free(needed = 0) { check(); const disk = await statfs(cwd), available = disk.bavail * disk.bsize;
    if (available < needed + limits.minFreeBytes) resource('temporary disk', needed + limits.minFreeBytes, available, 'free the reported difference, select a shorter range, or use a temporary filesystem with more space'); }
  async function unchanged() { check(); const after = await readFixed(source, limits.maxSourceBytes, context.signal, () => check(), false);
    if (after.bytes !== original.bytes || after.sha256 !== original.sha256 || !sameImportNode(sourceNode, await files.inspect(source))) throw Error('VIDEO_SOURCE_CHANGED');
    if (JSON.stringify(audioInputRuntimeIdentity()) !== frozenRuntime) throw Error('VIDEO_RUNTIME_CHANGED'); }
  async function tool(role: keyof ProductionPreparedVideoMap['commands'], argv: string[], binary?: (chunk: Buffer) => Promise<void>, binaryLimit?: number) {
    check(); const native = runtime.tools[role === 'probe' || role === 'proxyProbe' ? 'ffprobe' : 'ffmpeg'];
    const run = await runInspectionTool({ executable: native.executable, version: native.version, argv, cwd, signal: context.signal, binary, binaryLimit,
      policy: { ...DEFAULT_INSPECT_POLICY, maxToolOutputBytes: limits.maxProbeBytes, maxToolElapsedMs: Math.min(limits.maxToolElapsedMs, Math.max(1, Math.floor(limits.maxElapsedMs - (performance.now() - started)))) }, onRun: context.onTool });
    if (run.error) throw Error('VIDEO_TOOL_FAILED: ' + run.error + '; check actual stderr; shorten/split the selection or increase the relevant explicit resource budget');
    await unchanged(); return run;
  }
  async function write(handle: Awaited<ReturnType<typeof open>>, data: Buffer) { check(); let offset = 0;
    while (offset < data.length) { const { bytesWritten } = await handle.write(data, offset, data.length - offset, null); if (!bytesWritten) throw Error('VIDEO_FILE_WRITE_FAILED'); offset += bytesWritten; } }
  async function streamFile(path: string, role: 'encode' | 'audio', argv: string[], maximum: number, prefix?: Buffer) {
    const handle = await open(files.projectPath(path), 'wx', 0o600); let count = 0;
    try { if (prefix) await write(handle, prefix); const run = await tool(role, argv, async chunk => { if (!count || Math.floor(count / 1048576) !== Math.floor((count + chunk.length) / 1048576)) await free(chunk.length); await write(handle, chunk); count += chunk.length; }, maximum);
      await handle.sync(); return { run, count }; } finally { await handle.close(); }
  }
  try {
    const probe = await tool('probe', ['-v', 'error', ...input, '-show_streams', '-show_entries',
      'stream=index,codec_type,codec_name,profile,width,height,pix_fmt,time_base,start_pts,duration_ts,sample_rate,channels,field_order,color_transfer,color_primaries,sample_aspect_ratio:stream_side_data=rotation', '-of', 'json', source]);
    const raw = JSON.parse(probe.stdout), video = raw.streams?.find((s: any) => s.index === request.streamIndex), sourceAudioRaw = raw.streams?.find((s: any) => s.codec_type === 'audio');
    if (raw.streams?.length !== (structure.audio ? 2 : 1) || video?.codec_type !== 'video' || video.codec_name !== 'h264' || video.pix_fmt !== 'yuv420p' || video.time_base !== structure.timeBase ||
        video.width !== structure.width || video.height !== structure.height || ![undefined, 'unknown', 'progressive'].includes(video.field_order) ||
        ![undefined, 'unknown', 'bt709', 'smpte170m', 'gamma22', 'gamma28'].includes(video.color_transfer) || ![undefined, 'unknown', 'bt709', 'bt470bg', 'smpte170m', 'smpte240m'].includes(video.color_primaries) ||
        ![undefined, '0:1', '1:1'].includes(video.sample_aspect_ratio) || video.side_data_list?.some((s: any) => s.rotation !== undefined && s.rotation !== 0)) throw Error('VIDEO_PROBE_INVALID');
    let sourceAudio: ProductionPreparedVideoMap['sourceAudio'] = null;
    if (structure.audio) {
      const a = structure.audio, duration = sourceAudioRaw?.duration_ts;
      if (sourceAudioRaw?.index !== a.streamIndex || sourceAudioRaw.codec_name !== 'aac' || sourceAudioRaw.profile !== 'LC' || sourceAudioRaw.time_base !== a.timeBase || String(sourceAudioRaw.start_pts) !== a.startPts ||
          Number(sourceAudioRaw.sample_rate) !== a.sampleRate || sourceAudioRaw.channels !== a.channels || duration !== undefined && (!Number.isSafeInteger(duration) || duration <= 0 || BigInt(duration) > BigInt(a.maximumDuration))) throw Error('VIDEO_AUDIO_SOURCE_ORACLE_INVALID');
      sourceAudio = { streamIndex: a.streamIndex, codec: 'aac', timeBase: a.timeBase, startPts: String(sourceAudioRaw.start_pts), durationPts: duration === undefined ? null : String(duration), sampleRate: a.sampleRate, channels: a.channels };
    }
    const samples = !request.mute && sourceAudio ? videoAudioSamples(request.sourceRange) : 0, header = samples ? wavHeader(samples) : null;
    if (samples && 44 + samples * 4 > limits.maxAudioBytes) resource('selected audio', 44 + samples * 4, limits.maxAudioBytes, 'shorten/split the range or adopt a larger audio policy');
    await free(canonicalBytes + (samples ? 44 + samples * 4 : 0));
    let seek = structure.seekPts.filter(pts => BigInt(pts) <= BigInt(sourceFrames[0]!.pts)).at(-1) ?? structure.pts[0]!;
    const seekInput = ['-copyts', '-ss', seconds(seek, structure.timeBase), '-seek_timestamp', '1', '-noaccurate_seek', '-noautorotate', '-i', source];
    const handle = await open(canonical, 'wx', 0o600), frame = Buffer.alloc(frameBytes); let offset = 0, ordinal = 0, outputIndex = 0;
    let decode: ToolRun;
    try {
      decode = await tool('decode', ['-nostdin', '-hide_banner', '-loglevel', 'info', '-xerror', ...input, ...seekInput, '-map', `0:${request.streamIndex}`, '-an', '-sn', '-dn',
        '-vf', `select='gte(pts,${sourceFrames[0]!.pts})*lt(pts,${request.sourceRange.endPts})',scale=${width}:${height}:flags=bilinear,format=rgba,showinfo`,
        '-frames:v', String(sourceFrames.length), '-fps_mode', 'passthrough', '-threads', '1', '-filter_threads', '1', '-c:v', 'rawvideo', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'], async chunk => {
        for (let position = 0; position < chunk.length;) { check(); const amount = Math.min(frameBytes - offset, chunk.length - position); chunk.copy(frame, offset, position, position + amount); offset += amount; position += amount;
          if (offset === frameBytes) { if (ordinal >= sourceFrames.length) throw Error('VIDEO_DECODE_ORACLE_INVALID'); sourceFrames[ordinal]!.rgbaSha256 = hash(frame);
            while (indices[outputIndex] === ordinal) { await free(frameBytes); await write(handle, frame); outputIndex++; } ordinal++; offset = 0; }
        }
      }, sourceFrames.length * frameBytes);
      await handle.sync();
    } finally { await handle.close(); }
    const observed = Array.from(decode.stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/g));
    if (offset || ordinal !== sourceFrames.length || outputIndex !== indices.length || decode.binaryBytes !== sourceFrames.length * frameBytes ||
        observed.length !== sourceFrames.length || !decode.stderr.includes(`config in time_base: ${structure.timeBase}`) || observed.some((entry, i) => Number(entry[1]) !== i || entry[2] !== sourceFrames[i]!.pts)) throw Error('VIDEO_DECODE_ORACLE_INVALID');
    const canonicalIdentity = await readFixed(canonical, limits.maxRgbaBytes, context.signal, () => check(), false);
    const encode = await streamFile(proxy, 'encode', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-max_alloc', '67108864', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(request.fps),
      '-protocol_whitelist', 'file', '-i', canonical, '-map', '0:0', '-an', '-sn', '-dn', '-vf', `scale=${proxyWidth}:${proxyHeight}:flags=bilinear`, '-frames:v', String(indices.length),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-bf', '0', '-threads', '1', '-filter_threads', '1', '-pix_fmt', 'yuv420p', '-map_metadata', '-1', '-map_chapters', '-1',
      '-fflags', '+bitexact', '-flags:v', '+bitexact', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'], limits.maxProxyBytes);
    if (!encode.count) throw Error('VIDEO_PROXY_INVALID');
    const proxyProbe = await tool('proxyProbe', ['-v', 'error', ...input, '-show_streams', '-show_frames', '-show_entries',
      'stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,time_base:frame=stream_index,pts,duration,width,height,pix_fmt', '-of', 'json', proxy]);
    const proxyRaw = JSON.parse(proxyProbe.stdout), ps = proxyRaw.streams?.[0], [pn, pd] = String(ps?.time_base).split('/').map(Number), ticks = pd! / (pn! * request.fps);
    if (proxyRaw.streams?.length !== 1 || ps?.codec_type !== 'video' || ps.codec_name !== 'h264' || ps.width !== proxyWidth || ps.height !== proxyHeight || ps.r_frame_rate !== `${request.fps}/1` || ps.avg_frame_rate !== `${request.fps}/1` ||
        !Number.isSafeInteger(ticks) || ticks <= 0 || proxyRaw.frames?.length !== indices.length || proxyRaw.frames.some((f: any, i: number) => f.stream_index !== 0 || f.pts !== i * ticks || f.duration !== ticks || f.width !== proxyWidth || f.height !== proxyHeight)) throw Error('VIDEO_PROXY_ORACLE_INVALID');
    const proxyIdentity = await readFixed(proxy, limits.maxProxyBytes, context.signal, () => check(), false); let audioIdentity: ProductionPreparedVideoMap['audio'] = null, audioRun: ToolRun | null = null;
    if (header && sourceAudio) {
      const t0 = seconds(request.sourceRange.startPts, structure.timeBase), t1 = seconds(request.sourceRange.endPts, structure.timeBase);
      // AAC overlap and resampler history need preroll before the first retained sample.
      const before = BigInt(sourceFrames[0]!.pts) - (den! + num! - 1n) / num!, audioSeek = structure.seekPts.filter(pts => BigInt(pts) <= before).at(-1) ?? structure.pts[0]!,
        audioInput = ['-copyts', '-ss', seconds(audioSeek, structure.timeBase), '-seek_timestamp', '1', '-noaccurate_seek', '-noautorotate', '-i', source];
      const result = await streamFile(audio, 'audio', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', ...input, ...audioInput, '-map', `0:${sourceAudio.streamIndex}`, '-vn', '-sn', '-dn',
        '-af', `aresample=48000:async=0:dither_method=none,atrim=start=${t0}:end=${t1},asetpts=PTS-(${t0})/TB,aresample=48000:async=0:first_pts=0:dither_method=none,aformat=sample_fmts=s16:channel_layouts=stereo,apad,atrim=end_sample=${samples}`,
        '-ac', '2', '-ar', '48000', '-threads', '1', '-filter_threads', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'], samples * 4, header);
      if (result.count !== samples * 4) throw Error('VIDEO_AUDIO_SAMPLE_ORACLE_INVALID'); audioRun = result.run;
      const identity = await readFixed(audio, limits.maxAudioBytes, context.signal, () => check(), false); audioIdentity = { path: `${context.publishedDir}/source-audio.wav`, bytes: identity.bytes, sha256: identity.sha256, sampleRate: 48000, channels: 2, samples };
    }
    const map: ProductionPreparedVideoMap = { version: '0.2', kind: 'prepared-video-map', mapperVersion: PRODUCTION_VIDEO_PREPARATION_VERSION, request, limits, policySha256: hash(JSON.stringify(limits)),
      source: { bytes: original.bytes, sha256: original.sha256 }, runtime,
      sourceVideo: { streamIndex: request.streamIndex, codec: 'h264', timeBase: structure.timeBase, width: structure.width, height: structure.height, pixelFormat: 'yuv420p', rotation: 0,
        sourceFrameCount: structure.pts.length, startPts: structure.pts[0]!, endPts: fullEnd, sourceFrames }, sourceAudio,
      canonical: { path: `${context.publishedDir}/frames.rgba`, bytes: canonicalIdentity.bytes, sha256: canonicalIdentity.sha256, width, height, fps: request.fps, frames: indices.length },
      proxy: { path: `${context.publishedDir}/proxy.mp4`, bytes: proxyIdentity.bytes, sha256: proxyIdentity.sha256, width: proxyWidth, height: proxyHeight }, audio: audioIdentity,
      frames: indices.map(sourceIndex => ({ sourceIndex, sourcePts: sourceFrames[sourceIndex]!.pts, rgbaSha256: sourceFrames[sourceIndex]!.rgbaSha256 })),
      commands: { probe, decode, encode: encode.run, proxyProbe, audio: audioRun }, cwd, coverage: { scope: 'complete-selected-video-frames', complete: true,
        startPts: request.sourceRange.startPts, endPts: request.sourceRange.endPts, audio: !sourceAudio ? 'absent' : request.mute ? 'muted' : 'preserved' } };
    validatePreparedVideoMap(map, limits); await unchanged();
    for (const [path, identity] of [[canonical, map.canonical], [proxy, map.proxy], ...(map.audio ? [[audio, map.audio]] : [])] as const) {
      const after = await readFixed(path, identity.bytes, context.signal, () => check(), false);
      if (after.bytes !== identity.bytes || after.sha256 !== identity.sha256) throw Error('VIDEO_DERIVED_CHANGED');
    }
    completed = true; return { map, files: { canonical, proxy, audio: audioIdentity ? audio : null } };
  } finally { if (!completed) await rm(cwd, { recursive: true, force: true }); }
}

async function verifyProductionVideoInput(source: string, value: ProductionPreparedVideoMap, context: VideoPreparationContext): Promise<void> {
  const map = structuredClone(validatePreparedVideoMap(value, context.limits)) as ProductionPreparedVideoMap, files = new NodeImportFiles(context.projectDir), identities = [map.canonical, map.proxy, ...(map.audio ? [map.audio] : [])], started = performance.now();
  const frozen = JSON.stringify({ value, limits: context.limits }), check = () => { context.signal?.throwIfAborted(); context.check();
    if (performance.now() - started > map.limits.maxElapsedMs) throw Error(`VIDEO_ELAPSED_LIMIT: elapsed ${Math.ceil(performance.now() - started)}ms; limit ${map.limits.maxElapsedMs}ms; shorten/split the selection or adopt a larger elapsed budget`);
    if (JSON.stringify({ value, limits: context.limits }) !== frozen) throw Error('VIDEO_INPUT_CHANGED'); };
  check();
  const originalNodes = new Map<string, Awaited<ReturnType<typeof files.inspect>>>();
  for (const identity of identities) { const path = files.projectPath(join(context.projectDir, identity.path)); originalNodes.set(path, await files.inspect(path));
    const actual = await readFixed(path, identity.bytes, context.signal, () => check(), false); if (actual.bytes !== identity.bytes || actual.sha256 !== identity.sha256) throw Error('VIDEO_DERIVED_CHANGED'); }
  const sourceNode = await files.inspect(source), replay = await prepareProductionVideoInput(source, map.request, { ...context, check, limits: map.limits, publishedDir: map.canonical.path.replace(/\/frames\.rgba$/, '') });
  try {
    const native = validateAudioInputRuntime(audioInputRuntimeIdentity()); if (JSON.stringify(native) !== JSON.stringify(map.runtime)) throw Error('VIDEO_RUNTIME_CHANGED');
    const historicalSource = map.commands.probe.argv.at(-1)!;
    if (!map.cwd.startsWith('/') || map.cwd.includes('\0') || !historicalSource.startsWith('/') || historicalSource.includes('\0')) throw Error('VIDEO_COMMAND_BINDING_INVALID');
    for (const role of ['probe', 'decode', 'encode', 'proxyProbe', 'audio'] as const) {
      const actual = map.commands[role], rerun = replay.map.commands[role]; if ((actual === null) !== (rerun === null)) throw Error('VIDEO_COMMAND_BINDING_INVALID'); if (!actual || !rerun) continue;
      const program = native.tools[role === 'probe' || role === 'proxyProbe' ? 'ffprobe' : 'ffmpeg'];
      const argv = rerun.argv.map(arg => arg === source ? historicalSource : arg.startsWith(replay.map.cwd + '/') ? map.cwd + arg.slice(replay.map.cwd.length) : arg);
      if (actual.executable !== program.executable || actual.version !== program.version || JSON.stringify(actual.argv) !== JSON.stringify(argv) || actual.binaryBytes !== rerun.binaryBytes) throw Error('VIDEO_COMMAND_BINDING_INVALID');
    }
    for (const key of ['source', 'sourceVideo', 'sourceAudio', 'frames', 'canonical', 'proxy', 'audio', 'coverage'] as const) if (JSON.stringify(map[key]) !== JSON.stringify(replay.map[key])) throw Error('VIDEO_REPLAY_INVALID');
    if (map.commands.probe.stdout !== replay.map.commands.probe.stdout || map.commands.proxyProbe.stdout !== replay.map.commands.proxyProbe.stdout) throw Error('VIDEO_REPLAY_INVALID');
    const observed = Array.from(map.commands.decode.stderr.matchAll(/\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:/g));
    if (observed.length !== map.sourceVideo.sourceFrames.length || !map.commands.decode.stderr.includes(`config in time_base: ${map.sourceVideo.timeBase}`) || observed.some((entry, i) => Number(entry[1]) !== i || entry[2] !== map.sourceVideo.sourceFrames[i]!.pts)) throw Error('VIDEO_REPLAY_INVALID');
    const ffmpeg = native.tools.ffmpeg, proxy = files.projectPath(join(context.projectDir, map.proxy.path));
    const decoded = await runInspectionTool({ executable: ffmpeg.executable, version: ffmpeg.version, cwd: files.projectPath(context.temporaryDir), signal: context.signal,
      argv: ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', ...input, '-noautorotate', '-i', proxy, '-map', '0:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-threads', '1', '-filter_threads', '1', '-c:v', 'rawvideo', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1'],
      binary: async () => { check(); }, binaryLimit: map.proxy.width * map.proxy.height * 4 * map.canonical.frames,
      policy: { ...DEFAULT_INSPECT_POLICY, maxToolOutputBytes: map.limits.maxProbeBytes, maxToolElapsedMs: Math.min(map.limits.maxToolElapsedMs, Math.max(1, Math.floor(map.limits.maxElapsedMs - (performance.now() - started)))) }, onRun: context.onTool });
    if (decoded.error || decoded.binaryBytes !== map.proxy.width * map.proxy.height * 4 * map.canonical.frames) throw Error('VIDEO_PROXY_DECODE_INVALID');
    for (const identity of identities) { const path = files.projectPath(join(context.projectDir, identity.path)), after = await readFixed(path, identity.bytes, context.signal, () => check(), false);
      if (after.sha256 !== identity.sha256 || !sameImportNode(originalNodes.get(path)!, await files.inspect(path))) throw Error('VIDEO_DERIVED_CHANGED'); }
    const after = await readFixed(source, map.limits.maxSourceBytes, context.signal, () => check(), false);
    if (after.sha256 !== map.source.sha256 || !sameImportNode(sourceNode, await files.inspect(source))) throw Error('VIDEO_INPUT_CHANGED');
    if (JSON.stringify(audioInputRuntimeIdentity()) !== JSON.stringify(map.runtime)) throw Error('VIDEO_RUNTIME_CHANGED');
  } finally { await rm(replay.map.cwd, { recursive: true, force: true }); }
}
