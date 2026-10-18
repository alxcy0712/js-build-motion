/**
 * 品牌风格配置：账号默认 + 每片选择。
 *
 * 语义（version 2）
 *   - 核心 `.skill/brand.json` 保存**账号默认风格**（`theme` 与 `defaultTheme` 相同），
 *     更换账号默认时更新该文件并追加 changes 记录，只影响之后的新片。
 *   - 初始化前沿用用户已指定的主题或明确委托，其余情形按创作问答取得选择。start --theme
 *     把选择写进该片根目录的 brand.json 快照：`theme` 是本片生效风格，`defaultTheme`
 *     记录创建时的账号默认，`changes` 末尾记录显式参数；用户原文保存到 prompt-history。
 *   - 校验与渲染使用本片固定快照；spec 里写了与 `theme` 不同的 `style.theme` 时按
 *     enforcement 处理：override 强制改回并警告，reject 直接失败。
 *   - version 1 的旧配置用 `lockedTheme` 表示生效风格，继续可读并归一化为本结构。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DEFAULT_THEME, THEME_IDS, type ThemeId } from './ids.ts';

export interface BrandChange { readonly at: string; readonly theme: ThemeId; readonly reason: string }
export interface BrandConfig {
  readonly version: 1 | 2;
  readonly owner?: string;
  /** 生效风格：核心文件里是账号默认，项目快照里是本片选择。 */
  readonly theme: ThemeId;
  /** 生成该文件时的账号默认风格；version 1 缺省等于 theme。 */
  readonly defaultTheme: ThemeId;
  readonly enforcement: 'override' | 'reject';
  readonly note?: string;
  readonly changes: readonly BrandChange[];
}
export const DEFAULT_BRAND: BrandConfig = { version: 2, theme: DEFAULT_THEME, defaultTheme: DEFAULT_THEME, enforcement: 'override', changes: [] };

const registered = (value: unknown, field: string): ThemeId => {
  if (!(THEME_IDS as readonly string[]).includes(value as string)) throw new Error(`BRAND_INVALID: ${field} ${String(value)} 未登记`);
  return value as ThemeId;
};

export function parseBrand(raw: unknown): BrandConfig {
  const o = raw as (Partial<BrandConfig> & { lockedTheme?: unknown }) | null;
  if (!o || typeof o !== 'object') throw new Error('BRAND_INVALID: 应为对象');
  if (o.version !== 1 && o.version !== 2) throw new Error('BRAND_INVALID: version 须为 1 或 2');
  const theme = registered(o.version === 1 ? o.lockedTheme : o.theme, o.version === 1 ? 'lockedTheme' : 'theme');
  if (o.enforcement !== 'override' && o.enforcement !== 'reject') throw new Error('BRAND_INVALID: enforcement 须为 override|reject');
  const changes = Array.isArray(o.changes) ? o.changes : [];
  const last = changes.at(-1);
  if (last && last.theme !== theme) throw new Error('BRAND_INVALID: theme 与最后一条 changes 记录不一致，风格选择须留记录');
  const defaultTheme = o.version === 1 || o.defaultTheme === undefined ? theme : registered(o.defaultTheme, 'defaultTheme');
  return { version: o.version, owner: o.owner, theme, defaultTheme, enforcement: o.enforcement, ...(o.note !== undefined ? { note: o.note } : {}), changes };
}
/** 默认路径：<.skill>/brand.json；不存在时用 DEFAULT_BRAND（账号默认 minimal）。 */
export function loadBrand(path = join(import.meta.dirname, '..', '..', '..', 'brand.json')): BrandConfig {
  if (!existsSync(path)) return DEFAULT_BRAND;
  return parseBrand(JSON.parse(readFileSync(path, 'utf8')));
}

/** 项目运行时强制读取本片快照；核心 API 由调用方显式传入 brand。 */
export function loadRuntimeBrand(): BrandConfig | undefined {
  const engine = resolve(import.meta.dirname, '../..');
  if (basename(engine) !== '.engine') return undefined;
  return parseBrand(JSON.parse(readFileSync(join(engine, '../brand.json'), 'utf8')));
}

export interface BrandDecision {
  readonly theme: ThemeId;
  readonly violation: null | { readonly requested: string; readonly locked: ThemeId; readonly action: 'override' | 'reject' };
}
/** requested 为 spec 原始输入里显式写的 theme（未写为 undefined，直接取生效风格）。 */
export function enforceBrand(requested: string | undefined, brand: BrandConfig): BrandDecision {
  if (requested === undefined || requested === brand.theme) return { theme: brand.theme, violation: null };
  return { theme: brand.theme, violation: { requested, locked: brand.theme, action: brand.enforcement } };
}
