/**
 * 审片用死帧检查。用法：
 *   node scripts/dead-frame-qa.ts <video.mp4> [--fps 30] [--min 0.5] [--threshold 1.5] [--width 540] [--json]
 * 用 ffmpeg 抽灰度帧（默认 540 宽、30fps），报告 ≥ min 秒无可见变化的区间；有死帧时退出码 2。
 */
import { spawnSync } from 'node:child_process';
import { findDeadSpans, type GrayFrame } from '../src/qa/dead-frames.ts';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (k: string, d: number) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
if (!file) { console.error('用法: node scripts/dead-frame-qa.ts <video> [--fps 30] [--min 0.5] [--threshold 1.5] [--width 540] [--json]'); process.exit(64); }
const fps = opt('fps', 30), width = opt('width', 540), minSeconds = opt('min', 0.5), threshold = opt('threshold', 1.5);
const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
const [sw, sh] = probe.stdout.trim().split(',').map(Number);
if (!sw || !sh) { console.error('ffprobe 读取失败'); process.exit(66); }
const height = Math.round((sh / sw) * width / 2) * 2;
const ff = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `fps=${fps},scale=${width}:${height}:flags=area,format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 2 ** 31 });
if (ff.status !== 0) { console.error(String(ff.stderr)); process.exit(70); }
const size = width * height, frames: GrayFrame[] = [];
for (let o = 0; o + size <= ff.stdout.length; o += size) frames.push({ width, height, data: new Uint8Array(ff.stdout.buffer, ff.stdout.byteOffset + o, size) });
const spans = findDeadSpans(frames, { fps, minSeconds, threshold });
const report = { file, fps, frames: frames.length, minSeconds, threshold, deadSpans: spans.map((s) => ({ from: +s.startSec.toFixed(2), to: +s.endSec.toFixed(2), seconds: +(s.endSec - s.startSec).toFixed(2), maxScore: +s.maxScore.toFixed(2) })) };
if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`${file}: ${frames.length} 帧 @${fps}fps，阈值 ${threshold}，窗口 ${minSeconds}s`);
  if (!spans.length) console.log('✓ 未发现死帧');
  for (const s of report.deadSpans) console.log(`✖ 死帧 ${s.from}s–${s.to}s（${s.seconds}s，峰值变化 ${s.maxScore}）`);
}
process.exit(spans.length ? 2 : 0);
