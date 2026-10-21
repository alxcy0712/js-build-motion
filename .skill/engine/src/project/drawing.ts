import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { FrameContext } from '../renderer/renderer.ts';
import type { SceneRenderContext } from '../drawing/scenes/registry.ts';
import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { sha256File } from '../utils/hash.ts';
import { assertContained } from './paths.ts';
import { resolveInsideProject, type ProjectHandle } from './manifest.ts';
import type { AssetPort } from '../ports/assets.ts';

export type ProjectSceneDrawer = (context: SceneRenderContext, frame: FrameContext) => void;
export interface SourceHash { readonly path: string; readonly sha256: string }

/** 本片代码使用独立文件；链接会让局部编辑改变其他工程。 */
export function projectSourceHashes(dir: string): SourceHash[] {
  const files: SourceHash[] = [];
  const visit = (path: string): void => {
    assertContained(dir, path);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1)) {
      throw new EngineError(ERROR_CODES.PROJECT_ISOLATION_VIOLATION, '本片源码必须使用独立文件副本', { details: { path } });
    }
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else if (stat.isFile()) files.push({ path: relative(dir, path), sha256: sha256File(path) });
  };
  const src = join(dir, 'src');
  if (existsSync(src)) visit(src);
  return files;
}

export async function loadProjectDrawing(project: ProjectHandle | null, assets?: AssetPort): Promise<ProjectSceneDrawer | undefined> {
  if (!project?.manifest.drawing) return undefined;
  projectSourceHashes(project.dir);
  const entry = resolveInsideProject(project.dir, project.manifest.drawing, 'drawing');
  assertContained(join(project.dir, 'src'), entry);
  const module = await import(pathToFileURL(entry).href) as { drawScene?: ProjectSceneDrawer; prepareDrawing?: (context: { assets: AssetPort }) => Promise<ProjectSceneDrawer> };
  const drawing = module.prepareDrawing ? (assets ? await module.prepareDrawing({ assets }) : (() => { throw Error('ASSET_PREPARATION_REQUIRED: use the project render entry'); })()) : module.drawScene;
  if (typeof drawing !== 'function' || drawing.constructor.name === 'AsyncFunction') {
    throw new EngineError(ERROR_CODES.PROJECT_INVALID, '本片绘制模块须导出同步函数 drawScene(context, frame)');
  }
  return (context, frame) => { const result = drawing(context, frame) as unknown;
    if (result && typeof (result as { then?: unknown }).then === 'function') throw Error('DRAWING_ASYNC_FRAME_REJECTED'); };
}
