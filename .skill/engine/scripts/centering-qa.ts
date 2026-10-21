/**
 * 审片用居中检查。用法：
 *   node scripts/centering-qa.ts <frame.png> [...] [--tolerance 0.02] [--threshold 48] [--exclude x,y,w,h] [--json]
 * 报告每张画面可见像素对比加权重心相对画布中心的偏移；诊断候选退出码 0；工具运行失败使用非零退出码。
 */
import { loadImage, Canvas } from 'skia-canvas';
import { isCentered, measureContentCenter, centerDiagnostic, type Rect, type ContentCenter } from '../src/qa/centering.ts';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const valueFlags = new Set(['--tolerance', '--threshold', '--exclude']);
const files = args.filter((a, i) => !a.startsWith('--') && !valueFlags.has(args[i - 1] ?? ''));
if (!files.length) { console.error('用法: node scripts/centering-qa.ts <frame.png> [...] [--tolerance 0.02] [--threshold 48] [--exclude x,y,w,h] [--json]'); process.exit(64); }
const toleranceX = Number(opt('tolerance') ?? 0.02), threshold = Number(opt('threshold') ?? 48);
const exclude: Rect[] = opt('exclude') ? [(([x, y, width, height]) => ({ x: x!, y: y!, width: width!, height: height! }))(opt('exclude')!.split(',').map(Number))] : [];
const results = [];
let previous: ContentCenter | null = null;
for (const file of files) {
  const img = await loadImage(file); const c = new Canvas(img.width, img.height); const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const m = measureContentCenter({ width: c.width, height: c.height, data: g.getImageData(0, 0, c.width, c.height).data }, { threshold, exclude });
  results.push({ file, ok: true, centered: isCentered(m, { toleranceX }), diagnostic: centerDiagnostic(m, previous, c.width, c.height), ...(m ?? {}) }); previous = m;
}
if (args.includes('--json')) console.log(JSON.stringify(results, null, 2));
else for (const r of results) console.log(`${r.diagnostic.status} ${r.file}: ${'offsetX' in r ? `x ${(r.offsetX! * 100).toFixed(1)}% · y ${(r.offsetY! * 100).toFixed(1)}%` : '无内容'}`);
process.exit(0);
