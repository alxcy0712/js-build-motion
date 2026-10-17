/** 风格注册表：spec.style.theme → ThemeTokens。新增风格：写 styles/<id>.ts，加入 ids.ts 与此表，补文档。 */
import { DEFAULT_THEME, THEME_IDS, type ThemeId } from './ids.ts';
import type { ThemeTokens, Orientation } from './types.ts';
import { validateTheme } from './validate.ts';
import { minimal } from './styles/minimal.ts';
import { kinetic } from './styles/kinetic.ts';

export const THEMES: Readonly<Record<ThemeId, ThemeTokens>> = { minimal, kinetic };

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEME_IDS as readonly string[]).includes(v);
}
/** 取风格；未知 ID 抛错（spec 已经过 repair，这里是最后一道防线）。 */
export function getTheme(id: string = DEFAULT_THEME): ThemeTokens {
  if (!isThemeId(id)) throw new Error(`THEME_UNKNOWN: ${id}（可选：${THEME_IDS.join(', ')}）`);
  const theme = THEMES[id];
  const problems = validateTheme(theme);
  if (problems.length) throw new Error(`THEME_INVALID ${id}: ${problems.join('；')}`);
  return theme;
}
export function orientationOf(width: number, height: number): Orientation {
  return height >= width ? 'vertical' : 'horizontal';
}
export function listThemes(): { id: ThemeId; name: string; summary: string; useWhen: string }[] {
  return THEME_IDS.map((id) => ({ id, name: THEMES[id].name, summary: THEMES[id].summary, useWhen: THEMES[id].useWhen }));
}
