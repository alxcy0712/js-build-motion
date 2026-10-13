export interface ImageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Center a source crop with a uniform scale for Canvas drawImage's nine arguments. */
export function fitImage(source: ImageRect, target: ImageRect, fit: 'contain' | 'cover'): { source: ImageRect; destination: ImageRect } {
  for (const rect of [source, target]) {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) {
      throw new Error('IMAGE_FIT_INVALID_RECT: 图片裁框和目标框需要有限坐标及正尺寸');
    }
  }
  if (fit !== 'contain' && fit !== 'cover') throw new Error('IMAGE_FIT_INVALID_MODE: 使用 contain 或 cover');
  const scale = (fit === 'contain' ? Math.min : Math.max)(target.width / source.width, target.height / source.height);
  if (fit === 'contain') {
    const width = source.width * scale, height = source.height * scale;
    return { source: { ...source }, destination: { x: target.x + (target.width - width) / 2, y: target.y + (target.height - height) / 2, width, height } };
  }
  const width = target.width / scale, height = target.height / scale;
  return { source: { x: source.x + (source.width - width) / 2, y: source.y + (source.height - height) / 2, width, height }, destination: { ...target } };
}
