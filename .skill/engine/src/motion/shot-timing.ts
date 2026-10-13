/**
 * 文字 → 镜头时长：按「观众读完这一屏所需时间」给出最短停留，避免字没读完就切。
 *
 * 模型：入场动画 + 阅读 + 读后停顿。中文按字计（短视频约 6 字/秒），拉丁文按词计（约 3.3 词/秒），
 * 数字串按 1 个词计。
 *
 * 分镜默认（竖屏讲解）：普通讲解屏 2.5–5s；强调大字屏（≤ 6 个字/词，如巨型数字、一句结论）2–3s。
 * 超过上限说明这一屏字太多，应拆镜头，而不是让画面停住。
 */
export interface ReadingRates { readonly cjkPerSecond: number; readonly wordsPerSecond: number }
export const DEFAULT_RATES: ReadingRates = { cjkPerSecond: 6, wordsPerSecond: 3.3 };
export interface ShotTimingOptions {
  /** 文字入场动画时长（秒），通常取风格 durations.enter */
  readonly enter?: number;
  /** 读完后的停顿 */
  readonly settle?: number;
  readonly rates?: ReadingRates;
  readonly min?: number;
  readonly max?: number;
  /** 'auto'（默认）：字数 ≤ EMPHASIS_MAX_UNITS 视为强调大字屏 */
  readonly kind?: 'auto' | 'explainer' | 'emphasis';
}
export const SHOT_LENGTH = { explainer: [2.5, 5], emphasis: [2, 3] } as const;
export const EMPHASIS_MAX_UNITS = 6;
/** 字数单位：中文按字、拉丁文按词 */
export function textUnits(lines: readonly string[]): number {
  const text = lines.join(' ');
  return (text.match(CJK) ?? []).length + text.replace(CJK, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/gu;
/** 单位：秒。只计算阅读本身，不含入场与停顿。 */
export function readingSeconds(lines: readonly string[], rates: ReadingRates = DEFAULT_RATES): number {
  const text = lines.join(' ');
  const cjk = (text.match(CJK) ?? []).length;
  const words = text.replace(CJK, ' ').split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
  return cjk / rates.cjkPerSecond + words / rates.wordsPerSecond;
}
export function minShotSeconds(lines: readonly string[], o: ShotTimingOptions = {}): number {
  const kind = o.kind && o.kind !== 'auto' ? o.kind : textUnits(lines) <= EMPHASIS_MAX_UNITS ? 'emphasis' : 'explainer';
  const [lo, hi] = SHOT_LENGTH[kind];
  const enter = o.enter ?? 0.4, settle = o.settle ?? 0.4, min = o.min ?? lo, max = o.max ?? hi;
  return Math.min(max, Math.max(min, enter + readingSeconds(lines, o.rates) + settle));
}
export interface PlannedShot { readonly start: number; readonly end: number; readonly lines: readonly string[] }
/**
 * 把若干屏文字排成连续时间轴。可选 beat（秒）把每个切点吸附到最近的节拍，但只向后吸附，保证不短于阅读下限。
 */
export function planShotTimings(screens: readonly (readonly string[])[], o: ShotTimingOptions & { readonly start?: number; readonly beat?: number } = {}): PlannedShot[] {
  const out: PlannedShot[] = [];
  let t = o.start ?? 0;
  for (const lines of screens) {
    let end = t + minShotSeconds(lines, o);
    if (o.beat && o.beat > 0) end = Math.ceil(end / o.beat - 1e-9) * o.beat;
    end = Math.round(end * 1000) / 1000;
    out.push({ start: t, end, lines }); t = end;
  }
  return out;
}
