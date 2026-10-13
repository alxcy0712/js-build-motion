import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { crc32, createInflateRaw } from 'node:zlib';
import yauzl from 'yauzl';
import parserPackage from 'yauzl/package.json' with { type: 'json' };
import { assertImportPath, ensureImportDirectory, importProjectPath, NodeImportFiles, sameImportNode } from './import-files.ts';
import { emptyUnpackItem, safeUnpackPath, ZIP_PARSER, type UnpackItem, type UnpackPolicy } from '../project/unpack.ts';

export interface UnpackProgress {
  onCreated(): Promise<void>;
  onCompressed(bytes: number): Promise<void>;
  admit(bytes: number): void;
  onWritten(bytes: number): Promise<void>;
}
export interface ZipMember { readonly entry: any; readonly item: UnpackItem; readonly start: number; readonly end: number }
const crcText = (value: number) => value.toString(16).padStart(8, '0');
function uint64(buffer: Buffer, offset: number): number {
  if (offset + 8 > buffer.length) throw new Error('UNPACK_ZIP64_INVALID: missing integer');
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('UNPACK_ZIP64_INVALID: unsafe integer');
  return Number(value);
}
function extraFields(buffer: Buffer): { id: number; data: Buffer }[] {
  const fields = []; let offset = 0;
  const ids = new Set<number>();
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('UNPACK_EXTRA_INVALID: truncated field');
    const id = buffer.readUInt16LE(offset), size = buffer.readUInt16LE(offset + 2); offset += 4;
    if (offset + size > buffer.length || ids.has(id)) throw new Error('UNPACK_EXTRA_INVALID: length or duplicate ID');
    const data = buffer.subarray(offset, offset + size); ids.add(id); fields.push({ id, data }); offset += size;
    if (id === 0x000d && size > 12) throw new Error('UNPACK_OBJECT_UNSUPPORTED: UNIX link data');
    if (id === 0x756e) {
      if (size < 14 || crc32(data.subarray(4)) !== data.readUInt32LE(0)) throw new Error('UNPACK_EXTRA_INVALID: ASi UNIX');
      const kind = data.readUInt16LE(4) & 0xf000;
      if (size > 14 || ![0, 0x4000, 0x8000].includes(kind)) throw new Error('UNPACK_OBJECT_UNSUPPORTED: ASi UNIX link/special');
    }
  }
  return fields;
}
function extended(values: number[], fields: { id: number; data: Buffer }[]): number[] {
  const field = fields.find(field => field.id === 1); let offset = 0;
  return values.map((value, index) => {
    if (value !== (index === 3 ? 0xffff : 0xffffffff)) return value;
    if (!field) throw new Error('UNPACK_ZIP64_INVALID: missing extra field');
    const result = index === 3 ? (offset + 4 <= field.data.length ? field.data.readUInt32LE(offset) : NaN) : uint64(field.data, offset);
    offset += index === 3 ? 4 : 8;
    if (!Number.isSafeInteger(result)) throw new Error('UNPACK_ZIP64_INVALID: missing disk integer');
    return result;
  });
}
function decodeName(flags: number, raw: Buffer, fields: { id: number; data: Buffer }[]): { original: string; adopted: string } {
  const utf8 = (bytes: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const original = flags & 0x800 ? utf8(raw) : yauzl.getFileNameLowLevel(0, raw, [], true);
  let adopted = original;
  const unicode = fields.find(field => field.id === 0x7075);
  if (unicode && unicode.data.length >= 5 && unicode.data[0] === 1 && crc32(raw) === unicode.data.readUInt32LE(1)) adopted = utf8(unicode.data.subarray(5));
  const originalPath = original.endsWith('/') ? original.slice(0, -1) : original;
  const adoptedPath = adopted.endsWith('/') ? adopted.slice(0, -1) : adopted;
  if (original.endsWith('/') !== adopted.endsWith('/') || !safeUnpackPath(originalPath) || !safeUnpackPath(adoptedPath)) throw new Error('UNPACK_PATH_INVALID: unsafe original/adopted member name');
  return { original, adopted };
}
function objectKind(entry: any, name: string, fields: { id: number; data: Buffer }[]): 'file' | 'directory' {
  const host = entry.versionMadeBy >>> 8, attrs = entry.externalFileAttributes, mode = attrs >>> 16, type = mode & 0xf000;
  if (![0, 3, 10, 19].includes(host) || ((attrs & 0xffff) & ~0x37)) throw new Error('UNPACK_OBJECT_UNSUPPORTED: creator/attributes');
  if ([3, 19].includes(host)) {
    if (![0, 0x4000, 0x8000].includes(type)) throw new Error('UNPACK_OBJECT_UNSUPPORTED: link/special mode');
  } else if (mode) throw new Error('UNPACK_OBJECT_UNSUPPORTED: ambiguous object attributes');
  const directory = name.endsWith('/');
  if ((type === 0x4000 || !!(attrs & 0x10)) && !directory || type === 0x8000 && directory) throw new Error('UNPACK_OBJECT_INVALID: directory/name mismatch');
  const asi = fields.find(field => field.id === 0x756e);
  const asiType = asi ? asi.data.readUInt16LE(4) & 0xf000 : 0;
  if (asiType && asiType !== (directory ? 0x4000 : 0x8000)) throw new Error('UNPACK_OBJECT_INVALID: ASi UNIX type mismatch');
  return directory ? 'directory' : 'file';
}

/** Reads bounded records and raw compressed streams from one independent, stable descriptor. */
export class ZipArchive {
  private handle: FileHandle;
  private zip: any = null;
  private streams = new Set<Readable>();
  private before: Awaited<ReturnType<NodeImportFiles['inspect']>>;
  readonly path: string;
  currentItem: UnpackItem | null = null;
  private signal: AbortSignal;
  private metadata: (bytes: number) => void;
  private centralOffset = 0;
  private centralSize = 0;
  private entryCount = 0;
  private abort: () => void;
  private constructor(handle: FileHandle, path: string, before: Awaited<ReturnType<NodeImportFiles['inspect']>>, signal: AbortSignal, metadata: (bytes: number) => void) {
    this.handle = handle; this.path = path; this.before = before; this.signal = signal; this.metadata = metadata;
    this.abort = () => { for (const stream of this.streams) stream.destroy(signal.reason); };
    signal.addEventListener('abort', this.abort, { once: true });
  }
  static async open(path: string, policy: UnpackPolicy, signal: AbortSignal, metadata: (bytes: number) => void): Promise<ZipArchive> {
    if (`${parserPackage.name}@${parserPackage.version}` !== ZIP_PARSER) throw new Error('UNPACK_PARSER_CHANGED');
    assertImportPath(path); signal.throwIfAborted();
    const info = await lstat(path, { bigint: true });
    if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(policy.maxArchiveBytes)) throw new Error('UNPACK_ARCHIVE_INVALID: ordinary file and byte limit');
    const files = new NodeImportFiles(dirname(path)), before = await files.inspect(path);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const archive = new ZipArchive(handle, path, before, signal, metadata);
    try {
      const actual = await handle.stat({ bigint: true });
      if (actual.dev !== info.dev || actual.ino !== info.ino || actual.size !== info.size || actual.nlink !== 1n) throw new Error('UNPACK_ARCHIVE_CHANGED');
      await archive.directory(policy);
      const reader = new yauzl.RandomAccessReader();
      reader.read = (buffer: Buffer, offset: number, length: number, position: number, callback: (error?: unknown) => void) => {
        archive.read(position, length).then(bytes => { bytes.copy(buffer, offset); callback(); }, callback);
      };
      reader._readStreamForRange = (start: number, end: number) => {
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > before.size || end < start) throw new Error('UNPACK_RANGE_INVALID');
        signal.throwIfAborted();
        const stream = Readable.from((async function* () {
          for (let position = start; position < end;) {
            const chunk = await archive.read(position, Math.min(65536, end - position)); position += chunk.length; yield chunk;
          }
        })(), { objectMode: false, highWaterMark: 65536 });
        archive.streams.add(stream); stream.once('close', () => archive.streams.delete(stream)); return stream;
      };
      archive.zip = await yauzl.fromRandomAccessReaderPromise(reader, before.size, { autoClose: false, decodeStrings: false, validateEntrySizes: true, strictFileNames: true });
      // Keep asynchronous parser errors handled between per-entry requests.
      archive.zip.on('error', () => {});
      if (archive.zip.entryCount !== archive.entryCount || archive.zip.readEntryCursor !== archive.centralOffset) throw new Error('UNPACK_DIRECTORY_INVALID: parser identity');
      return archive;
    } catch (error) { await archive.close(); throw error; }
  }
  private async read(offset: number, length: number): Promise<Buffer> {
    this.signal.throwIfAborted();
    if (![offset, length, offset + length].every(Number.isSafeInteger) || offset < 0 || length < 0 || offset + length > this.before.size) throw new Error('UNPACK_RANGE_INVALID');
    const buffer = Buffer.alloc(length); let read = 0;
    while (read < length) {
      this.signal.throwIfAborted();
      const { bytesRead } = await this.handle.read(buffer, read, length - read, offset + read);
      if (!bytesRead) throw new Error('UNPACK_TRUNCATED'); read += bytesRead;
    }
    return buffer;
  }
  private async directory(policy: UnpackPolicy): Promise<void> {
    const size = this.before.size, length = Math.min(size, 65557), start = size - length, tail = await this.read(start, length);
    let eocd = -1;
    for (let i = length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === length) { eocd = i; break; }
    if (eocd < 0) throw new Error('UNPACK_DIRECTORY_INVALID: EOCD missing/truncated');
    const e = tail.subarray(eocd), end = start + eocd;
    this.metadata(e.readUInt16LE(20));
    const disk = e.readUInt16LE(4), centralDisk = e.readUInt16LE(6), diskCount = e.readUInt16LE(8), count = e.readUInt16LE(10);
    let centralEnd = end;
    this.entryCount = count; this.centralSize = e.readUInt32LE(12); this.centralOffset = e.readUInt32LE(16);
    if (end >= 20 && (await this.read(end - 20, 4)).readUInt32LE(0) === 0x07064b50) {
      const locator = await this.read(end - 20, 20), offset = uint64(locator, 8), z = await this.read(offset, 56);
      const recordSize = uint64(z, 4);
      if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1 || z.readUInt32LE(0) !== 0x06064b50 || z.readUInt16LE(14) > 45 || recordSize < 44 || offset + 12 + recordSize !== end - 20) throw new Error('UNPACK_ZIP64_INVALID: locator/record');
      this.metadata(recordSize - 44);
      if (z.readUInt32LE(16) !== 0 || z.readUInt32LE(20) !== 0 || uint64(z, 24) !== uint64(z, 32)) throw new Error('UNPACK_MULTIDISK_UNSUPPORTED');
      this.entryCount = uint64(z, 32); this.centralSize = uint64(z, 40); this.centralOffset = uint64(z, 48); centralEnd = offset;
      if (![0, 0xffff].includes(disk) || ![0, 0xffff].includes(centralDisk) || (count !== 0xffff && count !== this.entryCount) || (diskCount !== 0xffff && diskCount !== this.entryCount) ||
        (e.readUInt32LE(12) !== 0xffffffff && e.readUInt32LE(12) !== this.centralSize) || (e.readUInt32LE(16) !== 0xffffffff && e.readUInt32LE(16) !== this.centralOffset)) throw new Error('UNPACK_ZIP64_INVALID: inconsistent EOCD');
    } else if (disk || centralDisk || diskCount !== count || count === 0xffff || this.centralSize === 0xffffffff || this.centralOffset === 0xffffffff) throw new Error('UNPACK_MULTIDISK_OR_ZIP64_INVALID');
    if (this.entryCount > policy.maxArchiveEntries) throw new Error('UNPACK_ENTRY_LIMIT');
    if (this.centralOffset + this.centralSize !== centralEnd || this.centralSize < this.entryCount * 46 || this.centralOffset < 0) throw new Error('UNPACK_DIRECTORY_INVALID: range/count');
  }
  async plan(onMember: (member: ZipMember) => Promise<void>): Promise<ZipMember[]> {
    const members: ZipMember[] = [];
    for (let index = 0; index < this.entryCount; index++) {
      this.currentItem = null;
      const cursor = this.zip.readEntryCursor, header = await this.read(cursor, 46);
      if (header.readUInt32LE(0) !== 0x02014b50) throw new Error('UNPACK_DIRECTORY_INVALID: central signature');
      const variable = header.readUInt16LE(28) + header.readUInt16LE(30) + header.readUInt16LE(32);
      if (cursor + 46 + variable > this.centralOffset + this.centralSize) throw new Error('UNPACK_DIRECTORY_INVALID: central record bounds');
      this.metadata(variable);
      const rawName = await this.read(cursor + 46, header.readUInt16LE(28));
      const rawPath = yauzl.getFileNameLowLevel(header.readUInt16LE(8), rawName, [], true);
      this.currentItem = { ...emptyUnpackItem(rawPath), archiveIndex: index, rawPath, rawNameHex: rawName.length ? rawName.toString('hex') : null, explicit: true };
      const entry: any = await new Promise((resolve, reject) => {
        const cleanup = () => { this.zip.removeListener('entry', got); this.zip.removeListener('error', fail); this.signal.removeEventListener('abort', interrupted); };
        const got = (value: unknown) => { cleanup(); resolve(value); }, fail = (error: unknown) => { cleanup(); reject(error); }, interrupted = () => fail(this.signal.reason);
        this.zip.once('entry', got); this.zip.once('error', fail); this.signal.addEventListener('abort', interrupted, { once: true }); this.zip.readEntry();
      });
      const fields = extraFields(entry.extraFieldRaw), [bytes, compressed, offset, disk] = extended([header.readUInt32LE(24), header.readUInt32LE(20), header.readUInt32LE(42), header.readUInt16LE(34)], fields);
      if (disk) throw new Error('UNPACK_MULTIDISK_UNSUPPORTED: member');
      if (bytes !== entry.uncompressedSize || compressed !== entry.compressedSize || offset !== entry.relativeOffsetOfLocalHeader) throw new Error('UNPACK_MEMBER_INVALID: parser values');
      const flags = entry.generalPurposeBitFlag;
      if (flags & (1 | 0x40 | 0x2000)) throw new Error('UNPACK_ENCRYPTION_UNSUPPORTED');
      if (flags & ~0x080e || ![0, 8].includes(entry.compressionMethod) || entry.versionNeededToExtract > 45) throw new Error('UNPACK_FORMAT_UNSUPPORTED: flags/method/version');
      const names = decodeName(flags, entry.fileNameRaw, fields), kind = objectKind(entry, names.adopted, fields);
      const item: UnpackItem = { archiveIndex: index, rawPath: names.original, rawNameHex: entry.fileNameRaw.toString('hex'),
        path: (kind === 'directory' ? names.adopted.slice(0, -1) : names.adopted).normalize('NFC'), kind, explicit: true,
        method: entry.compressionMethod === 0 ? 'stored' : 'deflate', declaredBytes: bytes, compressedBytes: compressed, bytes: 0,
        crc32: crcText(entry.crc32), actualCrc32: null, sha256: null, status: 'pending' };
      this.currentItem = item;
      if (kind === 'directory' && (bytes || entry.crc32)) throw new Error('UNPACK_DIRECTORY_INVALID: directory data');
      const local = await this.read(offset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50 || local.readUInt16LE(6) !== flags || local.readUInt16LE(8) !== entry.compressionMethod || local.readUInt16LE(4) !== entry.versionNeededToExtract) throw new Error('UNPACK_LOCAL_INVALID: signature/flags/method/version');
      const localSize = local.readUInt16LE(26) + local.readUInt16LE(28); this.metadata(localSize);
      if (offset + 30 + localSize + compressed > this.centralOffset) throw new Error('UNPACK_LOCAL_INVALID: data bounds');
      const data = await this.read(offset + 30, localSize), localName = data.subarray(0, local.readUInt16LE(26)), localFields = extraFields(data.subarray(local.readUInt16LE(26)));
      objectKind(entry, names.adopted, localFields);
      if (!localName.equals(entry.fileNameRaw)) throw new Error('UNPACK_LOCAL_INVALID: member name mismatch');
      if (decodeName(flags, localName, localFields).adopted !== names.adopted && localFields.some(field => field.id === 0x7075)) throw new Error('UNPACK_LOCAL_INVALID: Unicode path mismatch');
      const [localBytes, localCompressed] = extended([local.readUInt32LE(22), local.readUInt32LE(18)], localFields);
      let memberEnd = offset + 30 + localSize + compressed;
      if (flags & 8) {
        if (![0, bytes].includes(localBytes) || ![0, compressed].includes(localCompressed) || ![0, entry.crc32].includes(local.readUInt32LE(14))) throw new Error('UNPACK_LOCAL_INVALID: descriptor placeholders');
        const firstWord = (await this.read(memberEnd, 4)).readUInt32LE(0);
        const wide = header.readUInt32LE(24) === 0xffffffff || header.readUInt32LE(20) === 0xffffffff || local.readUInt32LE(22) === 0xffffffff || local.readUInt32LE(18) === 0xffffffff;
        let descriptorSize = 0;
        // An unsigned descriptor's CRC can itself equal the optional signature.
        for (const base of firstWord === 0x08074b50 ? [4, 0] : [0]) {
          const length = base + (wide ? 20 : 12);
          if (memberEnd + length > this.centralOffset) continue;
          const descriptor = await this.read(memberEnd, length);
          if (descriptor.readUInt32LE(base) === entry.crc32 && (wide ? descriptor.readBigUInt64LE(base + 4) === BigInt(compressed) : descriptor.readUInt32LE(base + 4) === compressed) && (wide ? descriptor.readBigUInt64LE(base + 12) === BigInt(bytes) : descriptor.readUInt32LE(base + 8) === bytes)) { descriptorSize = length; break; }
        }
        if (!descriptorSize) throw new Error('UNPACK_DESCRIPTOR_INVALID'); memberEnd += descriptorSize;
      } else if (localBytes !== bytes || localCompressed !== compressed || local.readUInt32LE(14) !== entry.crc32) throw new Error('UNPACK_LOCAL_INVALID: size/CRC mismatch');
      if (memberEnd > this.centralOffset) throw new Error('UNPACK_LOCAL_INVALID: member overlaps directory');
      const member = { entry, item, start: offset, end: memberEnd }; members.push(member); await onMember(member);
    }
    if (this.zip.readEntryCursor !== this.centralOffset + this.centralSize) throw new Error('UNPACK_DIRECTORY_INVALID: remaining central data');
    let end = 0;
    for (const member of [...members].sort((a, b) => a.start - b.start)) {
      if (member.start !== end) throw new Error('UNPACK_STRUCTURE_INVALID: overlap/unreferenced local data'); end = member.end;
    }
    if (end !== this.centralOffset) throw new Error('UNPACK_STRUCTURE_INVALID: unreferenced archive data');
    this.currentItem = null; return members;
  }
  async extract(projectDir: string, destination: string | null, member: ZipMember, progress: UnpackProgress): Promise<{ bytes: number; sha256: string; crc32: string }> {
    this.signal.throwIfAborted();
    if (destination) { importProjectPath(projectDir, destination); await ensureImportDirectory(projectDir, dirname(destination)); }
    const output = destination ? await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600) : null;
    let raw: Readable | undefined;
    try {
      if (output) await progress.onCreated();
      raw = await this.zip.openReadStreamPromise(member.entry, { decodeFileData: false });
      const compressed = new Transform({ transform(chunk, _encoding, done) { progress.onCompressed(chunk.length).then(() => done(null, chunk), error => done(error)); } });
      const inflate = member.item.method === 'deflate' ? createInflateRaw() : null;
      const hash = createHash('sha256'); let bytes = 0, crc = 0;
      const writer = new Writable({ write: (chunk: Buffer, _encoding, done) => {
        (async () => {
          progress.admit(chunk.length);
          if (!output && chunk.length) throw new Error('UNPACK_DIRECTORY_INVALID: actual directory data');
          let offset = 0;
          while (offset < chunk.length) {
            this.signal.throwIfAborted();
            const { bytesWritten } = await output!.write(chunk, offset, chunk.length - offset, null);
            if (!bytesWritten) throw new Error('UNPACK_WRITE_FAILED: zero byte write');
            const written = chunk.subarray(offset, offset + bytesWritten); hash.update(written); crc = crc32(written, crc); bytes += bytesWritten; offset += bytesWritten;
            await progress.onWritten(bytesWritten);
          }
        })().then(() => done(), error => done(error));
      } });
      await pipeline([raw!, compressed, ...(inflate ? [inflate] : []), writer], { signal: this.signal });
      if (inflate && inflate.bytesWritten !== member.item.compressedBytes) throw new Error('UNPACK_DEFLATE_INVALID: trailing/unconsumed compressed bytes');
      const actual = { bytes, sha256: hash.digest('hex'), crc32: crcText(crc) };
      if (bytes !== member.item.declaredBytes || actual.crc32 !== member.item.crc32) throw Object.assign(new Error(`UNPACK_INTEGRITY_INVALID: length ${bytes}/${member.item.declaredBytes}; CRC32 ${actual.crc32}/${member.item.crc32}`), { actual });
      await output?.sync(); return actual;
    } finally { raw?.destroy(); await output?.close(); }
  }
  async assertCurrent(): Promise<void> {
    const info = await new NodeImportFiles(dirname(this.path)).inspect(this.path), stat = await this.handle.stat({ bigint: true });
    if (!sameImportNode(this.before, info) || String(stat.dev) !== info.dev || String(stat.ino) !== info.ino || stat.nlink !== 1n || Number(stat.size) !== info.size) throw new Error('UNPACK_ARCHIVE_CHANGED');
  }
  async close(): Promise<void> {
    this.signal.removeEventListener('abort', this.abort); for (const stream of this.streams) stream.destroy();
    this.zip?.close(); await this.handle.close();
  }
}

/** Independent output verification measures CRC32 as well as the byte digest. */
export async function hashUnpackedFile(path: string, signal?: AbortSignal): Promise<{ bytes: number; sha256: string; crc32: string }> {
  assertImportPath(path); const files = new NodeImportFiles(dirname(path)), before = await files.inspect(path);
  if (before.kind !== 'file' || before.nlink !== '1') throw new Error('UNPACK_FILE_INVALID: ordinary independent file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (String(stat.dev) !== before.dev || String(stat.ino) !== before.ino || stat.nlink !== 1n) throw new Error('UNPACK_FILE_CHANGED');
    const buffer = Buffer.alloc(65536), hash = createHash('sha256'); let bytes = 0, crc = 0;
    for (;;) { signal?.throwIfAborted(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead); bytes += bytesRead; crc = crc32(chunk, crc); hash.update(chunk); }
    if (bytes !== before.size || !sameImportNode(before, await files.inspect(path))) throw new Error('UNPACK_FILE_CHANGED');
    return { bytes, sha256: hash.digest('hex'), crc32: crcText(crc) };
  } finally { await handle.close(); }
}
