/** 可选风格（主题）ID。引擎只认 ID，具体 token 在 themes/styles/<id>.ts。 */
export const THEME_IDS = ['minimal', 'kinetic'] as const;
export type ThemeId = (typeof THEME_IDS)[number];
export const DEFAULT_THEME: ThemeId = 'minimal';
