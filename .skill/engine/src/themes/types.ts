import type { ThemeId } from './ids.ts';

export type Orientation = 'vertical' | 'horizontal';
export type Bezier = readonly [number, number, number, number];
export interface SpringParams { readonly stiffness: number; readonly damping: number; readonly mass?: number }
export type TransitionId =
  | 'blurDissolve' | 'riseFade' | 'maskWipeUp' | 'scaleThrough' | 'cutOnBeat'
  | 'whipPan' | 'glitchCut' | 'zoomIntoElement' | 'lineScan' | 'paperFlip' | 'inkBleed';
export type TypeRole = 'hero' | 'display' | 'title' | 'body' | 'caption' | 'micro';

export interface FontFace { readonly family: string; readonly files: readonly string[]; readonly weight?: number; readonly bundled?: boolean }
export interface ThemeFonts {
  /** CSS 风格字体栈，第一项为主字体，后续为 CJK 与兜底 */
  readonly stack: readonly string[];
  readonly mono?: readonly string[];
  /** 待注册的字体文件（相对 engine/assets/fonts 或绝对路径）；第一份存在即可 */
  readonly faces: readonly FontFace[];
  /** 必须能渲染的样张字符，缺字视为回退 */
  readonly probe: string;
}

export interface TextRevealRule {
  readonly opacityEase: Bezier;
  readonly positionSpring: SpringParams;
  readonly rise: number;          // px
  readonly blurFrom: number;      // px
  readonly scaleFrom: number;
  readonly opacityDuration: number;
  readonly exitDuration: number;
  readonly stagger: number;       // s 每行/每词
  readonly unit: 'line' | 'word' | 'char';
  /** 是否允许文字过冲（仅少数风格开启） */
  readonly allowOvershoot: boolean;
  readonly maxOvershoot: number;  // 0–1
  /** 整片第一屏：instant=首帧即清晰（封面帧/信息流首帧），reveal=按规则进场 */
  readonly firstScreen?: 'instant' | 'reveal';
}

/** 防死帧：每个镜头必须持续存在的微运动层。grain 不计为有效运动。 */
export type LivenessLayer = 'drift' | 'parallax' | 'lightSweep' | 'boil' | 'grain';
export interface LivenessRule {
  readonly layers: readonly LivenessLayer[];
  /** 任意窗口内画面无可见变化的最长时间（秒），上限 0.5 */
  readonly maxStillSeconds: number;
  /** 每个 maxStillSeconds 窗口内画面角点的最小位移（1080 宽参考像素） */
  readonly minMotionPx: number;
  readonly parallaxAmplitudePx: number;  // 视差层正弦漂移幅度
  readonly parallaxPeriod: number;       // 秒
  readonly lightSweep?: { readonly period: number; readonly opacity: number };
}

export interface ThemeTokens {
  readonly id: ThemeId;
  readonly name: string;          // 中文名
  readonly summary: string;
  readonly useWhen: string;
  readonly fonts: ThemeFonts;
  readonly palette: Readonly<Record<'bg' | 'surface' | 'text' | 'textSecondary' | 'accent', string>> & Readonly<Record<string, string>>;
  readonly type: Readonly<Record<Orientation, Readonly<Record<TypeRole, number>>>>;
  readonly weight: Readonly<Partial<Record<TypeRole, number>>>;
  readonly tracking: Readonly<Partial<Record<TypeRole, number>>>; // em，CJK 自动按 0 处理
  readonly leading: number;
  readonly maxCharsPerScreen: { readonly cjk: number; readonly latinWords: number };
  readonly durations: Readonly<Record<'micro' | 'enter' | 'exit' | 'transition' | 'holdMin', number>> & Readonly<Record<string, number>>;
  readonly springs: Readonly<Record<'text' | 'layout' | 'accent', SpringParams>> & Readonly<Record<string, SpringParams>>;
  readonly easings: Readonly<Record<'standard' | 'enter' | 'exit' | 'camera', Bezier>> & Readonly<Record<string, Bezier>>;
  readonly transitions: readonly TransitionId[];
  readonly treatments: {
    readonly grain: { readonly opacity: number; readonly fps: number };
    readonly glow: { readonly blur: number; readonly opacity: number; readonly targets: readonly ('accent' | 'text' | 'subject')[] };
    readonly vignette: number;
    readonly depth: { readonly blurFar: number; readonly parallax: readonly number[] };
    readonly motionBlur: { readonly samples: number; readonly shutter: number }; // samples=1 关闭
    readonly drift: { readonly scaleTo: number; readonly seconds: number };
    readonly paper?: 'none' | 'rough' | 'smooth';
  };
  readonly textReveal: TextRevealRule;
  readonly liveness: LivenessRule;
  readonly safeArea: Readonly<Record<Orientation, { readonly top: number; readonly bottom: number; readonly left: number; readonly right: number }>>;
  readonly bpm: number;
}
