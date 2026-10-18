/**
 * 生成角色片段合成、节拍网格与 TTS 切点：全部使用测试内生成的虚构夹具，不读取任何真实素材。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Canvas, ImageData } from 'skia-canvas';
import { FLAT_BACKDROP, WHITE_BACKDROP, alphaBBox, borderMedian, keyBackground } from '../src/footage/key.ts';
import { RIM_ALPHA_MAX, blendIndex, capScale, drawCharacterLayer, fadeBottom, mixRgba, planRetime, retimeAt, withAlpha } from '../src/footage/composite.ts';
import { keyVideoToFrames, openKeyedClip } from '../src/footage/keyed-clip.ts';
import { addCutAccents, beatGrid, snapCutsToBeats } from '../src/audio/beat-grid.ts';
import { synthBgm } from '../src/audio/bgm/procedural.ts';
import { gapMidpointCuts, phraseCut } from '../src/motion/shot-timing.ts';
import { SAFE_AREA, VERTICAL_SHORT_CAPTION_INSET, VERTICAL_SHORT_LAYOUT, bigTextBaselineFor } from '../src/themes/shared.ts';
import { fileHashes } from '../workspace.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);
const at = (rgba: ArrayLike<number>, w: number, x: number, y: number) => Array.from({ length: 4 }, (_, c) => rgba[(y * w + x) * 4 + c] as number);

/** 虚构夹具：平涂灰底 #3a3a3a 上的「角色」——深色身体（与键色接近）、手臂围出的灰色封闭区、身体内部一块键色补丁。 */
function greyFixture(w = 64, h = 96) {
  const px = new Uint8ClampedArray(w * h * 4);
  const set = (x: number, y: number, c: readonly number[]) => { const i = (y * w + x) * 4; px[i] = c[0]!; px[i + 1] = c[1]!; px[i + 2] = c[2]!; px[i + 3] = 255; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) set(x, y, [58, 58, 58]);
  // 身体：近黑衣物（键距 40，大于阈值）
  for (let y = 20; y < 90; y++) for (let x = 16; x < 48; x++) set(x, y, [18, 18, 20]);
  // 手臂围成的环：内部 14×14 的灰底封闭区（应当抠掉）
  for (let y = 30; y < 54; y++) for (let x = 2; x < 16; x++) set(x, y, [18, 18, 20]);
  for (let y = 34; y < 50; y++) for (let x = 4; x < 14; x++) set(x, y, [58, 58, 58]);
  // 身体内部的小块键色（面积 9 < pocketMinArea，属于前景细节，应保留）
  for (let y = 60; y < 63; y++) for (let x = 30; x < 33; x++) set(x, y, [58, 58, 58]);
  return { px, w, h };
}

test('抠像：边框连通的灰底变透明，深色衣物与小块键色细节保留', () => {
  const { px, w, h } = greyFixture();
  const r = keyBackground(px, w, h, FLAT_BACKDROP);
  assert.deepEqual(r.key, [58, 58, 58]);
  assert.equal(at(r.rgba, w, 1, 1)[3], 0);                 // 背景
  assert.equal(at(r.rgba, w, 30, 40)[3], 255);              // 身体中心
  assert.equal(at(r.rgba, w, 31, 61)[3], 255);              // 小补丁保留
  assert.equal(at(r.rgba, w, 8, 42)[3], 0);                 // 封闭灰区抠掉
  // 1px 收缩：身体最外一列不再完全不透明
  assert.ok(at(r.rgba, w, 47, 60)[3]! < 255);
  assert.ok(r.bbox && r.bbox[0] >= 1 && r.bbox[2] <= 49 && r.bbox[1] >= 19);
});

test('抠像：去溢色把半透明边缘里的键色反混合掉', () => {
  const { px, w, h } = greyFixture();
  const r = keyBackground(px, w, h, { ...FLAT_BACKDROP, feather: 1.2 });
  let checked = 0;
  for (let y = 25; y < 85; y++) for (let x = 40; x < 52; x++) {
    const [red, , , a] = at(r.rgba, w, x, y);
    if (a! > 30 && a! < 230) { assert.ok(red! < 40, `边缘像素 (${x},${y}) 仍带灰：${red}`); checked++; }
  }
  assert.ok(checked > 0);
});

test('抠像：白底预设同时去掉中性灰阴影，彩色主体保留', () => {
  const w = 48, h = 48, px = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (y >= 34 && y < 40 && x >= 10 && x < 38) { px[i] = px[i + 1] = px[i + 2] = 196; }       // 灰阴影
    if (y >= 10 && y < 34 && x >= 14 && x < 34) { px[i] = 255; px[i + 1] = 199; px[i + 2] = 18; } // 黄色主体
  }
  const r = keyBackground(px, w, h, WHITE_BACKDROP);
  assert.equal(at(r.rgba, w, 24, 37)[3], 0);
  assert.equal(at(r.rgba, w, 24, 20)[3], 255);
  assert.deepEqual(borderMedian(px, w, h), [255, 255, 255]);
  assert.deepEqual(alphaBBox(new Uint8ClampedArray(16), 2, 2), null);
});

test('变速贴槽：0.75–1.5× 内线性贴满；过长截断；过短正反往复，任何时刻都不冻结', () => {
  const lin = planRetime(4, 4.8);
  assert.equal(lin.mode, 'linear'); near(lin.rate, 1.2); near(retimeAt(lin, 4), 4.8);
  const trim = planRetime(2, 5); assert.equal(trim.mode, 'trim'); near(trim.rate, 1.5); near(retimeAt(trim, 2), 3);
  const short = planRetime(6, 2); assert.equal(short.mode, 'tail'); near(short.rate, 0.75);
  near(retimeAt(short, 2 / 0.75), 2);                         // 恰好播完
  near(retimeAt(short, 3 / 0.75), 1);                         // 往回播
  const loop = planRetime(6, 2, { tail: 'loop' }); near(retimeAt(loop, 3 / 0.75), 1);
  for (const plan of [lin, trim, short]) {
    let prev = retimeAt(plan, 0), stuck = 0;
    for (let f = 1; f <= plan.slot * 60; f++) {
      const v = retimeAt(plan, f / 60);
      assert.ok(v >= 0 && v <= plan.clip + 1e-9);
      if (Math.abs(v - prev) < 1e-9) stuck++; prev = v;
    }
    assert.equal(stuck, 0, `${plan.mode} 出现冻结帧`);
  }
  assert.throws(() => planRetime(0, 1), /RETIME_RANGE/);
});

test('帧混合：24→60fps 取相邻两帧与权重；预乘混合不产生暗边', () => {
  const b = blendIndex(0.5, 24, 100); assert.equal(b.a, 12); assert.equal(b.b, 13); near(b.w, 0);
  const c = blendIndex(13.4 / 24, 24, 100); assert.equal(c.a, 13); near(c.w, 0.4, 1e-6);
  const end = blendIndex(99, 24, 10); assert.equal(end.a, 9); assert.equal(end.b, 9); assert.equal(end.w, 0);
  const A = new Uint8ClampedArray([200, 100, 0, 255]), B = new Uint8ClampedArray([0, 0, 0, 0]);
  const m = mixRgba(A, B, 0.5);
  assert.deepEqual(Array.from(m.slice(0, 3)), [200, 100, 0]);  // 与全透明混合只降 alpha，不变暗
  near(m[3]!, 128, 1);
  const n = mixRgba(new Uint8ClampedArray([0, 0, 0, 255]), new Uint8ClampedArray([100, 100, 100, 255]), 0.25);
  near(n[0]!, 25, 1);
});

test('底部渐隐、尺寸上限与轮廓光上限', () => {
  const w = 2, h = 10, px = new Uint8ClampedArray(w * h * 4).fill(255);
  fadeBottom(px, w, h, 4, 8);
  assert.equal(px[(3 * w) * 4 + 3], 255); near(px[(6 * w) * 4 + 3]!, 127.5, 1); assert.equal(px[(9 * w) * 4 + 3], 0);
  near(capScale(2, 1), 1); near(capScale(0.8, 1.1), 0.8); near(capScale(1, 1.25), 0.8);
  const layer = new Canvas(10, 20); const lg = layer.getContext('2d'); lg.fillStyle = '#fff'; lg.fillRect(0, 0, 10, 20);
  const out = new Canvas(100, 100), ctx = out.getContext('2d');
  ctx.scale(2, 2); // 相机推镜 2×
  const r = drawCharacterLayer(ctx, layer, { x: 25, y: 45, scale: 3, rim: { color: '#FFB340', alpha: 0.6 } });
  near(r.scale, 0.5); near(r.screenScale, 1);
  assert.ok(RIM_ALPHA_MAX <= 0.15);
  assert.equal(withAlpha('#FFB340', 0.15), 'rgba(255,179,64,0.15)');
  // 底锚：角色下沿落在 y=45（画布坐标 ×2 = 90）
  const img = ctx.getImageData(0, 0, 100, 100).data;
  assert.ok(img[(89 * 100 + 50) * 4 + 3]! > 200); assert.ok(img[(92 * 100 + 50) * 4 + 3]! < 120);
});

test('抠像帧序列：合成视频 → 透明 PNG + meta，按槽位变速并混合取帧', { skip: !hasFfmpeg }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jbm-keyed-'));
  try {
    const clip = join(dir, 'clip.mp4');
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x3a3a3a:s=64x96:r=24:d=1',
      '-f', 'lavfi', '-i', 'color=c=0x101012:s=24x60:r=24:d=1', '-filter_complex', "[0][1]overlay=x='10+t*20':y=20", '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '12', clip]);
    assert.equal(r.status, 0, String(r.stderr));
    const meta = await keyVideoToFrames(clip, join(dir, 'keyed'));
    assert.equal(meta.frames, 24); near(meta.fps, 24); near(meta.duration, 23 / 24);
    assert.ok(meta.bbox && meta.bbox[0] <= 12 && meta.bbox[2] >= 50);
    const k = openKeyedClip(join(dir, 'keyed'), 1.0);
    assert.equal(k.plan.mode, 'linear');
    const f = k.frameAt(0.5).getContext('2d').getImageData(0, 0, 64, 96).data;
    assert.equal(f[(2 * 64 + 2) * 4 + 3], 0);                  // 背景透明
    const row = 50; let opaque = 0; for (let x = 0; x < 64; x++) if (f[(row * 64 + x) * 4 + 3]! > 200) opaque++;
    assert.ok(opaque >= 18 && opaque <= 26, `主体宽度 ${opaque}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('节拍网格：乘法换算无累计误差，整数帧号与小节重拍', () => {
  const g = beatGrid({ bpm: 120, duration: 600, fps: 30 });
  assert.equal(g.length, 1201); near(g[1200]!.time, 600); assert.equal(g[1200]!.frame, 18000);
  assert.equal(g[4]!.downbeat, true); assert.equal(g[5]!.downbeat, false); assert.equal(g[1]!.frame, 15);
  const odd = beatGrid({ bpm: 97, duration: 30, origin: 0.2, fps: 60 });
  near(odd[40]!.time, 0.2 + 40 * 60 / 97, 1e-6); assert.ok(odd.at(-1)!.time <= 30);
});

test('切点吸附：maxShift 内吸到拍点，超出保留原值，later 只向后，minGap 保护', () => {
  const g = beatGrid({ bpm: 120, duration: 10 });
  const s = snapCutsToBeats([1.06, 2.3, 3.97], g);
  near(s[0]!.time, 1); assert.equal(s[0]!.kept, false); near(s[0]!.shift, -0.06);
  near(s[1]!.time, 2.3); assert.equal(s[1]!.kept, true);
  near(s[2]!.time, 4);
  const later = snapCutsToBeats([1.06], g, { direction: 'later', maxShift: 0.5 }); near(later[0]!.time, 1.5);
  const gap = snapCutsToBeats([1.02, 1.08], g, { minGap: 0.3 }); near(gap[0]!.time, 1); near(gap[1]!.time, 1.08); assert.equal(gap[1]!.kept, true);
  const bars = snapCutsToBeats([2.1], g, { downbeatsOnly: true, maxShift: 0.2 }); near(bars[0]!.time, 2);
});

test('切点重音：在切点处出现瞬态且确定性，峰值不削波', () => {
  const mk = () => addCutAccents(synthBgm({ preset: 'tender', key: 'D', seed: 3, durationSeconds: 4 }), { cuts: [2], accents: [3], seed: 5 });
  const a = mk(), b = mk();
  assert.deepEqual(Array.from(a.left.slice(96000, 96500)), Array.from(b.left.slice(96000, 96500)));
  let peak = 0; for (let i = 0; i < a.left.length; i++) peak = Math.max(peak, Math.abs(a.left[i]!));
  assert.ok(peak <= 0.98 + 1e-6);
  const base = synthBgm({ preset: 'tender', key: 'D', seed: 3, durationSeconds: 4 });
  let diff = 0; for (let i = 96000; i < 96000 + 4800; i++) diff += Math.abs(a.left[i]! - base.left[i]!);
  assert.ok(diff > 1, '切点后应有可听的重音');
});

test('TTS 切点：句间取空隙中点，句内提前 0.05s 且不早于上一短语结束', () => {
  assert.deepEqual(gapMidpointCuts([{ start: 0, end: 1.2 }, { start: 1.6, end: 3 }, { start: 2.9, end: 4 }]), [1.4, 2.9]);
  near(phraseCut(2.0, 2.3), 2.25); near(phraseCut(2.28, 2.3), 2.28);
});

test('竖屏 9:16 版面默认值互相一致', () => {
  const L = VERTICAL_SHORT_LAYOUT;
  assert.deepEqual(L.safe, SAFE_AREA.vertical);
  near(VERTICAL_SHORT_CAPTION_INSET * 1920, 340);
  assert.ok(L.visualCenterY < L.bigTextBaseline && L.bigTextBaseline < L.subtitleGlyphBottom);
  // 46px 字幕上沿约 1535；84px 大字下伸约 20 → 基线不高于默认值且留足 128
  const base = bigTextBaselineFor(1535, 20);
  assert.equal(base, 1330); assert.ok(1535 - (base + 20) >= 128);
  assert.ok(bigTextBaselineFor(1535, 20, 60) < 1330);
});

test('豆包配音辅助脚本：只读环境变量，句级时间去重', { skip: spawnSync('python3', ['--version']).status !== 0 }, () => {
  const helper = fileURLToPath(new URL('../scripts/doubao-tts-helper.py', import.meta.url));
  const scriptsBefore = fileHashes(dirname(helper));
  const home = mkdtempSync(join(tmpdir(), 'jbm-home-'));
  try {
    mkdirSync(join(home, '.config', 'jbm'), { recursive: true });
    writeFileSync(join(home, '.config', 'jbm', 'doubao.env'), 'DOUBAO_API_KEY=PLACEHOLDER_FIXTURE_VALUE\n');
    const env = { PATH: process.env.PATH ?? '', HOME: home };
    const r = spawnSync('python3', [helper, '--text', '虚构', '--speaker', 's', '--resource', 'seed-tts-2.0', '--transport', 'http', '--out-audio', join(home, 'a.wav'), '--out-json', join(home, 'a.json')], { encoding: 'utf8', env });
    assert.notEqual(r.status, 0); assert.match(r.stdout, /DOUBAO_API_KEY is required/);
    const code = `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('h',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
w,s,seen=[],[],set()
body={'text':'甲乙','words':[{'word':'甲','startTime':0.1,'endTime':0.3},{'word':'乙','startTime':0.3,'endTime':0.6}]}
m.add_words(w,body,s,seen);m.add_words(w,body,s,seen)
print(json.dumps({'w':len(w),'s':s}))`;
    const p = spawnSync('python3', ['-B', '-c', code, helper], { encoding: 'utf8', env });
    assert.equal(p.status, 0, p.stderr);
    assert.deepEqual(JSON.parse(p.stdout), { w: 2, s: [{ text: '甲乙', start: 0.1, end: 0.6 }] });
    assert.deepEqual(fileHashes(dirname(helper)), scriptsBefore, '辅助脚本导入须保持封存运行时字节不变');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
