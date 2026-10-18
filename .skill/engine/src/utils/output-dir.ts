/** 固定运行时的辅助工具沿用本片 manifest.outDir；核心探针使用独立的临时输出区。 */
import { basename, dirname, join, resolve } from 'node:path';
import { loadProject } from '../project/manifest.ts';
import { PROJECT_ROOT } from './env.ts';

export function outputRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (basename(PROJECT_ROOT) === '.engine') return loadProject(dirname(PROJECT_ROOT)).outDir;
  return env.JBM_OUTPUT_DIR ? resolve(env.JBM_OUTPUT_DIR) : join(PROJECT_ROOT, '.research/out');
}
/** 本片输出区下的预览、样片或素材帧缓存。 */
export function outputPath(...parts: string[]): string { return join(outputRoot(), ...parts); }
