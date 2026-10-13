/**
 * 品牌锁：保证个人 IP 全部影片使用同一风格。
 * 品牌配置位于 .skill/brand.json；单片 spec 不能自行更换 theme，换风格须改 brand.json（品牌级变更）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_THEME, THEME_IDS, type ThemeId } from './ids.ts';

export interface BrandChange { readonly at: string; readonly theme: ThemeId; readonly reason: string }
export interface BrandConfig {
  readonly version: 1;
  readonly owner?: string;
  readonly lockedTheme: ThemeId;
  readonly enforcement: 'override' | 'reject';
  readonly changes: readonly BrandChange[];
}
export const DEFAULT_BRAND: BrandConfig = { version: 1, lockedTheme: DEFAULT_THEME, enforcement: 'override', changes: [] };

export function parseBrand(raw: unknown): BrandConfig {
  const o = raw as Partial<BrandConfig> | null;
  if (!o || typeof o !== 'object') throw new Error('BRAND_INVALID: 应为对象');
  if (o.version !== 1) throw new Error('BRAND_INVALID: version 须为 1');
  if (!(THEME_IDS as readonly string[]).includes(o.lockedTheme as string)) throw new Error(`BRAND_INVALID: lockedTheme ${String(o.lockedTheme)} 未登记`);
  if (o.enforcement !== 'override' && o.enforcement !== 'reject') throw new Error('BRAND_INVALID: enforcement 须为 override|reject');
  const changes = Array.isArray(o.changes) ? o.changes : [];
  const last = changes.at(-1);
  if (last && last.theme !== o.lockedTheme) throw new Error('BRAND_INVALID: lockedTheme 与最后一条 changes 记录不一致，品牌变更须留记录');
  return { version: 1, owner: o.owner, lockedTheme: o.lockedTheme as ThemeId, enforcement: o.enforcement, changes };
}
/** 默认路径：<.skill>/brand.json；不存在时用 DEFAULT_BRAND（锁 minimal）。 */
export function loadBrand(path = join(import.meta.dirname, '..', '..', '..', 'brand.json')): BrandConfig {
  if (!existsSync(path)) return DEFAULT_BRAND;
  return parseBrand(JSON.parse(readFileSync(path, 'utf8')));
}

export interface BrandDecision {
  readonly theme: ThemeId;
  readonly violation: null | { readonly requested: string; readonly locked: ThemeId; readonly action: 'override' | 'reject' };
}
/** requested 为 spec 原始输入里显式写的 theme（未写为 undefined，直接取锁定值）。 */
export function enforceBrand(requested: string | undefined, brand: BrandConfig): BrandDecision {
  if (requested === undefined || requested === brand.lockedTheme) return { theme: brand.lockedTheme, violation: null };
  return { theme: brand.lockedTheme, violation: { requested, locked: brand.lockedTheme, action: brand.enforcement } };
}
