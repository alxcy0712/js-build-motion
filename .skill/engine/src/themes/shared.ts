/** 各风格共用的基础 token：字体栈与抖音/小红书安全区。 */
export const CJK_STACK = ['PingFang SC', 'HarmonyOS Sans SC', 'Noto Sans CJK SC', 'Noto Sans SC'] as const;
/**
 * 字体候选只写「文件名」，不写绝对路径：由 fonts.ts 依次在 engine/assets/fonts（随项目打包，优先）、
 * $JBM_FONT_DIRS、以及当前平台的系统字体目录（macOS / Linux / Windows）中按文件名查找。
 * 顺序即优先级：先开源原版，再各平台系统自带的同类字体（作为别名注册到同一字族名，保证排版代码不变）。
 */
export const SYSTEM_FONTS = {
  inter: { family: 'Inter', files: ['Inter-Variable.ttf', 'InterVariable.ttf', 'Inter-VariableFont_opsz,wght.ttf', 'Inter.ttc', 'Inter-Regular.ttf', 'SFNS.ttf', 'Helvetica.ttc', 'Arial.ttf', 'DejaVuSans.ttf'] },
  interTight: { family: 'Inter Tight', files: ['InterTight-Variable.ttf', 'InterTight-VariableFont_wght.ttf', 'InterTight-Regular.ttf', 'Inter-Variable.ttf', 'SFNS.ttf', 'Helvetica.ttc', 'Arial.ttf', 'DejaVuSans.ttf'] },
  geist: { family: 'Geist', files: ['Geist-Variable.ttf', 'Geist-VariableFont_wght.ttf', 'Geist-Regular.ttf', 'SFNS.ttf', 'Helvetica.ttc', 'DejaVuSans.ttf'] },
  geistMono: { family: 'Geist Mono', files: ['GeistMono-Variable.ttf', 'GeistMono-VariableFont_wght.ttf', 'GeistMono-Regular.ttf', 'SFNSMono.ttf', 'Menlo.ttc', 'DejaVuSansMono.ttf', 'consola.ttf'] },
  notoSansSC: { family: 'Noto Sans CJK SC', files: ['NotoSansSC-Variable.ttf', 'NotoSansSC-VariableFont_wght.ttf', 'NotoSansCJK-Bold.ttc', 'NotoSansCJK-Regular.ttc', 'NotoSansCJKsc-Regular.otf', 'NotoSansSC-Regular.otf', 'PingFang.ttc', 'Hiragino Sans GB.ttc', 'STHeiti Medium.ttc', 'LXGWWenKai-Regular.ttf', 'wqy-microhei.ttc', 'msyh.ttc'] },
  notoSerifSC: { family: 'Noto Serif CJK SC', files: ['NotoSerifSC-Variable.ttf', 'NotoSerifSC-VariableFont_wght.ttf', 'NotoSerifCJK-Bold.ttc', 'NotoSerifCJK-Regular.ttc', 'NotoSerifSC-Regular.otf', 'Songti.ttc', 'STSong.ttf', 'LXGWWenKai-Regular.ttf', 'simsun.ttc'] },
} as const;
export const CJK_PROBE = '电脑拆解人生计算机思维澄记ONEINO0123';
/** 竖屏：顶部状态栏/搜索、底部标题/音乐/评论、右侧互动栏。横屏：通用 title-safe。 */
export const SAFE_AREA = {
  vertical: { top: 220, bottom: 520, left: 72, right: 168 },
  horizontal: { top: 72, bottom: 96, left: 120, right: 120 },
} as const;
