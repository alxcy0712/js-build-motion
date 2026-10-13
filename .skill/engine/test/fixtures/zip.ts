import { crc32, deflateRawSync } from 'node:zlib';
export interface ZipSpec {
  name: string | Buffer; data?: string | Buffer; directory?: boolean; method?: number; flags?: number;
  descriptor?: boolean; descriptorSignature?: boolean; extra?: Buffer; localExtra?: Buffer; comment?: Buffer;
  attrs?: number; host?: number; crc?: number; declaredBytes?: number; localName?: Buffer; localOffset?: number; disk?: number; compressedData?: Buffer;
}
export function zipExtra(id: number, data: Buffer): Buffer { const header = Buffer.alloc(4); header.writeUInt16LE(id); header.writeUInt16LE(data.length, 2); return Buffer.concat([header, data]); }
export function unicodePath(raw: Buffer, name: string, correct = true): Buffer {
  const header = Buffer.alloc(5); header[0] = 1; header.writeUInt32LE(correct ? crc32(raw) : crc32(raw) ^ 1, 1);
  return zipExtra(0x7075, Buffer.concat([header, Buffer.from(name)]));
}
function wide(values: number[]): Buffer { const data = Buffer.alloc(values.length * 8); values.forEach((value, i) => data.writeBigUInt64LE(BigInt(value), i * 8)); return zipExtra(1, data); }
/** Fictional ZIPs are assembled from format fields so malformed declarations stay reproducible. */
export function makeZip(specs: ZipSpec[], options: { zip64?: boolean; comment?: Buffer; disk?: number; count?: number; centralDisk?: number; zip64Extension?: Buffer } = {}): Buffer {
  const locals: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const spec of specs) {
    const name = Buffer.isBuffer(spec.name) ? spec.name : Buffer.from(spec.name), localName = spec.localName ?? name;
    const directory = spec.directory ?? name.toString().endsWith('/'), method = spec.method ?? (directory ? 0 : 8);
    const data = Buffer.isBuffer(spec.data) ? spec.data : Buffer.from(spec.data ?? ''), compressed = spec.compressedData ?? (method === 8 ? deflateRawSync(data) : data);
    const crc = spec.crc ?? crc32(data), bytes = spec.declaredBytes ?? data.length, flags = (spec.flags ?? 0x800) | (spec.descriptor ? 8 : 0);
    const zip64 = options.zip64, version = zip64 ? 45 : 20;
    const localExtra = Buffer.concat([zip64 ? wide([spec.descriptor ? 0 : bytes, spec.descriptor ? 0 : compressed.length]) : Buffer.alloc(0), spec.localExtra ?? spec.extra ?? Buffer.alloc(0)]);
    const extra = Buffer.concat([zip64 ? wide([bytes, compressed.length, offset]) : Buffer.alloc(0), spec.extra ?? Buffer.alloc(0)]), comment = spec.comment ?? Buffer.alloc(0);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(version, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(spec.descriptor ? 0 : crc, 14); local.writeUInt32LE(zip64 ? 0xffffffff : spec.descriptor ? 0 : compressed.length, 18); local.writeUInt32LE(zip64 ? 0xffffffff : spec.descriptor ? 0 : bytes, 22);
    local.writeUInt16LE(localName.length, 26); local.writeUInt16LE(localExtra.length, 28);
    let descriptor = Buffer.alloc(0);
    if (spec.descriptor) {
      const signature = spec.descriptorSignature !== false, base = signature ? 4 : 0; descriptor = Buffer.alloc(base + (zip64 ? 20 : 12));
      if (signature) descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, base);
      if (zip64) { descriptor.writeBigUInt64LE(BigInt(compressed.length), base + 4); descriptor.writeBigUInt64LE(BigInt(bytes), base + 12); }
      else { descriptor.writeUInt32LE(compressed.length, base + 4); descriptor.writeUInt32LE(bytes, base + 8); }
    }
    const localRecord = Buffer.concat([local, localName, localExtra, compressed, descriptor]); locals.push(localRecord);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(((spec.host ?? 3) << 8) | version, 4); c.writeUInt16LE(version, 6); c.writeUInt16LE(flags, 8); c.writeUInt16LE(method, 10);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(zip64 ? 0xffffffff : compressed.length, 20); c.writeUInt32LE(zip64 ? 0xffffffff : bytes, 24);
    c.writeUInt16LE(name.length, 28); c.writeUInt16LE(extra.length, 30); c.writeUInt16LE(comment.length, 32); c.writeUInt16LE(spec.disk ?? 0, 34);
    c.writeUInt32LE((spec.attrs ?? (directory ? 0x41ed0010 : 0x81a40000)) >>> 0, 38); c.writeUInt32LE(spec.localOffset ?? (zip64 ? 0xffffffff : offset), 42);
    central.push(Buffer.concat([c, name, extra, comment])); offset += localRecord.length;
  }
  const directory = Buffer.concat(central), comment = options.comment ?? Buffer.alloc(0), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(options.disk ?? 0, 4); end.writeUInt16LE(options.centralDisk ?? 0, 6); end.writeUInt16LE(options.count ?? (options.zip64 ? 0xffff : specs.length), 8); end.writeUInt16LE(options.count ?? (options.zip64 ? 0xffff : specs.length), 10);
  end.writeUInt32LE(options.zip64 ? 0xffffffff : directory.length, 12); end.writeUInt32LE(options.zip64 ? 0xffffffff : offset, 16); end.writeUInt16LE(comment.length, 20);
  const endings: Buffer[] = [];
  if (options.zip64) {
    const extension = options.zip64Extension ?? Buffer.alloc(0), z = Buffer.alloc(56), locator = Buffer.alloc(20);
    z.writeUInt32LE(0x06064b50); z.writeBigUInt64LE(BigInt(44 + extension.length), 4); z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(specs.length), 24); z.writeBigUInt64LE(BigInt(specs.length), 32); z.writeBigUInt64LE(BigInt(directory.length), 40); z.writeBigUInt64LE(BigInt(offset), 48);
    locator.writeUInt32LE(0x07064b50); locator.writeBigUInt64LE(BigInt(offset + directory.length), 8); locator.writeUInt32LE(1, 16); endings.push(z, extension, locator);
  }
  return Buffer.concat([...locals, directory, ...endings, end, comment]);
}
