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
} as const;
export const CJK_PROBE = '电脑拆解人生计算机思维澄记ONEINO0123';
/** 竖屏：顶部状态栏/搜索、底部标题/音乐/评论、右侧互动栏。横屏：通用 title-safe。 */
export const SAFE_AREA = {
  vertical: { top: 220, bottom: 520, left: 72, right: 168 },
  horizontal: { top: 72, bottom: 96, left: 120, right: 120 },
} as const;
/**
 * 竖屏 9:16 口播短视频的默认版面（1080×1920 像素，其他尺寸按高度等比换算）。
 * 字幕允许低于非字幕安全区（底 520）：默认外框中轴线位于 77.5% 屏高，几何由 captions/render.ts 计算；
 * 屏幕大字基线约 1330，且大字下沿与字幕上沿至少相隔 128；主视觉中心约 y=1000。
 */
export const VERTICAL_SHORT_LAYOUT = {
  canvas: [1080, 1920],
  bigTextBaseline: 1330,
  bigTextSubtitleGap: 128,
  visualCenterY: 1000,
  safe: SAFE_AREA.vertical,
} as const;
/**
 * 屏幕大字基线：取默认基线与「字幕上沿 − 间距 − 大字下伸」中较高（更小）者。
 * subtitleTop、bigDescent 用实测字形（measureText 的 actualBoundingBox）；
 * 有推镜或弹跳时把最大放大造成的下移也计入 extraDrop。
 */
export function bigTextBaselineFor(subtitleTop: number, bigDescent: number, extraDrop = 0, layout = VERTICAL_SHORT_LAYOUT): number {
  return Math.min(layout.bigTextBaseline, Math.round(subtitleTop - layout.bigTextSubtitleGap - bigDescent - extraDrop));
}
