/**
 * 风格冒烟：经真实管线（validateSpec → createSpecRenderer → renderVideo）为每个风格出 6 秒竖屏短片（3 镜头、2 次风格转场）。
 * 另导出首帧、1.6s 静帧以及每个转场点 ±6 帧的逐帧 PNG 和拼图。
 * 用法：node scripts/theme-smoke.ts <outDir> [theme...]
 * 冒烟用内存中的临时品牌配置逐一锁定各风格（等价于品牌级变更），不改动 .skill/brand.json。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateSpec } from '../src/spec/validate.ts';
import { createSpecRenderer } from '../src/pipeline/spec-renderer.ts';
import { renderVideo } from '../src/pipeline/render-video.ts';
import { makeFrameContext } from '../src/renderer/renderer.ts';
import { THEME_IDS, THEMES, parseBrand, type ThemeId } from '../src/themes/index.ts';
import { outputPath } from '../src/utils/output-dir.ts';

const out = process.argv[2] || outputPath('theme-smoke');
const only = process.argv.slice(3) as ThemeId[];
mkdirSync(out, { recursive: true });
type Shot = { kicker?: string; lines: string[]; ip?: { role: 'identity' | 'actor'; size?: number; position?: string; expression?: string } };
const COPY: Record<ThemeId, Shot[]> = {
  // IP 规则：文字镜头不放 IP；只在身份声明（片尾署名）或讲解动画演员时出现，尺寸 ≤ 源 512
  minimal: [{ lines: ['电脑', '不会焦虑。'] }, { lines: ['它只做一件事：', '拆解。'] }, { kicker: 'ONEINO.澄记', lines: ['用计算机思维', '想现实。'], ip: { role: 'identity', size: 288, expression: 'happy' } }],
  kinetic: [{ kicker: 'AI WORKFLOW', lines: ['3 秒', '搞定。'] }, { lines: ['快', '十倍。'] }, { lines: ['你也', '可以。'], ip: { role: 'identity', size: 288, expression: 'excited' } }],
  terminal: [{ kicker: '$ think --life', lines: ['拆解问题'] }, { lines: ['输入 → 处理', '→ 输出'] }, { lines: ['一行一行', '跑通。'], ip: { role: 'identity', size: 256, position: 'bottom-right' } }],
  crayon: [{ lines: ['把烦恼', '拆成三步'] }, { lines: ['一步', '一步来。'], ip: { role: 'actor', size: 384, expression: 'happy' } }, { lines: ['画给你看。'] }],
  storybook: [{ lines: ['雨夜里，', '电脑也在想'] }, { lines: ['关于人生的', '小事'] }, { lines: ['晚安。'] }],
};
const FPS = 30, SHOT = 2, N = 3, DUR = SHOT * N;
for (const id of (only.length ? only : THEME_IDS)) {
  const th = THEMES[id], shots = COPY[id];
  const env = id === 'storybook' ? 'rain_window' : 'theme_stage';
  const trs = th.transitions.filter((t) => t !== 'cutOnBeat');
  const raw = {
    video: { width: 1080, height: 1920, fps: FPS, duration: DUR, seed: 20261013 },
    style: { theme: id }, captions: { enabled: false },
    scenes: shots.map((s, i) => ({
      id: `s${i + 1}`, start: i * SHOT, end: (i + 1) * SHOT, environment: env, camera: 'medium',
      ...(i > 0 ? { transition: trs[(i - 1) % trs.length] } : {}),
      headline: s.lines, ...(s.kicker ? { kicker: s.kicker } : {}), ...(s.ip ? { ip: s.ip } : {}),
    })),
  };
  const brand = parseBrand({ version: 1, lockedTheme: id, enforcement: 'reject', changes: [{ at: '2026-10-13', theme: id, reason: 'smoke' }] });
  const { spec, issues } = validateSpec(raw, { brand });
  if (!spec) throw new Error(`${id}: spec 无效`);
  const warnings: string[] = [];
  const renderer = createSpecRenderer({ spec, onWarning: (m) => warnings.push(m) });
  const res = await renderVideo({ renderer, fps: FPS, durationSeconds: DUR, seed: spec.video.seed, outPath: join(out, `${id}.mp4`) });
  const frameAt = (i: number) => { renderer.renderFrame(makeFrameContext({ frameIndex: i, totalFrames: FPS * DUR, fps: FPS, width: 1080, height: 1920, seed: spec.video.seed })); return renderer.toPng(); };
  writeFileSync(join(out, `${id}.png`), frameAt(Math.round(1.6 * FPS)));
  writeFileSync(join(out, `${id}_frame000.png`), frameAt(0));
  const dir = join(out, `${id}_transitions`); mkdirSync(dir, { recursive: true });
  for (let s = 1; s < N; s++) {
    const cut = s * SHOT * FPS, names: string[] = [];
    for (let f = cut - 6; f <= cut + 6; f++) { const n = join(dir, `t${s}_${String(f).padStart(3, '0')}.png`); writeFileSync(n, frameAt(f)); names.push(n); }
    spawnSync('ffmpeg', ['-v', 'error', '-y', ...names.flatMap((n) => ['-i', n]), '-filter_complex', `${names.map((_, i) => `[${i}]scale=216:-1[v${i}]`).join(';')};${names.map((_, i) => `[v${i}]`).join('')}xstack=inputs=${names.length}:layout=${names.map((_, i) => `${(i % 7) * 216}_${Math.floor(i / 7) * 384}`).join('|')}:fill=black`, join(out, `${id}_t${s}_contact.jpg`)]);
  }
  console.log(JSON.stringify({ id, transitions: spec.scenes.slice(1).map((s) => s.transition), frames: res.frames, msPerFrame: Math.round(res.msPerFrame), issues: issues.filter((i) => i.severity !== 'SAFE_REPAIR').map((i) => i.code), warnings }));
  renderer.dispose();
}
