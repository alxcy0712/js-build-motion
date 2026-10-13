/**
 * 生成物（视频、抽帧、预览、缓存）的唯一落盘位置：仓库根目录下的 output/（已加入 .gitignore，永不提交）。
 *
 * 解析顺序：$JBM_OUTPUT_DIR → 从引擎目录向上找到含 .skill/ 的仓库根 → 当前工作目录。
 * 不依赖任何机器专属路径；macOS / Linux / Windows 行为一致。
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PROJECT_ROOT } from './env.ts';

export function findRepoRoot(start: string = PROJECT_ROOT): string | null {
  let d = resolve(start);
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(d, '.skill')) && existsSync(join(d, '.gitignore'))) return d;
    const up = dirname(d); if (up === d) return null; d = up;
  }
  return null;
}
export function outputRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.JBM_OUTPUT_DIR) return resolve(env.JBM_OUTPUT_DIR);
  return join(findRepoRoot() ?? process.cwd(), 'output');
}
/** output/<...parts>，例如 outputPath('theme-smoke')、outputPath('.cache', 'footage') */
export function outputPath(...parts: string[]): string { return join(outputRoot(), ...parts); }
