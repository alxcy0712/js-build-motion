/** 可选的 brief 契约原型加载层；校验使用同一 brief schema。 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { EngineError, ERROR_CODES } from '../utils/errors.ts';
import { PROJECT_ROOT } from '../utils/env.ts';

export const ARCHETYPES_DIR = join(PROJECT_ROOT, 'prompts', 'archetypes');
export const ARCHETYPE_SUFFIX = '.brief.json';

export interface ArchetypeInfo {
  readonly id: string;
  readonly path: string;
  /** 人类可读说明：直接取模板的 intent（原型的 intent 就是它的用途） */
  readonly title: string;
}

/** 原型库是否已建立（未建立时 archetype 校验会降级为警告而不是失败） */
export function archetypesDirExists(): boolean {
  return existsSync(ARCHETYPES_DIR);
}

export function listArchetypes(): ArchetypeInfo[] {
  if (!archetypesDirExists()) return [];
  return readdirSync(ARCHETYPES_DIR)
    .filter((f) => f.endsWith(ARCHETYPE_SUFFIX))
    .sort()
    .map((file) => {
      const path = join(ARCHETYPES_DIR, file);
      const id = basename(file, ARCHETYPE_SUFFIX);
      let title = id;
      try {
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        if (typeof raw['intent'] === 'string') title = raw['intent'];
      } catch {
        // 原型模板暂时不可解析不是致命问题：调用方会用 id 作说明，
        // 真正的语法错误会在 brief validate 时以 BRIEF_INVALID 暴露。
      }
      return { id, path, title };
    });
}

export function archetypeIds(): string[] {
  return listArchetypes().map((a) => a.id);
}

export function findArchetype(id: string): ArchetypeInfo | undefined {
  return listArchetypes().find((a) => a.id === id);
}

/** 读取原型模板（未做 schema 校验，调用方负责） */
export function readArchetype(id: string): Record<string, unknown> {
  const info = findArchetype(id);
  if (!info) {
    const allowed = archetypeIds();
    throw new EngineError(ERROR_CODES.PROJECT_NOT_FOUND, `找不到提示词原型: ${id}`, {
      details: { lookedIn: ARCHETYPES_DIR },
      ...(allowed.length ? { allowed } : {}),
      hint: '运行 `node .skill/engine/src/cli/index.ts project archetypes` 查看可用原型',
    });
  }
  try {
    return JSON.parse(readFileSync(info.path, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    throw new EngineError(ERROR_CODES.BRIEF_INVALID, `原型模板不是合法 JSON: ${info.path}`, {
      cause: err,
    });
  }
}
