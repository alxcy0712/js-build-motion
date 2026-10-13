import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initProject } from '../../src/project/scaffold.ts';
import { loadProject, type ProjectHandle } from '../../src/project/manifest.ts';
import { PROJECT_ROOT } from '../../src/utils/env.ts';

/** 每次生成独立输入，调用方在测试结束后执行 cleanup。 */
export function createFixtureProject(options: { slug?: string; projectsRoot?: string } = {}): ProjectHandle & { cleanup: () => void } {
  const output = join(PROJECT_ROOT, '.research/out');
  mkdirSync(output, { recursive: true });
  const scratch = mkdtempSync(join(output, 'fixture-'));
  const slug = options.slug ?? 'engine-fixture';
  let dir = join(scratch, slug);
  try {
    initProject({ slug, title: '引擎测试夹具', projectsRoot: scratch });
    const specPath = join(dir, 'spec/main.json');
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    spec.video.duration = 8;
    spec.scenes[0].end = 8;
    spec.audio.narration = [{ start: 1, voice: 'female_calm', text: '用于检查音频、字幕和画面的测试旁白。' }];
    spec.audio.sfx = [{ start: 0.5, preset: 'soft_rain', volume: 0.2 }];
    writeFileSync(specPath, JSON.stringify(spec, null, 2));
    const briefPath = join(dir, 'brief.json');
    const brief = JSON.parse(readFileSync(briefPath, 'utf8'));
    brief.intent = '验证八秒竖屏影片的输入、音视频与运行记录。';
    brief.deliverable.duration = 8;
    brief.claims.humanRounds = null;
    writeFileSync(briefPath, JSON.stringify(brief, null, 2));
    if (options.projectsRoot) {
      mkdirSync(options.projectsRoot, { recursive: true });
      const destination = join(options.projectsRoot, slug);
      if (existsSync(destination)) throw new Error(`FIXTURE_EXISTS: ${destination}`);
      renameSync(dir, destination);
      dir = destination;
    }
    return { ...loadProject(dir), cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); } };
  } catch (error) { rmSync(scratch, { recursive: true, force: true }); throw error; }
}
