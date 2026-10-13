/**
 * 文件/文本哈希（task-4、task-5 共用）。
 *
 * 通过文件与文本哈希核对本次成片实际采用的素材和源码。
 */

import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

export function sha256Bytes(data: Buffer | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

/** 读取文件并计算 sha256；文件不存在时抛错，交由调用方决定错误码 */
export function sha256File(path: string): string {
  const fd = openSync(path, 'r'), digest = createHash('sha256'), buffer = Buffer.alloc(65536);
  try {
    const before = fstatSync(fd, { bigint: true }); let position = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, position); if (!count) break;
      digest.update(buffer.subarray(0, count)); position += count;
    }
    const after = fstatSync(fd, { bigint: true });
    if (position !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error('HASH_FILE_CHANGED: ' + path);
    return digest.digest('hex');
  } finally { closeSync(fd); }
}

/** 短哈希：只用于展示与 id 拼接，不用于校验 */
export function shortHash(hex: string, length = 8): string {
  return hex.slice(0, length);
}
