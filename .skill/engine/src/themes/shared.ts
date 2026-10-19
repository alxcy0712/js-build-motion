/** 各风格共用的基础 token：字体栈与抖音/小红书安全区。 */
export const CJK_STACK = ['Noto Sans CJK SC'] as const;
/**
 * 主题字体固定使用 engine/assets/fonts 中的原版文件；初始化时随运行时复制。
 * 通用字体查找接口继续支持项目显式指定的候选与系统目录。
 */
export const SYSTEM_FONTS = {
  inter: { family: 'Inter', files: ['Inter-Variable.ttf'], bundled: true },
  interTight: { family: 'Inter Tight', files: ['InterTight-Variable.ttf'], bundled: true },
  geist: { family: 'Geist', files: ['Geist-Variable.ttf', 'Geist-VariableFont_wght.ttf', 'Geist-Regular.ttf', 'SFNS.ttf', 'Helvetica.ttc', 'DejaVuSans.ttf'] },
  geistMono: { family: 'Geist Mono', files: ['GeistMono-Variable.ttf'], bundled: true },
  notoSansSC: { family: 'Noto Sans CJK SC', files: ['NotoSansCJKsc-VF.otf'], bundled: true },
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
