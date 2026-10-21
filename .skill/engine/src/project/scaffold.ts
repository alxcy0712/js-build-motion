/**
 * 项目骨架生成（task-7 的 `project init`）。
 *
 * 骨架刻意是**可直接渲染**的：一个 3 秒、单场景的最小 spec。
 * 先验证最小渲染闭环，再按本片内容展开制作。
 *
 * 已存在的目录一律不覆盖：`init` 是新建项目的命令，不是重置项目的命令。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { PROJECT_MANIFEST_FILE, PROJECTS_DIR, loadProject } from './manifest.ts';
import { findArchetype, listArchetypes } from './archetypes.ts';
import { PROJECT_SLUG_PATTERN } from './schema.ts';

export interface InitOptions {
  readonly slug: string;
  readonly title?: string;
  readonly archetype?: string;
  /** 项目根目录。默认 `projects/`；测试用它把骨架建在沙盒里，不污染真实项目目录 */
  readonly projectsRoot?: string;
}

export interface InitResult {
  readonly dir: string;
  readonly created: readonly string[];
  readonly archetypeSource: string | null;
}

/** 最小可渲染 spec：3 秒、单场景、无声画分离的复杂度 */
function minimalSpec(): Record<string, unknown> {
  return {
    version: '0.1',
    video: { width: 1080, height: 1920, fps: 24, duration: 3, seed: 20260101 },
    style: { palette: 'warm_night' },
    scenes: [
      {
        id: 'scene_01',
        start: 0,
        end: 3,
        environment: 'theme_stage',
        camera: 'medium_close',
        cameraMove: 'slow_push',
        transition: 'fade',
      },
    ],
    audio: {
      narration: [{ start: 0.6, voice: 'female_calm', text: '这里是项目骨架生成的示例旁白，先改内容，再渲整片。' }],
      bgm: { preset: 'quiet_piano', key: 'C', volume: 0.25, duckUnderNarration: true },
    },
    captions: { enabled: true, style: 'handwritten', mode: 'sentence' },
  };
}

function minimalBrief(slug: string, title: string, archetype: string): Record<string, unknown> {
  return {
    version: '0.1',
    archetype,
    intent: `（把提示词原文粘到这里，不要改写）为 ${title} 做一支 3 秒的竖屏短片。`,
    audience: '（写给谁看）',
    deliverable: { duration: 3, aspect: '9:16', fps: 24, captions: 'inside_frame' },
    assets: [],
    tools: {
      allowed: ['skia-canvas', 'edge-tts', 'doubao-tts', 'procedural-bgm', 'procedural-sfx', 'ffmpeg', 'ffprobe'],
      forbidden: [],
    },
    claims: {
      humanRounds: 1,
      pureCode: true,
      zeroExternalAssets: true,
      humanRevision: false,
    },
    acceptance: ['画面无文字溢出', '字幕与配音对齐', '产出声画齐全的 MP4', '主体状态与镜头接力清楚', '全片构图与节奏完成动态审片'],
    notes: `骨架由 \`node .skill/engine/src/cli/index.ts project init ${slug}\` 生成。按 .skill/references/direction.md 完成动态粗剪与重点样片，再精修和验收目标时长的全片。`,
  };
}

function notesTemplate(title: string, archetype: string): string {
  return `# ${title}

## 原始意图

用户原文由制作入口保存，交付要求与声明登记 brief.json。

## 输入与参考用途

记录本片输入的来源、授权、事实依据及采用范围。用户提供的文字、图像和视频按本片要求处理；其他项目保持输入隔离。

## 主体设计与镜头依据

记录本片的构图、动作、叙事目的及重要默认值。同片跨镜头保持主体一致。

## 待解决问题

记录时间点、问题、修正与复核；审查缺口保留 pending。

## 契约原型

\`${archetype}\`，字段与工具状态以本片固定运行时为准。
`;
}

export function initProject(options: InitOptions): InitResult {
  const { slug } = options;

  if (!new RegExp(PROJECT_SLUG_PATTERN).test(slug)) {
    throw new EngineError(ERROR_CODES.CLI_USAGE, `项目 slug 不合法: "${slug}"`, {
      details: { pattern: PROJECT_SLUG_PATTERN },
      hint: '用小写字母、数字和连字符，例如 my-film-2026',
    });
  }

  const dir = join(options.projectsRoot ?? PROJECTS_DIR, slug);
  if (existsSync(dir)) {
    throw new EngineError(ERROR_CODES.PROJECT_INVALID, `项目目录已存在，拒绝覆盖: ${slug}`, {
      details: { dir },
      hint: 'init 只用于新建；要改现有项目请直接编辑它的 project.json 与 brief.json',
    });
  }

  const archetype = options.archetype ?? 'code-animation-no-assets';
  const available = listArchetypes();
  if (available.length > 0 && !findArchetype(archetype)) {
    throw new EngineError(ERROR_CODES.PROJECT_INVALID, `找不到提示词原型: ${archetype}`, {
      allowed: available.map((a) => a.id),
      hint: '运行 `node .skill/engine/src/cli/index.ts project archetypes` 查看可用原型',
    });
  }

  const title = options.title ?? slug;
  const created: string[] = [];

  mkdirSync(join(dir, 'spec'), { recursive: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });

  const write = (rel: string, content: string): void => {
    writeFileSync(join(dir, rel), content, 'utf8');
    created.push(rel);
  };

  write(
    PROJECT_MANIFEST_FILE,
    JSON.stringify(
      {
        version: '0.1',
        slug,
        title,
        summary: '（一句话介绍这支影片）',
        status: 'draft',
        entry: 'spec/main.json',
        brief: 'brief.json',
        outDir: 'out',
        tags: [],
        archetype,
      },
      null,
      2,
    ) + '\n',
  );

  write('brief.json', JSON.stringify(minimalBrief(slug, title, archetype), null, 2) + '\n');
  write('spec/main.json', JSON.stringify(minimalSpec(), null, 2) + '\n');
  write('NOTES.md', notesTemplate(title, archetype));
  write('out/.gitkeep', '');

  // 立刻自检一次：骨架必须能被引擎解析，否则 init 就是在生产坏项目
  loadProject(dir);

  const source = findArchetype(archetype);
  return { dir, created, archetypeSource: source?.path ?? null };
}

export { PROJECTS_DIR };
