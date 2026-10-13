import { createHash } from 'node:crypto';
import { open, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { audioInputLimits, type ToolRun } from '../project/catalog.ts';
import { validateAudioInputFacts, validateAudioInputRuntime, type AudioInputFacts, type AudioInputLimits, type AudioInputRuntimeIdentity } from '../project/audio-input.ts';
import { canonicalWavHeader, DEFAULT_ASR_LIMITS } from '../project/asr.ts';
import { preflightAsrWav } from './asr-wav.ts';
import { NodeImportFiles, sameImportNode } from './import-files.ts';
import { readFixed, runInspectionTool, type InspectContext } from './inspection.ts';

interface Packet { position: number; bytes: number }
interface Structure { facts: AudioInputFacts; packets: Packet[]; waveData?: { position: number; bytes: number } }
const invalid = (message: string): never => { throw Error('AUDIO_INPUT_STRUCTURE_INVALID: ' + message); };
const unsupported = (message: string): never => { throw Error('AUDIO_INPUT_FORMAT_UNSUPPORTED: ' + message); };
const hash = (data: Buffer) => createHash('sha256').update(data).digest('hex');
function facts(format: AudioInputFacts['format'], sampleRate: number, channels: 1 | 2, samples: number, payloadBytes: number, codedFrames: number | null): AudioInputFacts {
  return { version: '0.1', kind: 'audio-input-facts', format, demuxer: format === 'm4a' ? 'mov' : format,
    codec: { wav: 'pcm_s16le', mp3: 'mp3', flac: 'flac', m4a: 'aac' }[format] as AudioInputFacts['codec'],
    sampleRate, channels, bitsPerSample: format === 'wav' || format === 'flac' ? 16 : null,
    samples, sampleDomain: 'complete-decoded-frames', codedFrames, metadataFrames: 0, payloadBytes, gapless: null, edit: null };
}

/** Complete frame/box extents establish the sample oracle independently of FFmpeg. */
function structure(data: Buffer, limits: AudioInputLimits): Structure {
  if (data.length > limits.maxSourceBytes) throw Error('AUDIO_INPUT_SOURCE_LIMIT');
  let entries = 0;
  const count = (n = 1) => { entries += n; if (!Number.isSafeInteger(n) || n < 0 || entries > limits.maxStructureEntries) throw Error('AUDIO_INPUT_STRUCTURE_LIMIT'); };
  function finish(value: Structure) {
    if (value.packets.length > limits.maxPackets) throw Error('AUDIO_INPUT_PACKET_LIMIT');
    validateAudioInputFacts(value.facts, limits); return value;
  }
  if (data.toString('latin1', 0, 4) === 'RIFF') {
    let wave;
    try { wave = preflightAsrWav(data, { ...DEFAULT_ASR_LIMITS, maxAsrSourceBytes: limits.maxSourceBytes, maxAsrRiffChunks: Math.min(limits.maxRiffChunks, limits.maxStructureEntries), minAsrSamples: limits.minSamples, maxAsrSamples: limits.maxSamples }); }
    catch (error) { throw Error((error instanceof Error ? error.message : String(error)).replace(/^ASR_/, 'AUDIO_INPUT_')); }
    return finish({ facts: facts('wav', wave.sampleRate, wave.channels, wave.frames, wave.dataBytes, null), packets: [], waveData: { position: wave.dataOffset, bytes: wave.dataBytes } });
  }
  if (data.toString('latin1', 0, 3) === 'ID3' || data[0] === 255 && (data[1]! & 224) === 224) {
    let position = 0, end = data.length;
    if (data.toString('latin1', 0, 3) === 'ID3') {
      if (data.length < 10) invalid('ID3 header');
      if (![3, 4].includes(data[3]!) || data[4] !== 0 || data[5] !== 0) unsupported('plain ID3v2.3/2.4 required');
      let bytes = 0; for (const value of data.subarray(6, 10)) { if (value & 128) invalid('ID3 syncsafe length'); bytes = bytes * 128 + value; }
      position = 10 + bytes; if (position > end) invalid('ID3 extent'); count();
    }
    if (end >= 128 && data.toString('latin1', end - 128, end - 125) === 'TAG') { end -= 128; count(); }
    const start = position, packets: Packet[] = []; let rate = 0, channels = 0, version = -1, frameSamples = 0, metadataFrames = 0, gapless: AudioInputFacts['gapless'] = null;
    let declaredFrames: number | null = null, declaredBytes: number | null = null;
    while (position < end) {
      count(); if (position + 4 > end) invalid('MP3 frame header');
      const header = data.readUInt32BE(position), v = header >>> 19 & 3, layer = header >>> 17 & 3, bitrateIndex = header >>> 12 & 15, rateIndex = header >>> 10 & 3;
      if ((header >>> 21) !== 2047 || v === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || rateIndex === 3 || (header & 3) === 2) unsupported('MPEG Layer III fixed-rate framed input required');
      const currentRate = [44100, 48000, 32000][rateIndex]! / (v === 3 ? 1 : v === 2 ? 2 : 4), currentChannels = (header >>> 6 & 3) === 3 ? 1 : 2;
      const bitrate = (v === 3 ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160])[bitrateIndex]!;
      const bytes = Math.floor((v === 3 ? 144000 : 72000) * bitrate / currentRate) + (header >>> 9 & 1), samples = v === 3 ? 1152 : 576;
      if (position + bytes > end || bytes < 4) invalid('MP3 frame extent');
      if (!rate) { rate = currentRate; channels = currentChannels; version = v; frameSamples = samples; }
      if (rate !== currentRate || channels !== currentChannels || version !== v) unsupported('MP3 rate/channel/version change');
      const sideBytes = v === 3 ? currentChannels === 1 ? 17 : 32 : currentChannels === 1 ? 9 : 17;
      const tag = position + 4 + (header >>> 16 & 1 ? 0 : 2) + sideBytes, marker = data.toString('latin1', tag, tag + 4);
      if (data.subarray(position, position + bytes).indexOf('VBRI') >= 0) unsupported('VBRI');
      if (marker === 'Info' || marker === 'Xing') {
        if (position !== start || metadataFrames || tag + 8 > position + bytes) unsupported('MP3 noninitial Xing/Info');
        const flags = data.readUInt32BE(tag + 4); if ((flags & 3) !== 3 || flags > 15) unsupported('Xing frame/byte declaration required');
        let cursor = tag + 8; const field = (size: number) => { if (cursor + size > position + bytes) invalid('Xing extent'); const offset = cursor; cursor += size; return offset; };
        declaredFrames = data.readUInt32BE(field(4)); declaredBytes = data.readUInt32BE(field(4));
        if (flags & 4) field(100); if (flags & 8) field(4);
        if (cursor + 24 <= position + bytes && /^(?:LAME|Lavc|Lavf)/.test(data.toString('latin1', cursor, cursor + 9))) {
          const trim = data.readUIntBE(cursor + 21, 3); gapless = { delaySamples: trim >>> 12, paddingSamples: trim & 4095 };
        }
        metadataFrames = 1;
      } else packets.push({ position, bytes });
      position += bytes;
    }
    if (!packets.length || position !== end) invalid('MP3 complete audio frames');
    if (declaredFrames !== null && declaredFrames !== packets.length || declaredBytes !== null && declaredBytes !== end - start) invalid('Xing frame/byte count');
    const value = facts('mp3', rate, channels as 1 | 2, packets.length * frameSamples, end - start, packets.length);
    value.metadataFrames = metadataFrames; value.gapless = gapless;
    if (gapless && gapless.delaySamples + gapless.paddingSamples >= value.samples) invalid('MP3 gapless extent');
    return finish({ facts: value, packets });
  }
  if (data.toString('latin1', 0, 4) === 'fLaC') {
    let position = 4, info: { rate: number; channels: 1 | 2; samples: number; minBlock: number; maxBlock: number } | null = null, last = false;
    while (!last) {
      count(); if (position + 4 > data.length) invalid('FLAC metadata header');
      const kind = data[position]! & 127, bytes = data.readUIntBE(position + 1, 3), start = position + 4; last = !!(data[position]! & 128);
      if (start + bytes > data.length) invalid('FLAC metadata extent');
      if (![0, 1, 3, 4].includes(kind)) unsupported('FLAC metadata kind');
      if (kind === 0) {
        if (position !== 4 || info || bytes !== 34) invalid('FLAC STREAMINFO');
        const packed = data.readBigUInt64BE(start + 10), rate = Number(packed >> 44n), channels = Number(packed >> 41n & 7n) + 1, bits = Number(packed >> 36n & 31n) + 1, samples = Number(packed & 0xfffffffffn);
        if (bits !== 16 || ![1, 2].includes(channels) || rate < 8000 || rate > 48000) unsupported('FLAC PCM16 mono/stereo 8k-48k required');
        const minBlock = data.readUInt16BE(start), maxBlock = data.readUInt16BE(start + 2);
        if (!samples || minBlock < 16 || maxBlock < minBlock) invalid('FLAC sample/block declaration');
        info = { rate, channels: channels as 1 | 2, samples, minBlock, maxBlock };
      } else if (!info) invalid('FLAC missing STREAMINFO');
      if (kind === 3) { if (bytes % 18) invalid('FLAC seek table extent'); count(bytes / 18); }
      position = start + bytes;
    }
    if (!info || position >= data.length) invalid('FLAC empty frames');
    if (info.samples * 16000 < limits.minSamples * info.rate || info.samples * 16000 > limits.maxSamples * info.rate || info.samples * 2 > limits.maxPcmBytes) throw Error('AUDIO_INPUT_SAMPLES_LIMIT: FLAC source duration/PCM');
    const frameStart = position, packets: Packet[] = []; let accumulated = 0, ordinal = 0, blocking: number | null = null;
    function crc8(start: number, end: number) { let crc = 0; for (let p = start; p < end; p++) { crc ^= data[p]!; for (let bit = 0; bit < 8; bit++) crc = crc & 128 ? (crc << 1 ^ 7) & 255 : crc << 1; } return crc; }
    function frameHeader(start: number) {
      if (start + 6 > data.length || data[start] !== 255 || (data[start + 1]! & 254) !== 248 || (data[start + 3]! & 1)) return null;
      const mode = data[start + 1]! & 1, block = data[start + 2]! >>> 4, frequency = data[start + 2]! & 15, assignment = data[start + 3]! >>> 4, bits = data[start + 3]! >>> 1 & 7;
      if (!block || frequency === 15 || assignment > 10 || assignment > 1 && assignment < 8 || ![0, 4].includes(bits)) return null;
      const channels = assignment < 8 ? assignment + 1 : 2; if (channels !== info!.channels) return null;
      let cursor = start + 4, number = data[cursor++]!, width = 1;
      if (number & 128) {
        let mask = 128; width = 0; while (number & mask) { width++; mask >>>= 1; }
        if (width < 2 || width > 7 || cursor + width - 1 > data.length) return null;
        number &= mask - 1;
        for (let i = 1; i < width; i++) { const next = data[cursor++]!; if ((next & 192) !== 128) return null; number = number * 64 + (next & 63); }
        if (!Number.isSafeInteger(number) || number < (width === 2 ? 128 : 2 ** (5 * width - 4))) return null;
      }
      let samples = block === 1 ? 192 : block <= 5 ? 576 * 2 ** (block - 2) : block >= 8 ? 256 * 2 ** (block - 8) : 0;
      if (block === 6) { if (cursor >= data.length) return null; samples = data[cursor++]! + 1; }
      if (block === 7) { if (cursor + 2 > data.length) return null; samples = data.readUInt16BE(cursor) + 1; cursor += 2; }
      let rate = [info!.rate, 88200, 176400, 192000, 8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000][frequency] ?? 0;
      if (frequency === 12) { if (cursor >= data.length) return null; rate = data[cursor++]! * 1000; }
      if (frequency === 13 || frequency === 14) { if (cursor + 2 > data.length) return null; rate = data.readUInt16BE(cursor) * (frequency === 14 ? 10 : 1); cursor += 2; }
      if (cursor >= data.length || rate !== info!.rate || samples > info!.maxBlock || crc8(start, cursor + 1) !== 0) return null;
      return { samples, number, mode, assignment, bytes: cursor + 1 - start };
    }
    function frameEnd(start: number, header: NonNullable<ReturnType<typeof frameHeader>>) {
      let bitPosition = (start + header.bytes) * 8;
      function read(bits: number) {
        if (bits < 0 || bitPosition + bits > data.length * 8) invalid('FLAC subframe bit extent');
        let value = 0; for (let i = 0; i < bits; i++, bitPosition++) value = value * 2 + (data[bitPosition >>> 3]! >>> (7 - (bitPosition & 7)) & 1);
        return value;
      }
      function skip(bits: number) { if (bits < 0 || bitPosition + bits > data.length * 8) invalid('FLAC residual bit extent'); bitPosition += bits; }
      function unary(maximum = data.length * 8) {
        let zeros = 0;
        while (true) {
          if (bitPosition >= data.length * 8 || zeros > maximum) invalid('FLAC unary extent');
          if (!(bitPosition & 7) && data[bitPosition >>> 3] === 0) { bitPosition += 8; zeros += 8; }
          else if (read(1)) return zeros; else zeros++;
        }
      }
      function residual(order: number) {
        const method = read(2), partitionOrder = read(4), partitions = 2 ** partitionOrder, partitionSamples = header.samples / partitions;
        if (method > 1 || !Number.isInteger(partitionSamples) || partitionSamples <= order) invalid('FLAC residual partition');
        count(partitions); const width = method === 0 ? 4 : 5, escape = 2 ** width - 1;
        for (let partition = 0; partition < partitions; partition++) {
          const parameter = read(width), samples = partitionSamples - (partition ? 0 : order);
          if (parameter === escape) skip(samples * read(5));
          else for (let i = 0; i < samples; i++) { const quotient = unary(), remainder = read(parameter); if (quotient > Math.floor(0xfffffffe / 2 ** parameter) || quotient * 2 ** parameter + remainder > 0xfffffffe) invalid('FLAC residual value'); }
        }
      }
      for (let channel = 0; channel < info!.channels; channel++) {
        count(); if (read(1)) invalid('FLAC subframe padding');
        const type = read(6), wasted = read(1), bits = 16 + (header.assignment === 8 && channel === 1 || header.assignment === 9 && channel === 0 || header.assignment === 10 && channel === 1 ? 1 : 0) - (wasted ? unary(16) + 1 : 0);
        if (bits <= 0) invalid('FLAC wasted bits');
        if (type === 0) skip(bits);
        else if (type === 1) skip(header.samples * bits);
        else if (type >= 8 && type <= 12) { const order = type - 8; if (order > header.samples) invalid('FLAC fixed predictor'); skip(order * bits); residual(order); }
        else if (type >= 32) {
          const order = type - 31; if (order > header.samples) invalid('FLAC LPC predictor'); skip(order * bits);
          const precision = read(4); if (precision === 15) invalid('FLAC LPC precision'); if (read(5) > 15) invalid('FLAC negative LPC shift'); skip(order * (precision + 1)); residual(order);
        } else invalid('FLAC reserved subframe');
      }
      while (bitPosition & 7) if (read(1)) invalid('FLAC frame alignment padding');
      const end = bitPosition / 8 + 2; if (end > data.length) invalid('FLAC frame CRC extent'); let crc = 0;
      for (let p = start; p < end; p++) { crc ^= data[p]! << 8; for (let bit = 0; bit < 8; bit++) crc = crc & 32768 ? (crc << 1 ^ 0x8005) & 65535 : crc << 1 & 65535; }
      if (crc !== 0) invalid('FLAC frame CRC'); return end;
    }
    while (position < data.length) {
      count(); const header = frameHeader(position); if (!header || header.number !== (header.mode ? accumulated : ordinal) || blocking !== null && blocking !== header.mode) invalid('FLAC frame header/sequence');
      blocking = header.mode; const next = frameEnd(position, header);
      if (accumulated + header.samples > info.samples || header.samples < info.minBlock && accumulated + header.samples !== info.samples) invalid('FLAC frame sample extent');
      packets.push({ position, bytes: next - position }); accumulated += header.samples; ordinal++; position = next;
    }
    if (accumulated !== info.samples) invalid('FLAC complete sample count');
    return finish({ facts: facts('flac', info.rate, info.channels, info.samples, data.length - frameStart, packets.length), packets });
  }
  if (data.length < 8 || !['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(data.toString('latin1', 4, 8))) unsupported('bounded WAV/MP3/FLAC/M4A required');
  interface Box { type: string; start: number; data: number; end: number }
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = [];
    while (start < end) {
      count(); if (start + 8 > end) invalid('M4A box header');
      let bytes = data.readUInt32BE(start), header = 8; const type = data.toString('latin1', start + 4, start + 8);
      if (bytes === 1) { if (start + 16 > end) invalid('M4A large box header'); const n = data.readBigUInt64BE(start + 8); if (n > BigInt(Number.MAX_SAFE_INTEGER)) invalid('M4A unsafe box extent'); bytes = Number(n); header = 16; }
      if (bytes < header || start + bytes > end) invalid('M4A box extent');
      result.push({ type, start, data: start + header, end: start + bytes }); start += bytes;
    }
    return result;
  }
  function allowed(list: Box[], names: string[]) { if (list.some(box => !names.includes(box.type))) unsupported('M4A box combination'); }
  function one(list: Box[], type: string) { const selected = list.filter(b => b.type === type); if (selected.length !== 1) invalid('M4A ' + type + ' multiplicity'); return selected[0]!; }
  function full(box: Box, bytes: number, version = 0) { if (box.end - box.data !== bytes || data[box.data] !== version || data.readUIntBE(box.data + 1, 3)) unsupported('M4A ' + box.type + ' version/extent/flags'); }
  function table(box: Box, width: number) { if (box.data + 8 > box.end) invalid('M4A table header'); const n = data.readUInt32BE(box.data + 4); full(box, 8 + n * width); count(n); return n; }
  const top = boxes(0, data.length); allowed(top, ['ftyp', 'free', 'wide', 'moov', 'mdat']);
  const type = one(top, 'ftyp'), mdat = one(top, 'mdat'), movie = boxes(one(top, 'moov').data, one(top, 'moov').end);
  if (type.end - type.data < 8 || (type.end - type.data) % 4 || !['M4A ', 'isom', 'iso2', 'mp41', 'mp42'].includes(data.toString('latin1', type.data, type.data + 4))) unsupported('M4A brand');
  allowed(movie, ['mvhd', 'trak', 'udta']); const mvhd = one(movie, 'mvhd');
  if (mvhd.end - mvhd.data !== 100 || data[mvhd.data] !== 0) unsupported('M4A movie header');
  const movieTimescale = data.readUInt32BE(mvhd.data + 12); if (!movieTimescale) invalid('M4A movie timescale');
  const track = one(movie, 'trak'), children = boxes(track.data, track.end); allowed(children, ['tkhd', 'edts', 'mdia']);
  const tkhd = one(children, 'tkhd'); if (tkhd.end - tkhd.data !== 84 || data[tkhd.data] !== 0) unsupported('M4A track header');
  const media = one(children, 'mdia'), mdia = boxes(media.data, media.end); allowed(mdia, ['mdhd', 'hdlr', 'minf']);
  const mdhd = one(mdia, 'mdhd'); full(mdhd, 24); const sampleRate = data.readUInt32BE(mdhd.data + 12), mediaDuration = data.readUInt32BE(mdhd.data + 16);
  const handler = one(mdia, 'hdlr'); if (handler.end - handler.data < 20 || data.toString('latin1', handler.data + 8, handler.data + 12) !== 'soun') unsupported('M4A sound track required');
  const minf = one(mdia, 'minf'), minfBoxes = boxes(minf.data, minf.end); allowed(minfBoxes, ['smhd', 'dinf', 'stbl']); full(one(minfBoxes, 'smhd'), 8);
  const dinf = one(minfBoxes, 'dinf'), references = boxes(dinf.data, dinf.end); allowed(references, ['dref']); const dref = one(references, 'dref'); full(dref, 20);
  if (data.readUInt32BE(dref.data + 4) !== 1) unsupported('M4A single data reference required');
  const url = one(boxes(dref.data + 8, dref.end), 'url ');
  if (url.end - url.data !== 4 || data.readUInt32BE(url.data) !== 1) unsupported('M4A self-contained reference required');
  const stbl = one(minfBoxes, 'stbl'), tables = boxes(stbl.data, stbl.end); allowed(tables, ['stsd', 'stts', 'stsc', 'stsz', 'stco', 'co64', 'sgpd', 'sbgp']);
  const stsd = one(tables, 'stsd'); if (stsd.data + 8 > stsd.end || data.readUInt32BE(stsd.data) || data.readUInt32BE(stsd.data + 4) !== 1) unsupported('M4A single sample description required');
  const descriptions = boxes(stsd.data + 8, stsd.end); allowed(descriptions, ['mp4a']); const sample = one(descriptions, 'mp4a');
  if (sample.data + 28 > sample.end || data.readUInt16BE(sample.data + 6) !== 1 || data.readUInt16BE(sample.data + 8) !== 0 || data.readUInt16BE(sample.data + 18) !== 16 || data.readUInt32BE(sample.data + 24) !== sampleRate * 65536) unsupported('M4A mp4a version/format');
  const sampleChildren = boxes(sample.data + 28, sample.end); allowed(sampleChildren, ['esds']);
  const sampleChannels = data.readUInt16BE(sample.data + 16), esds = one(sampleChildren, 'esds');
  if (esds.data + 4 > esds.end || data.readUInt32BE(esds.data)) unsupported('M4A esds version');
  interface Descriptor { tag: number; start: number; end: number }
  function descriptors(start: number, end: number): Descriptor[] {
    const result: Descriptor[] = [];
    while (start < end) { count(); const tag = data[start++]!; let bytes = 0, last = false;
      for (let i = 0; i < 4; i++) { if (start >= end) invalid('M4A descriptor header'); const value = data[start++]!; bytes = bytes * 128 + (value & 127); if (!(value & 128)) { last = true; break; } }
      if (!last || start + bytes > end) invalid('M4A descriptor extent'); result.push({ tag, start, end: start + bytes }); start += bytes;
    }
    return result;
  }
  function descriptor(list: Descriptor[], tag: number) { const selected = list.filter(d => d.tag === tag); if (selected.length !== 1) invalid('M4A descriptor multiplicity'); return selected[0]!; }
  const roots = descriptors(esds.data + 4, esds.end), es = descriptor(roots, 3); if (roots.length !== 1) unsupported('M4A ES descriptor root');
  if (es.start + 3 > es.end || data[es.start + 2] !== 0) unsupported('M4A ES reference flags');
  const esChildren = descriptors(es.start + 3, es.end), config = descriptor(esChildren, 4), sl = descriptor(esChildren, 6);
  if (esChildren.length !== 2 || sl.end - sl.start !== 1 || data[sl.start] !== 2 || config.start + 13 > config.end || data[config.start] !== 64 || data[config.start + 1] !== 21) unsupported('M4A AAC decoder configuration');
  const configs = descriptors(config.start + 13, config.end), asc = descriptor(configs, 5), length = asc.end - asc.start;
  if (configs.length !== 1 || ![2, 5].includes(length)) unsupported('M4A AAC-LC configuration extent');
  const ascBits = data.readUInt16BE(asc.start), index = ascBits >>> 7 & 15, channels = ascBits >>> 3 & 15;
  if (ascBits >>> 11 !== 2 || (ascBits & 7) !== 0 || ![1, 2].includes(channels) || channels !== sampleChannels || [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350][index] !== sampleRate ||
      length === 5 && data.subarray(asc.start + 2, asc.end).toString('hex') !== '56e500') unsupported('M4A AAC-LC 1024 mono/stereo without SBR required');
  const stsz = one(tables, 'stsz'); if (stsz.data + 12 > stsz.end) invalid('M4A sample sizes');
  const fixedSize = data.readUInt32BE(stsz.data + 4), samples = data.readUInt32BE(stsz.data + 8); full(stsz, 12 + (fixedSize ? 0 : samples * 4)); count(samples);
  if (!samples || samples > limits.maxPackets) throw Error('AUDIO_INPUT_PACKET_LIMIT');
  const sizes = Array.from({ length: samples }, (_, i) => fixedSize || data.readUInt32BE(stsz.data + 12 + i * 4)); if (sizes.some(n => !n)) invalid('M4A zero-sized sample');
  const stts = one(tables, 'stts'), timeEntries = table(stts, 8); let sampleCount = 0, duration = 0;
  for (let i = 0; i < timeEntries; i++) {
    const p = stts.data + 8 + i * 8, n = data.readUInt32BE(p), delta = data.readUInt32BE(p + 4);
    if (!n || !delta || delta > 1024 || delta !== 1024 && (i !== timeEntries - 1 || n !== 1)) unsupported('M4A AAC sample delta');
    sampleCount += n; duration += n * delta;
  }
  if (sampleCount !== samples || duration !== mediaDuration) invalid('M4A sample time table count');
  const offsetBoxes = tables.filter(b => b.type === 'stco' || b.type === 'co64'); if (offsetBoxes.length !== 1) invalid('M4A chunk offsets');
  const offsets = offsetBoxes[0]!, width = offsets.type === 'stco' ? 4 : 8, chunks = table(offsets, width), stsc = one(tables, 'stsc'), chunkEntries = table(stsc, 12);
  const mappings = Array.from({ length: chunkEntries }, (_, i) => { const p = stsc.data + 8 + i * 12; return { first: data.readUInt32BE(p), samples: data.readUInt32BE(p + 4), description: data.readUInt32BE(p + 8) }; });
  if (!chunks || !mappings.length || mappings[0]!.first !== 1 || mappings.some((m, i) => !m.samples || m.first > chunks || m.description !== 1 || i && m.first <= mappings[i - 1]!.first)) invalid('M4A sample/chunk mapping');
  const packets: Packet[] = []; let mapping = 0, ordinal = 0, expected = mdat.data;
  for (let i = 0; i < chunks; i++) {
    if (mapping + 1 < mappings.length && mappings[mapping + 1]!.first === i + 1) mapping++;
    const p = offsets.data + 8 + i * width, raw = width === 4 ? BigInt(data.readUInt32BE(p)) : data.readBigUInt64BE(p);
    if (raw > BigInt(Number.MAX_SAFE_INTEGER) || Number(raw) !== expected) invalid('M4A contiguous self-contained chunk coverage');
    for (let n = 0; n < mappings[mapping]!.samples; n++) { count(); const bytes = sizes[ordinal++]!; if (!bytes || expected + bytes > mdat.end) invalid('M4A sample payload extent'); packets.push({ position: expected, bytes }); expected += bytes; }
  }
  if (ordinal !== samples || expected !== mdat.end) invalid('M4A complete mdat sample coverage');
  for (const group of tables.filter(b => b.type === 'sgpd' || b.type === 'sbgp')) {
    if (data.toString('latin1', group.data + 4, group.data + 8) !== 'roll') unsupported('M4A sample grouping');
    if (group.type === 'sgpd') { full(group, 18, 1); if (data.readUInt32BE(group.data + 8) !== 2 || data.readUInt32BE(group.data + 12) !== 1 || data.readInt16BE(group.data + 16) !== -1) unsupported('M4A roll description'); }
    else { full(group, 20); if (data.readUInt32BE(group.data + 8) !== 1 || data.readUInt32BE(group.data + 12) !== samples || data.readUInt32BE(group.data + 16) !== 1) unsupported('M4A roll coverage'); }
  }
  if (tables.filter(b => b.type === 'sgpd').length !== tables.filter(b => b.type === 'sbgp').length || tables.filter(b => b.type === 'sgpd').length > 1) invalid('M4A roll groups');
  const value = facts('m4a', sampleRate, channels as 1 | 2, samples * 1024, mdat.end - mdat.data, samples), edits = children.filter(b => b.type === 'edts');
  if (edits.length > 1) invalid('M4A edit multiplicity');
  if (edits.length) {
    const editBoxes = boxes(edits[0]!.data, edits[0]!.end); allowed(editBoxes, ['elst']); const edit = one(editBoxes, 'elst'); full(edit, 20);
    const segmentDuration = data.readUInt32BE(edit.data + 8), mediaTime = data.readInt32BE(edit.data + 12);
    if (data.readUInt32BE(edit.data + 4) !== 1 || !segmentDuration || mediaTime < 0 || mediaTime > 1024 || data.readUInt16BE(edit.data + 16) !== 1 || data.readUInt16BE(edit.data + 18) !== 0) unsupported('M4A single forward rate-1 edit');
    value.edit = { mediaTime, segmentDuration, movieTimescale };
  }
  for (const metadata of movie.filter(b => b.type === 'udta')) {
    const list = boxes(metadata.data, metadata.end); allowed(list, ['meta']);
    for (const meta of list) {
      if (meta.data + 4 > meta.end || data.readUInt32BE(meta.data)) unsupported('M4A metadata version');
      const metaBoxes = boxes(meta.data + 4, meta.end); allowed(metaBoxes, ['hdlr', 'ilst']);
      for (const itemList of metaBoxes.filter(b => b.type === 'ilst')) for (const item of boxes(itemList.data, itemList.end)) {
        const values = boxes(item.data, item.end); allowed(values, ['data', 'mean', 'name']);
      }
    }
  }
  return finish({ facts: value, packets });
}
export function preflightAudioInput(data: Buffer, limits: AudioInputLimits): AudioInputFacts { return structure(data, limits).facts; }

function inputArguments(facts: AudioInputFacts): string[] {
  return ['-max_alloc', '67108864', '-probesize', '4194304', '-analyzeduration', '5000000', '-protocol_whitelist', 'file',
    '-format_whitelist', facts.demuxer, '-f', facts.demuxer, '-max_streams', '1',
    ...(facts.format === 'mp3' ? ['-usetoc', '0', '-flags2', '+skip_manual'] : facts.format === 'm4a' ? ['-enable_drefs', '0', '-use_absolute_path', '0', '-ignore_editlist', '1'] : [])];
}
export function audioInputProbeArguments(facts: AudioInputFacts, source: string): string[] {
  return ['-v', 'error', ...inputArguments(facts), '-show_format', '-show_streams', '-show_packets',
    '-show_entries', 'format=format_name,duration:stream=index,codec_type,codec_name,profile,sample_rate,channels,bits_per_raw_sample:packet=stream_index,pos,size', '-of', 'json', source];
}
export function audioInputDecodeArguments(facts: AudioInputFacts, source: string): string[] {
  return ['-nostdin', '-hide_banner', '-v', 'error', '-xerror', '-err_detect', 'crccheck+bitstream+buffer+explode', ...inputArguments(facts),
    '-threads', '1', '-i', source, '-map', '0:a:0', '-vn', '-sn', '-dn', '-ar', String(facts.sampleRate), '-ac', '1', '-threads', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
}
export function audioInputNormalizeArguments(facts: AudioInputFacts, pcmPath: string): string[] {
  return ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-max_alloc', '67108864', '-probesize', '4194304', '-analyzeduration', '5000000',
    '-protocol_whitelist', 'file', '-format_whitelist', 's16le', '-f', 's16le', '-ar', String(facts.sampleRate), '-ac', '1', '-c:a', 'pcm_s16le',
    '-max_streams', '1', '-threads', '1', '-i', pcmPath, '-map', '0:a:0', '-vn', '-sn', '-dn', '-filter_threads', '1',
    '-af', 'aresample=16000:resampler=swr:dither_method=none:async=0', '-ar', '16000', '-ac', '1', '-threads', '1', '-c:a', 'pcm_s16le', '-f', 's16le', 'pipe:1'];
}
function validateProbe(data: Buffer, admitted: Structure, limits: AudioInputLimits) {
  let probe: any; try { probe = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)); } catch { throw Error('AUDIO_INPUT_PROBE_INVALID: JSON'); }
  const { facts, packets, waveData } = admitted, streams = probe.streams, raw = streams?.[0];
  if (!Array.isArray(streams) || streams.length !== 1 || raw?.index !== 0 || raw.codec_type !== 'audio' || raw.codec_name !== facts.codec ||
      String(raw.sample_rate) !== String(facts.sampleRate) || raw.channels !== facts.channels || facts.format === 'm4a' && raw.profile !== 'LC' ||
      !Array.isArray(probe.packets) || !probe.packets.length) throw Error('AUDIO_INPUT_PROBE_INVALID: stream facts');
  if (probe.packets.length > limits.maxPackets) throw Error('AUDIO_INPUT_PACKET_LIMIT');
  const number = (n: unknown) => typeof n === 'string' && /^\d+$/.test(n) || typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? Number(n) : NaN;
  let expected = waveData?.position ?? 0;
  if (!waveData && probe.packets.length !== packets.length) throw Error('AUDIO_INPUT_PROBE_INVALID: packet count');
  for (const [i, packet] of probe.packets.entries()) {
    const position = number(packet.pos), bytes = number(packet.size);
    if (packet.stream_index !== 0 || !Number.isSafeInteger(position) || !Number.isSafeInteger(bytes) || bytes <= 0 ||
        (waveData ? position !== expected || position + bytes > waveData.position + waveData.bytes
          : position !== packets[i]!.position || bytes !== packets[i]!.bytes)) throw Error('AUDIO_INPUT_PROBE_INVALID: complete packet extent');
    expected = position + bytes;
  }
  if (waveData && expected !== waveData.position + waveData.bytes) throw Error('AUDIO_INPUT_PROBE_INVALID: complete WAV packet coverage');
}

/** Fixed tools decode all admitted packets and resample the complete original-rate mono PCM. */
export async function decodeAudioInput(source: string, facts: AudioInputFacts, context: InspectContext, runtime: AudioInputRuntimeIdentity): Promise<{
  facts: AudioInputFacts; probe: Buffer; pcm: Buffer; wav: Buffer; samples: number; payloadBytes: number; commands: { probe: ToolRun; decode: ToolRun; normalize: ToolRun }
}> {
  const limits = audioInputLimits(context.policy), files = new NodeImportFiles(context.projectDir); validateAudioInputFacts(facts, limits); validateAudioInputRuntime(runtime);
  const check = () => { context.signal.throwIfAborted(); context.check(); }, fingerprint = JSON.stringify(runtime), policy = JSON.stringify(context.policy);
  files.projectPath(source); check(); const sourceNode = await files.inspect(source);
  const original = await readFixed(source, limits.maxSourceBytes, context.signal, n => { context.counts.sourceReadBytes += n; });
  const admitted = structure(original.data, limits);
  if (JSON.stringify(admitted.facts) !== JSON.stringify(facts) || context.sourceBytes !== undefined && original.bytes !== context.sourceBytes || context.sourceSha256 && original.sha256 !== context.sourceSha256) throw Error('CATALOG_SOURCE_CHANGED: audio input identity/facts');
  const pcmPath = files.projectPath(join(context.temporaryDir, 'source.s16le')); let created = false;
  async function runtimeIdentity() {
    try {
      if (JSON.stringify(runtime) !== fingerprint) throw Error('runtime descriptor');
      const checked = new Set<string>();
      for (const tool of Object.values(runtime.tools)) {
        if (!tool.files.some(f => f.path === tool.executable)) throw Error('runtime executable');
        for (const entry of tool.files) {
          if (checked.has(entry.path)) continue; checked.add(entry.path);
          if (await realpath(entry.path) !== entry.path) throw Error('runtime physical path');
          const value = await readFixed(entry.path, entry.bytes, context.signal, undefined, false);
          if (value.bytes !== entry.bytes || value.sha256 !== entry.sha256) throw Error('runtime physical identity');
        }
        for (const alias of tool.aliases) if (!tool.files.some(f => f.path === alias.realpath) || await realpath(alias.path) !== alias.realpath) throw Error('runtime logical alias');
      }
    } catch (error) { context.signal.throwIfAborted(); throw Error('CATALOG_AUDIO_INPUT_RUNTIME_CHANGED: ' + (error instanceof Error ? error.message : String(error))); }
  }
  async function unchanged() {
    check(); const current = await readFixed(source, limits.maxSourceBytes, context.signal, n => { context.counts.sourceReadBytes += n; }, false);
    if (!sameImportNode(sourceNode, await files.inspect(source)) || current.bytes !== original.bytes || current.sha256 !== original.sha256) throw Error('CATALOG_SOURCE_CHANGED: audio input changed');
    if (JSON.stringify(context.policy) !== policy) throw Error('CATALOG_POLICY_CHANGED: audio input policy'); await runtimeIdentity(); check();
  }
  async function tool(role: 'probe' | 'decode' | 'normalize', argv: string[], maximum?: number) {
    check(); let failure: unknown; const parts: Buffer[] = [];
    const native = role === 'probe' ? runtime.tools.ffprobe : runtime.tools.ffmpeg;
    const run = await runInspectionTool({ executable: native.executable, version: native.version + '/audio-input@0.1/' + role, argv, cwd: context.temporaryDir,
      policy: { ...context.policy, maxToolElapsedMs: Math.min(context.policy.maxToolElapsedMs, limits.maxToolElapsedMs) }, signal: context.signal, binaryLimit: maximum,
      ...(role === 'probe' ? {} : { binary: async (chunk: Buffer) => {
        try { check(); if (context.counts.derivedBytes + chunk.length > context.policy.maxDerivedBytes) throw Error('CATALOG_DERIVED_LIMIT');
          if (context.counts.decodedAudioBytes + chunk.length > context.policy.maxDecodedAudioBytes) throw Error('CATALOG_DECODED_AUDIO_LIMIT');
          context.counts.derivedBytes += chunk.length; context.counts.decodedAudioBytes += chunk.length; parts.push(Buffer.from(chunk));
        } catch (error) { failure = error; throw error; }
      } }),
      onRun: run => { context.tools.push(run); context.counts.toolOutputBytes += run.stdoutBytes + run.stderrBytes; } });
    if (failure) throw failure; check(); await unchanged();
    if (run.error?.startsWith('CATALOG_TOOL_TERMINATION_FAILED:')) throw Error(run.error);
    if (run.error === 'CATALOG_BINARY_LIMIT') throw Error('AUDIO_INPUT_PCM_INVALID: output exceeded complete sample oracle');
    if (run.error) throw Error('AUDIO_INPUT_TOOL_FAILED: ' + run.error);
    return { run, data: role === 'probe' ? Buffer.from(run.stdout) : Buffer.concat(parts) };
  }
  await unchanged();
  try {
    const probe = await tool('probe', audioInputProbeArguments(facts, source)); validateProbe(probe.data, admitted, limits);
    const decoded = await tool('decode', audioInputDecodeArguments(facts, source), facts.samples * 2);
    if (decoded.data.length !== facts.samples * 2) throw Error('AUDIO_INPUT_PCM_INVALID: complete decoded sample count');
    const handle = await open(pcmPath, 'wx', 0o600); created = true;
    try { await handle.writeFile(decoded.data); await handle.sync(); } finally { await handle.close(); }
    const pcmNode = await files.inspect(pcmPath);
    async function pcmIdentity() {
      const current = await readFixed(pcmPath, limits.maxPcmBytes, context.signal, n => { context.counts.sourceReadBytes += n; }, false);
      if (!sameImportNode(pcmNode, await files.inspect(pcmPath)) || current.bytes !== decoded.data.length || current.sha256 !== hash(decoded.data)) throw Error('CATALOG_SOURCE_CHANGED: audio input PCM');
    }
    await pcmIdentity();
    check(); if (context.counts.derivedBytes + 44 > context.policy.maxDerivedBytes) throw Error('CATALOG_DERIVED_LIMIT'); context.counts.derivedBytes += 44;
    const capacity = Math.min(limits.maxSamples * 2, limits.maxAudioBytes - 44);
    if (capacity < limits.minSamples * 2) throw Error('AUDIO_INPUT_AUDIO_LIMIT');
    const normalized = await tool('normalize', audioInputNormalizeArguments(facts, pcmPath), capacity); await pcmIdentity();
    const samples = normalized.data.length / 2;
    if (!Number.isSafeInteger(samples) || samples < limits.minSamples || samples > limits.maxSamples || Math.abs(samples * facts.sampleRate - facts.samples * 16000) > facts.sampleRate) throw Error('AUDIO_INPUT_PCM_INVALID: canonical sample count');
    if (facts.sampleRate === 16000 && !normalized.data.equals(decoded.data)) throw Error('AUDIO_INPUT_PCM_INVALID: 16k passthrough');
    return { facts, probe: probe.data, pcm: decoded.data, wav: Buffer.concat([canonicalWavHeader(samples), normalized.data]), samples, payloadBytes: normalized.data.length,
      commands: { probe: probe.run, decode: decoded.run, normalize: normalized.run } };
  } finally { try { await unchanged(); } finally { if (created) await rm(pcmPath); } }
}
