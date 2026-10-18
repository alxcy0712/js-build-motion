/**
 * 平涂背景抠像命令。
 *   视频：node .skill/scripts/video.mjs <slug> exec node .engine/scripts/key-footage.ts <clip.mp4> <outDir> [--preset flat|white] [--key #RRGGBB] [--tolerance 11]
 *         → outDir/f000000.png … + meta.json（渲染时用 openKeyedClip 读取）
 *   图片：node .skill/scripts/video.mjs <slug> exec node .engine/scripts/key-footage.ts <subject.png> <out.png> [--preset white] [--square 1254 --fill 0.8]
 *         → 透明 PNG；--square 时按主体包围盒裁切并居中放进透明方图，主体最长边占 fill
 * 输出写到本片 out/。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { Canvas, Image, ImageData } from 'skia-canvas';
import { FLAT_BACKDROP, WHITE_BACKDROP, keyBackground, type KeyOptions } from '../src/footage/key.ts';
import { keyVideoToFrames, rgbaToPng } from '../src/footage/keyed-clip.ts';
import { IMAGE_EXT, VIDEO_EXT } from '../src/footage/spec.ts';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const [input, output] = positional;
if (!input || !output) { console.error('用法见文件头注释'); process.exit(2); }
const preset = flag('preset') === 'white' ? WHITE_BACKDROP : FLAT_BACKDROP;
const hex = flag('key');
const opts: KeyOptions = {
  ...preset,
  ...(hex ? { key: [0, 2, 4].map((i) => parseInt(hex.replace('#', '').slice(i, i + 2), 16)) as unknown as readonly [number, number, number] } : {}),
  ...(flag('tolerance') ? { tolerance: Number(flag('tolerance')) } : {}),
};
const ext = extname(input).toLowerCase();
if ((VIDEO_EXT as readonly string[]).includes(ext)) {
  const meta = await keyVideoToFrames(input, output, opts);
  console.log(JSON.stringify(meta));
} else if ((IMAGE_EXT as readonly string[]).includes(ext)) {
  const img = new Image(); img.src = readFileSync(input);
  const w = img.width, h = img.height, c = new Canvas(w, h), g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const r = keyBackground(g.getImageData(0, 0, w, h).data, w, h, opts);
  if (!r.bbox) { console.error('KEY_EMPTY: 抠像后没有前景，检查键色与阈值'); process.exit(1); }
  let png = rgbaToPng(r.rgba, w, h);
  const square = Number(flag('square') ?? 0);
  if (square > 0) {
    const fill = Number(flag('fill') ?? 0.8);
    const src = new Canvas(w, h); src.getContext('2d').putImageData(new ImageData(r.rgba, w, h), 0, 0);
    const [x0, y0, x1, y1] = r.bbox, bw = x1 - x0, bh = y1 - y0, s = (square * fill) / Math.max(bw, bh);
    const out = new Canvas(square, square), o = out.getContext('2d');
    o.imageSmoothingQuality = 'high';
    o.drawImage(src, x0, y0, bw, bh, (square - bw * s) / 2, (square - bh * s) / 2, bw * s, bh * s);
    png = out.toBufferSync('png');
  }
  mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, png);
  console.log(JSON.stringify({ output, key: r.key, bbox: r.bbox, width: w, height: h }));
} else { console.error(`不支持的扩展名 ${ext}`); process.exit(2); }
