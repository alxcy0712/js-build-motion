import { lstatSync, realpathSync, readdirSync } from 'node:fs';
import { dirname, basename, resolve, sep } from 'node:path';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';

/** Resolve existing ancestors too, so a not-yet-created file behind a symlink is checked. */
export function physicalPath(path: string): string {
  const abs = resolve(path);
  try { lstatSync(abs); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return resolve(physicalPath(dirname(abs)), basename(abs));
  }
  return realpathSync(abs);
}
export function inside(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}
export function assertContained(root: string, path: string): string {
  const abs = resolve(path);
  if (!inside(resolve(root), abs) || !inside(physicalPath(root), physicalPath(abs))) {
    throw new EngineError(ERROR_CODES.PROJECT_ISOLATION_VIOLATION, '路径必须位于当前项目的指定目录内', {
      details: { root, path }, hint: '使用当前项目内的真实路径，检查软链接目标',
    });
  }
  return abs;
}

/** Output trees must not redirect any generated intermediate file into another location. */
export function assertOutputTree(root: string): void {
  let info;
  try { info = lstatSync(root); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (info.isSymbolicLink()) throw new EngineError(ERROR_CODES.PROJECT_ISOLATION_VIOLATION, '产物目录内禁止软链接', { details: { path: root } });
  if (info.isDirectory()) for (const name of readdirSync(root)) assertOutputTree(resolve(root, name));
}
