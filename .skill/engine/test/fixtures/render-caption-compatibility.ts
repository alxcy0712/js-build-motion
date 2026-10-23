/** Synthetic, fixed-font/seed compatibility oracle. Optional output dir also checks encoded media. */
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Canvas } from 'skia-canvas';
import { createSpecRenderer } from '../../src/pipeline/spec-renderer.ts';
import { renderVideo } from '../../src/pipeline/render-video.ts';
import { makeFrameContext } from '../../src/renderer/renderer.ts';
import { validateSpec } from '../../src/spec/validate.ts';
import { getTheme } from '../../src/themes/registry.ts';
import { buildCaptionTrack } from '../../src/captions/track.ts';
// Fixed CPU goldens also run under a host sandbox that cannot initialize Metal.
// The optional --gpu comparison uses the unchanged production renderer on both revisions.
if (process.argv[3] !== '--gpu') {
  const getContext = Canvas.prototype.getContext;
  Canvas.prototype.getContext = function(...args) { this.gpu = false; return getContext.apply(this, args); };
}
const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const output = process.argv[2], result: Record<string, unknown> = {};
const run = (args: string[]) => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw Error(r.stderr.toString()); return r.stdout;
};
if (output) { mkdirSync(output, { recursive: true }); run(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', join(output, 'signal.wav')]); }
for (const theme of ['minimal', 'kinetic'] as const) for (const vertical of [true, false]) {
  const [width, height] = vertical ? [270, 480] : [480, 270];
  const spec = validateSpec({ video: { width, height, duration: 2, fps: 30, seed: 29 }, style: { theme },
    scenes: [{ start: 0, end: 1, environment: 'theme_stage', cameraMove: 'static', headline: ['观察'] },
      { start: 1, end: 2, environment: 'theme_stage', cameraMove: 'static', transition: 'cut', headline: ['结果'] }],
    audio: { narration: [{ start: .2, text: '短句。', voice: 'female_calm' }, { start: 1.2, text: '结果。', voice: 'female_calm' }], bgm: { volume: 0 } }, captions: { enabled: true, style: 'boxed' } }).spec!;
  const captionCues = [{ index: 0, text: '字'.repeat(13), start: .2, end: .8 }, { index: 1, text: '字'.repeat(20), start: 1.1, end: 1.7 }];
  const renderer = createSpecRenderer({ spec, captionCues }), frames: string[] = [];
  try {
    for (let index = 0; index < 60; index++) frames.push(hash(renderer.renderFrame(makeFrameContext({ frameIndex: index, totalFrames: 60, fps: 30, width: width!, height: height!, seed: 29 })).data));
    const key = theme + '-' + (vertical ? 'vertical' : 'horizontal');
    result[key] = { frames, theme: hash(JSON.stringify(getTheme(theme))), cues: buildCaptionTrack(spec, { measured: new Map([[0, { start: .2, end: .7 }], [1, { start: 1.2, end: 1.8 }]]) }) };
    if (output) {
      const video = join(output, key + '.mp4');
      await renderVideo({ renderer, fps: 30, totalFrames: 60, seed: 29, outPath: video, audioPath: join(output, 'signal.wav'), video: { preset: 'ultrafast', crf: 18 } });
      result[key + '-encoded'] = { frames: hash(run(['-i', video, '-map', '0:v:0', '-f', 'framemd5', '-'])),
        pcm: hash(run(['-i', video, '-map', '0:a:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-'])) };
    }
  } finally { renderer.dispose(); }
}
process.stdout.write(JSON.stringify(result) + '\n');
