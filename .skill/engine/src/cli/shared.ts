import { assertContained } from '../project/paths.ts';
import { join } from 'node:path';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { PROJECT_ROOT } from '../utils/env.ts';
import { listProjectSlugs, type ResolvedTarget } from '../project/manifest.ts';
import { run } from './index.ts';

const RESEARCH_OUT_DIR = join(PROJECT_ROOT, '.research', 'out');
export function outputPath(target: ResolvedTarget, path: string): string {
  return assertContained(baseOutDir(target), path);
}
export function baseOutDir(target: ResolvedTarget): string {
  // 项目 → 项目自己的 outDir；非项目 spec（探针 / 引擎级夹具）→ .research/out/
  // （AGENTS.md 硬性规则 1：产物必须落在本项目目录内；仓库根不放任何产物）
  return target.project ? target.project.outDir : RESEARCH_OUT_DIR;
}

/**
 * 列出音频中间产物及其角色。
 *
 * 这些文件是「配音真的进去了」的唯一直接证据：把它们逐个哈希写进 run.json，
 * 事后才能回答"这一版成片用的是哪段配音"——尤其是当 TTS 是网络服务时。
 */
export function requireTarget(positionals: string[], cmd: string): string {
  const p = positionals[0];
  if (!p) {
    const slugs = listProjectSlugs();
    throw new EngineError(ERROR_CODES.CLI_USAGE, `${cmd} 缺少参数 <spec.json|项目>`, {
      ...(slugs.length ? { allowed: slugs } : {}),
      hint: `用法: node .skill/engine/src/cli/index.ts ${cmd} <项目 slug>  或  node .skill/engine/src/cli/index.ts ${cmd} <spec.json>`,
    });
  }
  return p;
}
